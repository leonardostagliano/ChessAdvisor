// End-to-end drive of the built app with Playwright for Electron.
// Usage:  node test/e2e/play.e2e.mjs            (fake Codex app-server, no quota)
//         node test/e2e/play.e2e.mjs --real     (real Codex: ONE short game, cheapest model/effort)
// Requires `npm run build` first. Data goes to a temporary APPDATA, never to the user's profile.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const REAL = process.argv.includes('--real')
const KEEP = process.argv.includes('--keep')
const repo = resolve(import.meta.dirname, '..', '..')
const shots = join(repo, 'test', 'e2e', 'shots', REAL ? 'real' : 'fake')
mkdirSync(shots, { recursive: true })
const appData = mkdtempSync(join(tmpdir(), 'chessadvisor-e2e-'))
const results = []
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Electron ignores APPDATA on Windows: the main process honours this override instead (paths.ts).
const env = { ...process.env, CHESSADVISOR_USER_DATA: appData }
if (!REAL) env.CHESSADVISOR_FAKE_CODEX = '1'
else delete env.CHESSADVISOR_FAKE_CODEX

const app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: repo, env, timeout: 60000 })
const page = await app.firstWindow({ timeout: 60000 })
page.setDefaultTimeout(30000)
page.on('console', (m) => { if (m.type() === 'error') console.log('[renderer error]', m.text().slice(0, 300)) })
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))

const api = (fn, ...args) => page.evaluate(([code, a]) => new Function('args', `return (${code})(...args)`)(a), [fn.toString(), args])
const state = () => api(() => window.api.game.state())
const plies = async () => (await state()).game?.moves?.length ?? 0
const shot = (name) => page.screenshot({ path: join(shots, name), fullPage: false })
// Node-side polling: Playwright's waitForFunction does not await async predicates, and every
// condition here goes through the IPC bridge.
const until = async (fn, timeout, label = 'condition') => {
  const deadline = Date.now() + timeout
  for (;;) {
    let value = null
    try { value = await fn() } catch { /* transient */ }
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await sleep(200)
  }
}

