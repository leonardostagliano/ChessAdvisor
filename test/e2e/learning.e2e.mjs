import { _electron as electron } from 'playwright-core'
import { Chess } from 'chess.js'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const repo = resolve(import.meta.dirname, '../..')
const appData = mkdtempSync(join(tmpdir(), 'chessadvisor-learning-'))
const data = join(appData, 'data')
mkdirSync(join(data, 'games'), { recursive: true })
const save = (name, value) => writeFileSync(join(data, name), JSON.stringify(value))
const game = (id, analysed) => {
  const board = new Chess()
  const moves = ['f3', 'e5', 'g4', 'Qh4#'].map((san, i) => {
    const move = board.move(san)
    return {
      ply: i + 1,
      san: move.san,
      uci: move.from + move.to,
      fenAfter: board.fen(),
      epdAfter: board.fen().split(' ').slice(0, 4).join(' '),
      by: i % 2 === 0 ? 'user' : 'ai'
    }
  })
  return {
    id,
    kind: 'match',
    status: 'finished',
    userColor: 'w',
    createdAt: id === 'g1' ? '2026-09-21T00:00:00Z' : '2026-09-22T00:00:00Z',
    updatedAt: '2026-09-22T01:00:00Z',
    opponent: {
      model: 'gpt-6-astra',
      effort: 'low',
      difficulty: { mode: 'fixed', level: 1, targetElo: 600 }
    },
    coach: { model: 'gpt-6-astra', effort: 'low' },
    language: 'it',
    clock: null,
    takebacks: 0,
    coachLog: [],
    moves,
    result: { outcome: '0-1', reason: 'checkmate' },
    ...(analysed
      ? {
          analysis: {
            accuracy: { w: 50, b: 100 },
            acpl: { w: 100, b: 0 },
            keyMoments: [],
            analyzedAt: '2026-09-22T01:01:00Z'
          }
        }
      : {})
  }
}
save('settings.json', {
  language: 'it',
  defaultModel: 'gpt-6-astra',
  defaultEffort: 'low',
  updates: { autoCheck: false }
})
save('learning-policy.json', {
  version: 2,
  retiredGameIds: [],
  migratedAt: '2026-09-22T00:00:00Z',
  backupDir: 'fixture'
})
save('games/g1.json', game('g1', true))
save('games/g2.json', game('g2', false))
save('profile.json', {
  history: [{ gameId: 'deleted', date: '2026-09-20', accuracy: 90, acpl: 10 }],
  openingStats: {
    C20: {
      eco: 'C20',
      name: 'Stale',
      games: 3,
      wins: 0,
      draws: 3,
      losses: 0,
      avgAccuracyFirst10: 90
    }
  },
  qualitative: {
    strengths: ['Tutte terminate patte'],
    weaknesses: ['Vecchio profilo'],
    updatedAt: '2026-09-20'
  }
})
const exercise = (id, sourceGameId) => ({
  id,
  kind: 'own_game',
  sourceGameId,
  sourcePly: 1,
  fen: '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1',
  sideToMove: 'w',
  solution: ['g6g7'],
  theme: 'back_rank',
  status: 'new',
  attempts: 0,
  createdAt: '2026-09-21T00:00:00Z'
})
save('exercises.json', [exercise('keep', 'g1'), exercise('orphan', 'deleted')])
const env = { ...process.env, CHESSADVISOR_USER_DATA: appData, CHESSADVISOR_FAKE_CODEX: '1' }
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
const poll = async (fn, timeout = 120000) => {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    const r = await fn()
    if (r) return r
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error('Polling timeout')
}
page.on('pageerror', (e) => check('renderer exception', false, String(e)))
try {
  await page.waitForFunction(() => Boolean(window.api))
  const initial = await page.evaluate(() => window.api.profile.get())
  check(
    'startup counts two checkmate losses, including pending analysis',
    initial.results?.games === 2 && initial.results?.losses === 2 && initial.results?.draws === 0
  )
  check(
    'startup removes deleted history and incorrect prose',
    !initial.history.some((r) => r.gameId === 'deleted') &&
      !String(JSON.stringify(initial.qualitative)).includes('patte')
  )
  const exercises = await page.evaluate(() => window.api.training.exercises.list())
  check(
    'startup removes only orphan exercises',
    exercises.some((e) => e.id === 'keep') && !exercises.some((e) => e.id === 'orphan')
  )
  await poll(() =>
    page.evaluate(async () => (await window.api.analysis.status('g2')).state === 'running')
  )
  check('unfinished saved analysis resumes automatically', true)
  await page.evaluate(() => window.api.games.delete('g2'))
  await poll(() => page.evaluate(async () => (await window.api.profile.get()).results.games === 1))
  check('deletion updates result totals', true)
  await poll(() => page.evaluate(async () => (await window.api.codex.state()).status === 'ready'))
  const firstPlan = await poll(() =>
    page.evaluate(async () => (await window.api.training.plan.get()).plan)
  )
  check('plan generated automatically', firstPlan.items.length > 0)
  const options = {
    userColor: 'w',
    model: 'gpt-6-astra',
    effort: 'low',
    difficulty: { mode: 'fixed', level: 1 },
    coach: { model: 'gpt-6-astra', effort: 'low' },
    clock: null,
    language: 'it',
    showReasoning: false,
    commentsVisible: false,
    startFen: '7k/5K2/6Q1/8/8/8/8/8 w - - 0 1',
    kind: 'match'
  }
  const started = await page.evaluate((opts) => window.api.game.new(opts), options)
  await page.getByRole('button', { name: 'Progressi', exact: true }).click()
  await page.getByRole('region', { name: 'Risultati delle partite' }).waitFor()
  await page.evaluate(() => window.api.game.userMove('g6g7'))
  await poll(() =>
    page.evaluate(async () => {
      const p = await window.api.profile.get()
      return p.results.games === 2 && p.results.wins === 1 && p.results.losses === 1
    })
  )
  check('finishing a game updates exact results automatically', true)
  await poll(() =>
    page.evaluate(
      async (id) => (await window.api.analysis.status(id)).state === 'done',
      started.game.id
    )
  )
  await poll(() =>
    page.evaluate(
      async (before) => (await window.api.training.plan.get()).plan?.generatedAt !== before,
      firstPlan.generatedAt
    )
  )
  check('plan refreshes automatically after the finished game', true)
  await page.getByRole('button', { name: 'Progressi', exact: true }).click()
  await page.getByRole('region', { name: 'Risultati delle partite' }).waitFor()
  const visibleResults = await page
    .getByRole('region', { name: 'Risultati delle partite' })
    .innerText()
  check(
    'progress screen updates while mounted',
    /Vinte\s+1/.test(visibleResults) && /Perse\s+1/.test(visibleResults)
  )
  const shots = join(repo, 'test/e2e/shots/learning')
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'progress.png') })
  await page.evaluate(() => window.api.games.delete('g1'))
  await poll(() =>
    page.evaluate(
      async () => !(await window.api.training.exercises.list()).some((e) => e.sourceGameId === 'g1')
    )
  )
  check('deleting a source removes its exercises', true)
  await poll(() =>
    page.evaluate(async () => {
      const plan = await window.api.training.plan.get()
      return !plan.plan?.items.some((i) => i.activity.ref === 'keep')
    })
  )
  check('plan drops deleted exercise references', true)
  const archive = await page.evaluate(() => window.api.games.list())
  check(
    'cancelled analysis cannot resurrect deleted games',
    archive.length === 1 && archive[0].id === started.game.id
  )
} catch (error) {
  check('integration completed', false, String(error))
  console.log((await page.locator('body').innerText()).slice(0, 3500))
  const shots = join(repo, 'test/e2e/shots/learning')
  mkdirSync(shots, { recursive: true })
  await page.screenshot({ path: join(shots, 'failure.png') }).catch(() => {})
} finally {
  const pid = app.process().pid
  await app.close().catch(() => {})
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  const summary = {
    appData,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results
  }
  const shots = join(repo, 'test/e2e/shots/learning')
  mkdirSync(shots, { recursive: true })
  writeFileSync(join(shots, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(`${summary.passed} passed, ${summary.failed} failed; isolated data: ${appData}`)
  process.exitCode = summary.failed ? 1 : 0
}
