// Visual check of the promotion picker and of the hint ring: starts a game from a promotion
// position through the bridge, drags e7→e8, screenshots the picker, chooses the rook.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const repo = resolve(import.meta.dirname, '..', '..')
const shots = join(repo, 'test', 'e2e', 'shots', 'fake')
mkdirSync(shots, { recursive: true })
const appData = mkdtempSync(join(tmpdir(), 'chessadvisor-promo-'))
const env = { ...process.env, CHESSADVISOR_USER_DATA: appData, CHESSADVISOR_FAKE_CODEX: '1' }
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.'],
  cwd: repo,
  env,
  timeout: 60000
})
const page = await app.firstWindow({ timeout: 60000 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const until = async (fn, timeout, label) => {
  const t = Date.now() + timeout
  for (;;) {
    let v = null
    try {
      v = await fn()
    } catch {}
    if (v) return v
    if (Date.now() > t) throw new Error('timeout ' + label)
    await sleep(200)
  }
}
const state = () => page.evaluate(() => window.api.game.state())
try {
  await until(
    async () => (await page.evaluate(() => window.api.codex.state())).status === 'ready',
    120000,
    'codex'
  )
  const s = await page.evaluate(() =>
    window.api.game.new({
      userColor: 'w',
      model: 'gpt-6-astra',
      effort: 'medium',
      difficulty: { mode: 'fixed', level: 6 },
      coach: { model: 'gpt-6-astra', effort: 'medium' },
      language: 'it',
      showReasoning: false,
      commentsVisible: false,
      startFen: '8/4P3/8/8/8/8/8/K6k w - - 0 1',
      kind: 'endgame_drill'
    })
  )
  console.log('game:', s.status, s.fen)
  await page.locator('cg-board').first().waitFor({ timeout: 30000 })
  await sleep(500)
  const board = page.locator('cg-board').first()
  const b = await board.boundingBox()
  const size = b.width / 8
  const c = (sq) => ({
    x: b.x + (sq.charCodeAt(0) - 97) * size + size / 2,
    y: b.y + (7 - (Number(sq[1]) - 1)) * size + size / 2
  })
  const a = c('e7'),
    z = c('e8')
  await page.mouse.move(a.x, a.y)
  await page.mouse.down()
  await page.mouse.move((a.x + z.x) / 2, (a.y + z.y) / 2, { steps: 4 })
  await page.mouse.move(z.x, z.y, { steps: 4 })
  await page.mouse.up()
  await sleep(300)
  const picker = await page.getByTestId('promotion-picker').count()
  console.log(
    'picker visible:',
    picker === 1,
    '| moves before choice:',
    (await state()).game.moves.length
  )
  await page.screenshot({ path: join(shots, '11-promotion.png') })
  await page.getByRole('button', { name: 'Torre' }).click()
  await until(async () => (await state()).game.moves.length >= 1, 10000, 'promotion move')
  const after = await state()
  console.log('move applied:', after.game.moves[0].uci, after.game.moves[0].san)
  // hint ring + arrow after the AI reply
  await until(
    async () => {
      const st = await state()
      return st.userToMove || st.status !== 'playing'
    },
    30000,
    'ai reply'
  )
  if ((await state()).status === 'playing') {
    await page.evaluate(() => window.api.game.requestHint())
    await until(async () => (await state()).coach.hint !== null, 20000, 'hint')
    await sleep(400)
    const shapes = await page.evaluate(
      () => document.querySelectorAll('cg-board ~ svg g > *, .cg-shapes g > *').length
    )
    console.log('hint:', (await state()).coach.hint?.uci, '| svg shape elements:', shapes)
    await page.screenshot({ path: join(shots, '12-hint-ring.png') })
  }
} catch (e) {
  console.log('EXC', String(e).slice(0, 400))
} finally {
  const pid = app.process().pid
  await app.close().catch(() => {})
  await sleep(1000)
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  rmSync(appData, { recursive: true, force: true })
}
