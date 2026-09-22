// Focused training regression pass; --real uses three small turns from the user's Codex quota.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const real = process.argv.includes('--real')
const repo = resolve(import.meta.dirname, '../..')
const appData = mkdtempSync(join(tmpdir(), 'chessadvisor-training-'))
const shots = join(repo, 'test/e2e/shots', real ? 'training-real' : 'training-fake')
mkdirSync(join(appData, 'data'), { recursive: true })
mkdirSync(shots, { recursive: true })
const save = (name, value) => writeFileSync(join(appData, 'data', name), JSON.stringify(value))
save('settings.json', {
  language: 'it',
  defaultModel: real ? 'gpt-5.6-luna' : 'gpt-6-astra',
  defaultEffort: 'high',
  turnTimeoutSec: 180,
  updates: { autoCheck: false }
})
save('exercises.json', [
  {
    id: 'regression-mate',
    kind: 'own_game',
    fen: '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1',
    sideToMove: 'w',
    solution: ['g6g7'],
    theme: 'mate_in_one',
    status: 'new',
    attempts: 0,
    createdAt: '2026-09-19T00:00:00.000Z'
  }
])
save('profile.json', {
  openingStats: {
    C20: {
      eco: 'C20',
      name: 'King’s Pawn Game',
      games: 2,
      wins: 1,
      draws: 0,
      losses: 1,
      avgAccuracyFirst10: 70
    }
  }
})
// Fixtures represent data learned under the current policy; migration has separate coverage.
save('learning-policy.json', {
  version: 2,
  migratedAt: '2026-09-22T00:00:00Z',
  retiredGameIds: [],
  backupDir: 'fixture'
})
const env = { ...process.env, CHESSADVISOR_USER_DATA: appData }
delete env.ELECTRON_RUN_AS_NODE
if (real) delete env.CHESSADVISOR_FAKE_CODEX
else env.CHESSADVISOR_FAKE_CODEX = '1'
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.'],
  cwd: repo,
  env,
  timeout: 60000
})
const page = await app.firstWindow()
page.setDefaultTimeout(30000)
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} ${detail}`)
}
page.on('pageerror', (error) => check('renderer exception', false, String(error)))
const poll = async (fn, timeout = 210000) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    const result = await fn()
    if (result) return result
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`Timed out after ${timeout}ms`)
}
try {
  await poll(
    () => page.evaluate(async () => (await window.api.codex.state()).status === 'ready'),
    60000
  )
  const models = await page.evaluate(() => window.api.codex.models())
  const model = real ? 'gpt-5.6-luna' : 'gpt-6-astra'
  if (!models.some((m) => m.id === model))
    throw new Error(`Configured test model unavailable: ${model}`)
  await page.getByRole('button', { name: 'Allenamento', exact: true }).click()
  const player = page.getByTestId('exercise-player')
  await player.waitFor()
  let started = Date.now()
  await player.getByRole('button', { name: 'Spiega', exact: true }).click()
  // Leave the whole screen while the explanation is pending, then return after it finishes.
  await page.getByRole('button', { name: 'Progressi', exact: true }).click()
  const explanation = await poll(() =>
    page.evaluate(
      async () => (await window.api.training.exercises.get('regression-mate'))?.explanation
    )
  )
  await page.getByRole('button', { name: 'Allenamento', exact: true }).click()
  await player.getByRole('button', { name: 'Spiega', exact: true }).waitFor()
  const shown = await player.getByTestId('explanation-card').textContent()
  check(
    'Spiega completes across navigation',
    shown.includes(explanation),
    `${Date.now() - started}ms`
  )
  await page.screenshot({ path: join(shots, 'explanation.png') })

  await page.getByRole('tab', { name: 'Aperture', exact: true }).click()
  await page.getByTestId('training-openings').getByRole('button').first().click()
  const detail = page.getByTestId('opening-detail')
  started = Date.now()
  await detail.getByRole('button', { name: 'Mini-lezione', exact: true }).click()
  const lesson = await poll(async () => {
    if (!(await detail.getByRole('button', { name: 'Mini-lezione', exact: true }).count()))
      return null
    if (!(await detail.getByTestId('explanation-card').count())) return null
    return await detail.getByTestId('explanation-card').textContent()
  })
  check(
    'Mini-lezione displays text',
    lesson.length > 20 && !lesson.includes('sta scrivendo'),
    `${Date.now() - started}ms`
  )
  await page.screenshot({ path: join(shots, 'lesson.png') })

  await page.getByRole('tab', { name: 'Piano di studio', exact: true }).click()
  started = Date.now()
  await page.getByRole('button', { name: 'Genera il piano', exact: true }).click()
  await page.getByTestId('study-plan').locator('[data-item]').first().waitFor({ timeout: 420000 })
  const items = await page.getByTestId('study-plan').locator('[data-item]').count()
  check(
    'Genera piano produces usable activities',
    items >= 4,
    `${items} items, ${Date.now() - started}ms`
  )
  await page.screenshot({ path: join(shots, 'plan.png') })

  await page.getByRole('tab', { name: 'Finali', exact: true }).click()
  const card = page.getByTestId('endgames').locator('[data-endgame]').first()
  const id = await card.getAttribute('data-endgame')
  await card.getByRole('button', { name: 'Gioca', exact: true }).click()
  await poll(
    () => page.evaluate(async () => (await window.api.game.state()).game?.kind === 'endgame_drill'),
    60000
  )
  const session = await page.evaluate(() => window.api.game.state())
  const endgames = await page.evaluate(() => window.api.training.endgames.list())
  await page.locator('cg-board').first().waitFor()
  check(
    'Gioca opens the selected endgame',
    session.game.startFen === endgames.find((e) => e.id === id).fen &&
      session.game.opponent.difficulty.level === 6
  )
  await page.screenshot({ path: join(shots, 'endgame.png') })
} catch (error) {
  check('training flow completed', false, String(error))
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
} finally {
  const pid = app.process().pid
  await app.close().catch(() => {})
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  writeFileSync(join(shots, 'summary.json'), JSON.stringify({ real, results }, null, 2))
  const rel = relative(resolve(tmpdir()), resolve(appData))
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || !rel.startsWith('chessadvisor-training-'))
    throw new Error('Unexpected cleanup target')
  rmSync(appData, { recursive: true, force: true })
}
process.exit(results.some((r) => !r.pass) ? 1 : 0)
