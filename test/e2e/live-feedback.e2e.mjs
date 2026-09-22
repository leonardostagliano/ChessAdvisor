// Isolated Electron regression: actual Stockfish, simulated model, no account quota.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const repo = resolve(import.meta.dirname, '../..')
const data = mkdtempSync(join(tmpdir(), 'chessadvisor-feedback-'))
const shots = join(repo, 'test/e2e/shots/live-feedback')
const publicShots = join(repo, 'docs/screenshots')
mkdirSync(join(data, 'data'), { recursive: true })
mkdirSync(shots, { recursive: true })
mkdirSync(publicShots, { recursive: true })
writeFileSync(
  join(data, 'data/settings.json'),
  JSON.stringify({
    language: 'it',
    theme: 'night',
    liveMoveFeedback: true,
    updates: { autoCheck: false }
  })
)
const env = { ...process.env, CHESSADVISOR_USER_DATA: data, CHESSADVISOR_FAKE_CODEX: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.'],
  cwd: repo,
  env,
  timeout: 60000
})
const page = await app.firstWindow()
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}
const poll = async (fn, timeout = 20000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const value = await fn()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw Error('Polling timeout')
}
page.on('pageerror', (error) => check('renderer exception', false, error.message))
try {
  await poll(
    () => page.evaluate(async () => (await window.api.codex.state()).status === 'ready'),
    60000
  )
  await poll(() => page.evaluate(async () => (await window.api.engine.state()).available))
  await page.getByRole('button', { name: /Impostazioni/ }).click()
  await page.getByRole('combobox', { name: 'Tema', exact: true }).click()
  await page.getByRole('option', { name: 'Notturno', exact: true }).click()
  await page.getByRole('button', { name: 'Gioca', exact: true }).click()
  await page.evaluate(() =>
    window.api.game.new({
      userColor: 'w',
      model: 'gpt-6-astra',
      effort: 'high',
      difficulty: { mode: 'fixed', level: 5 },
      coach: { model: 'gpt-6-astra', effort: 'high' },
      language: 'it',
      showReasoning: false,
      commentsVisible: false,
      clock: null
    })
  )
  await page.evaluate(() => {
    window.feedbackTimes = { move: null, grade: null }
    window.api.on('game:state', (state) => {
      if (state.game?.moves[0] && window.feedbackTimes.move === null)
        window.feedbackTimes.move = performance.now()
      if (state.game?.moves[0]?.liveEval && window.feedbackTimes.grade === null)
        window.feedbackTimes.grade = performance.now()
    })
    window.moveComplete = window.api.game.userMove('e2e4')
  })
  await poll(() => page.evaluate(() => window.feedbackTimes.grade !== null))
  const times = await page.evaluate(() => window.feedbackTimes)
  const latency = Math.round(times.grade - times.move)
  check('live grade latency under 1 second', latency < 1000, `${latency} ms`)
  await page.getByTestId('move-quality-overlay').waitFor({ state: 'visible', timeout: 3000 })
  check('overlay displayed during opponent calculation', true)
  await page.screenshot({ path: join(publicShots, 'play.png') })
  await page.evaluate(() => window.moveComplete)
  await poll(() =>
    page.evaluate(async () =>
      (await window.api.game.state()).game.moves.every((move) => move.liveEval)
    )
  )
  const match = await page.evaluate(() => window.api.game.state())
  check(
    'both colours classified',
    match.game.moves.length === 2 && match.game.moves.every((move) => move.liveEval)
  )
  check(
    'deeper review kept separate',
    match.game.moves.every((move) => !move.eval)
  )
  const badges = page.getByTestId('move-quality-badge')
  check('move list has quality badges', (await badges.count()) >= 2)
  await new Promise((resolve) => setTimeout(resolve, 2800))
  check(
    'overlay expires despite state updates',
    (await page.getByTestId('move-quality-overlay').count()) === 0
  )
  const toggle = page.getByRole('switch', { name: /Valutazione mosse/ })
  await toggle.click()
  check(
    'toggle persists disabled setting',
    !(await page.evaluate(() => window.api.settings.get())).liveMoveFeedback
  )
  check('toggle hides badges', (await badges.count()) === 0)
  await toggle.click()
  check('toggle restores badges', (await badges.count()) >= 2)
  await page.getByRole('button', { name: /Impostazioni/ }).click()
  await page.getByRole('combobox', { name: 'Tema', exact: true }).click()
  await page.getByRole('option', { name: 'Editoriale', exact: true }).click()
  await page.getByRole('button', { name: 'Gioca', exact: true }).click()
  await page.screenshot({ path: join(shots, 'editorial.png') })
  await app.browserWindow(page).then((window) => window.evaluate((win) => win.setSize(1024, 720)))
  await page.screenshot({ path: join(shots, 'compact.png') })
  check(
    'compact layout has no horizontal overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  )
  await page.evaluate(() => window.api.game.takeback())
  check(
    'takeback removes old badges and overlay',
    (await badges.count()) === 0 && (await page.getByTestId('move-quality-overlay').count()) === 0
  )
  const resigned = await page.evaluate(() =>
    window.api.game.new({
      userColor: 'w',
      model: 'gpt-6-astra',
      effort: 'high',
      difficulty: { mode: 'fixed', level: 5 },
      coach: { model: 'gpt-6-astra', effort: 'high' },
      language: 'it',
      showReasoning: false,
      commentsVisible: false,
      clock: null,
      startFen: '7k/4Q3/5K2/8/8/8/8/8 b - - 0 20'
    })
  )
  check(
    'hopeless AI resigns with correct winner',
    resigned.game.result?.reason === 'resign' && resigned.game.result.outcome === '1-0'
  )
  await page.evaluate(() => window.api.game.close())
  await app.browserWindow(page).then((window) => window.evaluate((win) => win.setSize(1320, 1100)))
  await page.getByRole('button', { name: /Allenamento/ }).click()
  await page.getByRole('tab', { name: 'Tattica', exact: true }).click()
  await page.getByRole('button', { name: 'Nuova serie', exact: true }).click()
  await page.getByTestId('thematic-set').waitFor({ state: 'visible', timeout: 30000 })
  await page.locator('cg-board').first().waitFor()
  await page.screenshot({ path: join(publicShots, 'training.png'), fullPage: true })
} catch (error) {
  check('scenario completes', false, String(error))
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
} finally {
  writeFileSync(join(shots, 'summary.json'), JSON.stringify(results, null, 2))
  await app.close()
  const root = resolve(tmpdir()) + sep
  if (resolve(data).startsWith(root) && resolve(data) !== resolve(tmpdir()))
    rmSync(data, { recursive: true, force: true })
}
if (results.some((result) => !result.pass)) process.exitCode = 1
