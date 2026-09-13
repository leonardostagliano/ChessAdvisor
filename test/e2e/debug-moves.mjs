// Diagnostic: trace SessionState while making moves through the board (fake Codex).
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const repo = resolve(import.meta.dirname, '..', '..')
const appData = mkdtempSync(join(tmpdir(), 'chessadvisor-dbg-'))
const env = { ...process.env, CHESSADVISOR_USER_DATA: appData, CHESSADVISOR_FAKE_CODEX: '1' }
const app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: repo, env, timeout: 60000 })
app.process().stdout?.on('data', (d) => process.stdout.write('[main] ' + d))
app.process().stderr?.on('data', (d) => process.stdout.write('[main:err] ' + d))
const page = await app.firstWindow({ timeout: 60000 })
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('font')) console.log('[renderer]', m.text().slice(0, 200)) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const snap = async (tag) => {
  const s = await page.evaluate(() => window.api.game.state())
  console.log(`${tag}: status=${s.status} id=${s.game?.id?.slice(0, 8)} moves=${s.game?.moves?.length} last=${s.game?.moves?.at(-1)?.san}/${s.game?.moves?.at(-1)?.by} userToMove=${s.userToMove} thinking=${s.ai.thinking} legal=${s.legal.length} err=${s.error}`)
  return s
}
try {
  await page.waitForFunction(async () => (await window.api.codex.state()).status === 'ready', null, { timeout: 120000 })
  await page.getByRole('button', { name: /Nuova partita/ }).first().click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('button', { name: /Inizia partita/ }).click()
  await page.locator('cg-board').first().waitFor({ timeout: 60000 })
  await snap('after start')
  const board = page.locator('cg-board').first()
  const clickSquare = async (sq) => {
    const b = await board.boundingBox()
    const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]) - 1
    const size = b.width / 8
    await page.mouse.click(b.x + file * size + size / 2, b.y + (7 - rank) * size + size / 2)
  }
  const games0 = await page.evaluate(() => window.api.games.list()); console.log('games right after start:', games0.length)
  const dom = () => page.evaluate(() => ({ selected: document.querySelectorAll('cg-board square.selected').length, dests: document.querySelectorAll('cg-board square.move-dest').length, viewOnly: document.querySelector('.cg-wrap')?.classList.contains('view-only') ?? null }))
  const squareCenter = async (sq) => {
    const b = await board.boundingBox()
    const file = sq.charCodeAt(0) - 97, rank = Number(sq[1]) - 1
    const size = b.width / 8
    return { x: b.x + file * size + size / 2, y: b.y + (7 - rank) * size + size / 2 }
  }
  const dragMove = async (from, to) => {
    const a = await squareCenter(from), z = await squareCenter(to)
    await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move((a.x + z.x) / 2, (a.y + z.y) / 2, { steps: 4 }); await page.mouse.move(z.x, z.y, { steps: 4 }); await page.mouse.up()
  }
  const mode = process.argv.includes('--drag') ? 'drag' : 'click'
  if (mode === 'click') {
    const rects = () => page.evaluate(() => { const r = (el) => { const b = el?.getBoundingClientRect(); return b ? [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)] : null }; return { wrap: r(document.querySelector('.cg-wrap')), board: r(document.querySelector('cg-board')), wrapClass: document.querySelector('.cg-wrap')?.className, piece: document.querySelector('cg-board piece')?.getAttribute('style') } })
    console.log('rects before first click:', JSON.stringify(await rects()))
    for (let attempt = 1; attempt <= 3; attempt++) {
      const c = await squareCenter('e2'); console.log(`attempt ${attempt}: click e2 at`, Math.round(c.x), Math.round(c.y))
      await page.mouse.click(c.x, c.y); await sleep(150)
      const d = await dom(); console.log(`attempt ${attempt}: dom`, JSON.stringify(d), 'rects', JSON.stringify(await rects()))
      if (d.selected) { await page.mouse.click(c.x, c.y); await sleep(150); console.log('deselected:', JSON.stringify(await dom())); break }
      await sleep(700)
    }
  }
  const plan = mode === 'drag' ? [['e2', 'e4'], ['d2', 'd4'], ['g1', 'f3'], ['b1', 'c3'], ['c1', 'f4'], ['e1', 'e2']] : [['e2', 'e4'], ['d2', 'd4'], ['g1', 'f3']]
  for (const [from, to] of plan) {
    const cur = await page.evaluate(() => window.api.game.state())
    if (!cur.legal.some((m) => m.uci === from + to)) { console.log(`--- skip ${from}->${to} (illegal now)`); continue }
    console.log(`--- ${mode} ${from}->${to}`)
    if (mode === 'drag') { await dragMove(from, to); await sleep(50); console.log('dom after drag:', JSON.stringify(await dom())) }
    else { await clickSquare(from); await sleep(200); await snap('after first click'); console.log('dom after first click:', JSON.stringify(await dom())); await clickSquare(to); await sleep(50); console.log('dom after second click:', JSON.stringify(await dom())) }
    for (let i = 0; i < 12; i++) { await sleep(250); const s = await snap(`t+${(i + 1) * 250}ms`); if (s.userToMove && s.game.moves.length % 2 === 0 && i > 1) break }
  }
  console.log('--- takeback'); await page.getByRole('button', { name: /Annulla mossa/ }).click(); await sleep(800); await snap('after takeback')
  console.log('--- save & exit'); await page.getByRole('button', { name: /Salva ed esci/ }).click(); await sleep(800); await snap('after close')
  const list = await page.evaluate(() => window.api.games.list()); console.log('archive:', JSON.stringify(list.map((g) => ({ id: g.id.slice(0, 8), status: g.status, plies: g.plies }))))
  console.log('--- resume via API'); const r = await page.evaluate((id) => window.api.game.resume(id).then((s) => ({ ok: true, s }), (e) => ({ ok: false, e: String(e) })), list[0].id); console.log('resume result:', r.ok ? `status=${r.s.status} moves=${r.s.game?.moves?.length}` : r.e)
  await sleep(1000); await snap('after resume')
} catch (e) { console.log('EXC', String(e).slice(0, 500)) } finally {
  const pid = app.process().pid; await app.close().catch(() => {}); await sleep(1000)
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); rmSync(appData, { recursive: true, force: true })
}