try {
  // 1. Codex becomes ready (status screen disappears) and the shell is visible
  await page.waitForFunction(() => document.querySelector('nav[aria-label]') !== null, null, { timeout: 60000 })
  const codexReady = await until(async () => (await api(() => window.api.codex.state())).status === 'ready', 120000, 'codex ready').then(() => true).catch(() => false)
  ok('codex ready', codexReady, JSON.stringify(await api(() => window.api.codex.state())).slice(0, 120))
  await until(async () => { const e = await api(() => window.api.engine.state()); return e.available || e.binary === 'none' }, 30000, 'engine probe').catch(() => {})
  const engineState = await api(() => window.api.engine.state())
  ok('engine available', engineState.available, `${engineState.binary} ${engineState.version ?? ''}`)
  const version = await api(() => window.api.app.versionInfo())
  const pill = await page.getByTestId('rail-version').textContent().catch(() => null)
  ok('rail version pill', !!pill && pill.includes(version.version), `pill="${pill}" version=${version.version}`)
  await sleep(500)
  await shot('01-home.png')

  // 2. New game dialog
  await page.getByRole('button', { name: /Nuova partita/ }).first().click()
  await page.getByRole('dialog').waitFor()
  const difficulty = page.getByRole('radio', { name: /Medio/ })
  if (await difficulty.count()) await difficulty.first().click()
  if (REAL) {
    // Cheapest real configuration: the dialog preselects the saved defaults, so set them first.
    await page.getByRole('button', { name: /Annulla/ }).click().catch(() => {})
    await api(() => window.api.settings.save({ defaultModel: 'gpt-5.5', defaultEffort: 'low' }))
    await page.getByRole('button', { name: /Nuova partita/ }).first().click()
    await page.getByRole('dialog').waitFor()
    if (await difficulty.count()) await difficulty.first().click()
    const chosen = await page.getByRole('dialog').textContent()
    ok('dialog preselects gpt-5.5 / Basso', /GPT-5\.5/.test(chosen ?? '') && /Basso/.test(chosen ?? ''), (chosen ?? '').replace(/\s+/g, ' ').slice(0, 160))
  }
  await shot('02-new-game.png')
  await page.getByRole('button', { name: /Inizia partita/ }).click()
  await page.locator('cg-board').first().waitFor({ timeout: 60000 })
  await sleep(400) // let the first paint and the initial live eval settle, as a person would
  const s0 = await state()
  ok('game started', s0.status === 'playing' && !!s0.game, `color=${s0.game?.userColor} difficulty=${JSON.stringify(s0.game?.opponent?.difficulty)} model=${s0.game?.opponent?.model}`)

  // 3. Make moves through the real board (click origin, click destination)
  const board = page.locator('cg-board').first()
  const orientationWhite = s0.game.userColor === 'w'
  const clickSquare = async (sq) => {
    const b = await board.boundingBox()
    const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]) - 1
    const size = b.width / 8
    const x = b.x + (orientationWhite ? file : 7 - file) * size + size / 2
    const y = b.y + (orientationWhite ? 7 - rank : rank) * size + size / 2
    await page.mouse.click(x, y)
  }
  const aiTimeout = REAL ? 240000 : 30000
  const waitForUserTurn = (expectPlies) => until(async () => { const s = await state(); return s.status !== 'playing' || (s.userToMove && !s.ai.thinking && (s.game?.moves?.length ?? 0) >= expectPlies) }, aiTimeout, `user turn at ${expectPlies} plies`)

  // wait for our turn (as Black the AI moves first)
  await waitForUserTurn(orientationWhite ? 0 : 1)
  const userMoves = REAL ? 3 : 6
  let played = 0
  for (let i = 0; i < userMoves; i++) {
    const s = await state()
    if (s.status !== 'playing') break
    const pref = ['e2e4', 'd2d4', 'g1f3', 'b1c3', 'e7e5', 'd7d5', 'g8f6', 'b8c6']
    const legal = s.legal.map((m) => m.uci)
    const uci = pref.find((m) => legal.includes(m)) ?? legal[Math.floor(Math.random() * legal.length)]
    const before = s.game.moves.length
    // alternate the two real input methods: click-click and drag-and-drop
    if (i % 2 === 0) { await clickSquare(uci.slice(0, 2)); await sleep(150); await clickSquare(uci.slice(2, 4)) }
    else {
      const b = await board.boundingBox(); const size = b.width / 8
      const c = (sq) => { const f = sq.charCodeAt(0) - 97, r = Number(sq[1]) - 1; return { x: b.x + (orientationWhite ? f : 7 - f) * size + size / 2, y: b.y + (orientationWhite ? 7 - r : r) * size + size / 2 } }
      const a = c(uci.slice(0, 2)), z = c(uci.slice(2, 4))
      await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + z.x) / 2, (a.y + z.y) / 2, { steps: 4 }); await page.mouse.move(z.x, z.y, { steps: 4 }); await page.mouse.up()
    }
    const applied = await until(async () => (await plies()) > before, 15000, 'move applied').then(() => true).catch(() => false)
    if (!applied) { ok(`user move ${i + 1} (${uci}) applied via board (${i % 2 === 0 ? 'click' : 'drag'})`, false); break }
    played++
    if (i === 0) await shot('03-thinking.png').catch(() => {})
    await waitForUserTurn(before + 2)
    const after = await state()
    const aiMove = after.game.moves[after.game.moves.length - 1]
    ok(`move ${i + 1}: ${uci} → AI ${aiMove?.san}`, aiMove?.by === 'ai' && after.game.moves.length === before + 2, `fallback=${aiMove?.fallback ?? 'none'} thinkingMs=${aiMove?.thinkingMs} comment=${(aiMove?.aiShortComment ?? '').slice(0, 60)}`)
  }
  ok('played moves through the board', played === userMoves, `${played}/${userMoves}`)
  await page.evaluate(() => { document.documentElement.dataset.theme = 'night' }); await sleep(400); await shot('04-play-night.png')
  await page.evaluate(() => { document.documentElement.dataset.theme = 'editorial' }); await sleep(400); await shot('05-play-editorial.png')
  await page.evaluate(() => { document.documentElement.dataset.theme = 'night' })

  // 4. Takeback (two plies)
  const beforeTb = await plies()
  await page.getByRole('button', { name: /Annulla mossa/ }).click()
  await until(async () => (await plies()) < beforeTb, 15000, 'takeback')
  const afterTb = await state()
  ok('takeback removed the last exchange', afterTb.game.moves.length === beforeTb - 2 && afterTb.game.takebacks === 1 && afterTb.userToMove, `${beforeTb} → ${afterTb.game.moves.length}`)

  // 5. Save & exit, archive, resume
  const gameId = afterTb.game.id
  await page.getByRole('button', { name: /Salva ed esci/ }).click()
  await until(async () => (await state()).status === 'idle', 15000, 'session idle')
  const archived = await api(() => window.api.games.list())
  ok('archive lists the saved game as in progress', archived.some((g) => g.id === gameId && g.status === 'in_progress'), `${archived.length} games`)
  await page.getByRole('button', { name: /^Partite$/ }).first().click().catch(() => {})
  await sleep(500); await shot('06-archive.png')
  await page.getByRole('button', { name: /Riprendi/ }).first().click()
  await until(async () => { const s = await state(); return s.status === 'playing' && s.game?.id === gameId }, aiTimeout, 'resume')
  const resumed = await state()
  ok('resume restores the game', resumed.game?.id === gameId && resumed.game.moves.length >= afterTb.game.moves.length, `plies=${resumed.game?.moves?.length}`)

  // 6. Resign → result banner
  await waitForUserTurn(resumed.game.moves.length)
  await page.getByRole('button', { name: /Abbandona/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: /Conferma|Abbandona/ }).last().click()
  await until(async () => (await state()).status === 'finished', 15000, 'finished')
  const fin = await state()
  ok('resign finishes the game', fin.game?.result?.reason === 'resign', JSON.stringify(fin.game?.result))
  await sleep(400); await shot('07-result.png')

  // 7. Settings
  await page.getByRole('link', { name: /Impostazioni/ }).or(page.getByRole('button', { name: /Impostazioni/ })).first().click()
  await sleep(600); await shot('08-settings.png')
  const quota = await api(() => window.api.codex.quota())
  ok('quota readable', quota === null || typeof quota.ordinaryUsageAllowed === 'boolean', JSON.stringify(quota)?.slice(0, 100))
} catch (e) {
  ok('script completed without exception', false, String(e).slice(0, 400))
  await shot('99-failure.png').catch(() => {})
} finally {
  const pid = app.process().pid
  await app.close().catch(() => {})
  await sleep(1500)
  // The window hides to tray on close; make sure nothing of ours survives.
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  const summary = { real: REAL, appData, passed: results.filter((r) => r.pass).length, failed: results.filter((r) => !r.pass).length, results }
  writeFileSync(join(shots, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(`\n${summary.passed} passed, ${summary.failed} failed. Screenshots in ${shots}`)
  if (!KEEP && existsSync(appData)) rmSync(appData, { recursive: true, force: true })
  process.exit(summary.failed ? 1 : 0)
}
