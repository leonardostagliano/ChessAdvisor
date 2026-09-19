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
const ok = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Electron ignores APPDATA on Windows: the main process honours this override instead (paths.ts).
const env = { ...process.env, CHESSADVISOR_USER_DATA: appData }
if (!REAL) env.CHESSADVISOR_FAKE_CODEX = '1'
else delete env.CHESSADVISOR_FAKE_CODEX

const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.'],
  cwd: repo,
  env,
  timeout: 60000
})
const page = await app.firstWindow({ timeout: 60000 })
page.setDefaultTimeout(30000)
page.on('console', (m) => {
  if (m.type() === 'error') console.log('[renderer error]', m.text().slice(0, 300))
})
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))

const api = (fn, ...args) =>
  page.evaluate(
    ([code, a]) => new Function('args', `return (${code})(...args)`)(a),
    [fn.toString(), args]
  )
const state = () => api(() => window.api.game.state())
const plies = async () => (await state()).game?.moves?.length ?? 0
const shot = (name) => page.screenshot({ path: join(shots, name), fullPage: false })
// Node-side polling: Playwright's waitForFunction does not await async predicates, and every
// condition here goes through the IPC bridge.
const until = async (fn, timeout, label = 'condition') => {
  const deadline = Date.now() + timeout
  for (;;) {
    let value = null
    try {
      value = await fn()
    } catch {
      /* transient */
    }
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`)
    await sleep(200)
  }
}

try {
  // 1. Codex becomes ready (status screen disappears) and the shell is visible
  await page.waitForFunction(() => document.querySelector('nav[aria-label]') !== null, null, {
    timeout: 60000
  })
  const codexReady = await until(
    async () => (await api(() => window.api.codex.state())).status === 'ready',
    120000,
    'codex ready'
  )
    .then(() => true)
    .catch(() => false)
  ok(
    'codex ready',
    codexReady,
    JSON.stringify(await api(() => window.api.codex.state())).slice(0, 120)
  )
  await until(
    async () => {
      const e = await api(() => window.api.engine.state())
      return e.available || e.binary === 'none'
    },
    30000,
    'engine probe'
  ).catch(() => {})
  const engineState = await api(() => window.api.engine.state())
  ok(
    'engine available',
    engineState.available,
    `${engineState.binary} ${engineState.version ?? ''}`
  )
  const version = await api(() => window.api.app.versionInfo())
  const pill = await page
    .getByTestId('rail-version')
    .textContent()
    .catch(() => null)
  ok(
    'rail version pill',
    !!pill && pill.includes(version.version),
    `pill="${pill}" version=${version.version}`
  )
  await sleep(500)
  await shot('01-home.png')

  // 2. New game dialog
  await page
    .getByRole('button', { name: /Nuova partita/ })
    .first()
    .click()
  await page.getByRole('dialog').waitFor()
  const difficulty = page.getByRole('radio', { name: /Medio/ })
  if (await difficulty.count()) await difficulty.first().click()
  if (REAL) {
    // Cheapest real configuration: the dialog preselects the saved defaults, so set them first.
    await page
      .getByRole('button', { name: /Annulla/ })
      .click()
      .catch(() => {})
    await api(() => window.api.settings.save({ defaultModel: 'gpt-5.5', defaultEffort: 'low' }))
    await page
      .getByRole('button', { name: /Nuova partita/ })
      .first()
      .click()
    await page.getByRole('dialog').waitFor()
    if (await difficulty.count()) await difficulty.first().click()
    const chosen = await page.getByRole('dialog').textContent()
    ok(
      'dialog preselects gpt-5.5 / Basso',
      /GPT-5\.5/.test(chosen ?? '') && /Basso/.test(chosen ?? ''),
      (chosen ?? '').replace(/\s+/g, ' ').slice(0, 160)
    )
  }
  await shot('02-new-game.png')
  await page.getByRole('button', { name: /Inizia partita/ }).click()
  await page.locator('cg-board').first().waitFor({ timeout: 60000 })
  await sleep(400) // let the first paint and the initial live eval settle, as a person would
  const s0 = await until(
    async () => {
      const current = await state()
      return current.status === 'playing' && current.game ? current : null
    },
    60000,
    'new game ready'
  )
  ok(
    'game started',
    s0.status === 'playing' && !!s0.game,
    `color=${s0.game?.userColor} difficulty=${JSON.stringify(s0.game?.opponent?.difficulty)} model=${s0.game?.opponent?.model}`
  )

  // 3. Make moves through the real board (click origin, click destination)
  const board = page.locator('cg-board').first()
  const orientationWhite = s0.game.userColor === 'w'
  const clickSquare = async (sq) => {
    const b = await board.boundingBox()
    const file = sq.charCodeAt(0) - 97,
      rank = Number(sq[1]) - 1
    const size = b.width / 8
    const x = b.x + (orientationWhite ? file : 7 - file) * size + size / 2
    const y = b.y + (orientationWhite ? 7 - rank : rank) * size + size / 2
    await page.mouse.click(x, y)
  }
  const aiTimeout = REAL ? 240000 : 30000
  const waitForUserTurn = (expectPlies) =>
    until(
      async () => {
        const s = await state()
        return (
          s.status !== 'playing' ||
          (s.userToMove && !s.ai.thinking && (s.game?.moves?.length ?? 0) >= expectPlies)
        )
      },
      aiTimeout,
      `user turn at ${expectPlies} plies`
    )

  // wait for our turn (as Black the AI moves first)
  await waitForUserTurn(orientationWhite ? 0 : 1)
  const userMoves = REAL ? 3 : 6
  let played = 0
  for (let i = 0; i < userMoves; i++) {
    const s = await state()
    if (s.status !== 'playing') break
    const pref = ['e2e4', 'd2d4', 'g1f3', 'b1c3', 'e7e5', 'd7d5', 'g8f6', 'b8c6']
    const legal = s.legal.map((m) => m.uci)
    const uci =
      pref.find((m) => legal.includes(m)) ?? legal[Math.floor(Math.random() * legal.length)]
    const before = s.game.moves.length
    // alternate the two real input methods: click-click and drag-and-drop
    if (i % 2 === 0) {
      await clickSquare(uci.slice(0, 2))
      await sleep(150)
      await clickSquare(uci.slice(2, 4))
    } else {
      const b = await board.boundingBox()
      const size = b.width / 8
      const c = (sq) => {
        const f = sq.charCodeAt(0) - 97,
          r = Number(sq[1]) - 1
        return {
          x: b.x + (orientationWhite ? f : 7 - f) * size + size / 2,
          y: b.y + (orientationWhite ? 7 - r : r) * size + size / 2
        }
      }
      const a = c(uci.slice(0, 2)),
        z = c(uci.slice(2, 4))
      await page.mouse.move(a.x, a.y)
      await page.mouse.down()
      await page.mouse.move((a.x + z.x) / 2, (a.y + z.y) / 2, { steps: 4 })
      await page.mouse.move(z.x, z.y, { steps: 4 })
      await page.mouse.up()
    }
    const applied = await until(async () => (await plies()) > before, 15000, 'move applied')
      .then(() => true)
      .catch(() => false)
    if (!applied) {
      ok(`user move ${i + 1} (${uci}) applied via board (${i % 2 === 0 ? 'click' : 'drag'})`, false)
      break
    }
    played++
    if (i === 0) await shot('03-thinking.png').catch(() => {})
    await waitForUserTurn(before + 2)
    const after = await state()
    const aiMove = after.game.moves[after.game.moves.length - 1]
    ok(
      `move ${i + 1}: ${uci} → AI ${aiMove?.san}`,
      aiMove?.by === 'ai' && after.game.moves.length === before + 2,
      `fallback=${aiMove?.fallback ?? 'none'} thinkingMs=${aiMove?.thinkingMs} comment=${(aiMove?.aiShortComment ?? '').slice(0, 60)}`
    )
  }
  ok('played moves through the board', played === userMoves, `${played}/${userMoves}`)

  // 3b. Coach (spec §4.2): the comments feed, a free question and the hint arrow.
  await page.getByRole('tab', { name: /^Commenti$/ }).click()
  const commentsOn = await page
    .getByRole('switch', { name: /Mostra commenti/ })
    .getAttribute('aria-checked')
  if (commentsOn !== 'true') await page.getByRole('switch', { name: /Mostra commenti/ }).click()
  const commented = await until(
    async () => {
      const s = await state()
      return [...(s.game?.moves ?? [])].reverse().find((m) => m.coachComment) ?? null
    },
    60000,
    'a coach comment'
  ).catch(() => null)
  const feed = commented ? await page.locator('[role="tabpanel"]').innerText() : ''
  ok(
    'the coach comments a played move',
    !!commented?.coachComment && feed.includes(commented.coachComment.slice(0, 24)),
    `${commented?.san ?? '—'}: ${(commented?.coachComment ?? '').slice(0, 60)}`
  )
  await sleep(300)
  await shot('03b-comments.png').catch(() => {})

  await page.getByRole('tab', { name: /^Coach$/ }).click()
  await page.getByLabel('Domanda al coach').fill('Che piano seguo in questa posizione?')
  await page.getByRole('button', { name: /^Invia$/ }).click()
  const answer = await until(
    async () => (await state()).coach?.lastAnswer ?? null,
    60000,
    'a coach answer'
  ).catch(() => null)
  // The renderer paints the answer a tick after the state carries it: poll the panel text too.
  const rendered = answer?.text
    ? await until(
        async () =>
          (await page.locator('[role="tabpanel"]').innerText()).includes(answer.text.slice(0, 24)),
        10000,
        'the answer on screen'
      ).catch(() => false)
    : false
  ok('the coach answers a question', !!answer?.text && rendered, (answer?.text ?? '').slice(0, 60))

  if (!REAL) ok('an explanatory answer does not add a move arrow', !(await state()).coach.hint)
  const moveQuestion = 'Quale mossa mi consigli di giocare adesso?'
  await page.getByLabel('Domanda al coach').fill(moveQuestion)
  await page.getByRole('button', { name: /^Invia$/ }).click()
  const advice = await until(
    async () => {
      const coach = (await state()).coach
      return coach.lastAnswer?.question === moveQuestion ? coach : null
    },
    60000,
    'advice with a move'
  ).catch(() => null)
  const adviceShapes = await until(
    async () =>
      page.evaluate(() => {
        const arrows = document.querySelectorAll('cg-container svg line').length
        const pieces = document.querySelectorAll('cg-container svg circle').length
        return arrows > 0 && pieces > 0 ? { arrows, pieces } : null
      }),
    10000,
    'advice arrow and piece ring'
  ).catch(() => null)
  ok(
    'a written request for advice draws the move and highlights its piece',
    !!advice?.hint?.uci && !!adviceShapes,
    advice?.hint?.move ?? 'no move'
  )
  const advicePanel = await page.locator('[role="tabpanel"]').innerText()
  ok(
    'advice is shown as readable text without JSON metadata',
    !!advice?.lastAnswer?.text &&
      advicePanel.includes(advice.lastAnswer.text) &&
      !advicePanel.includes('"answer":') &&
      !advicePanel.includes('"move":')
  )
  await shot('03c-advice-arrow.png').catch(() => {})
  await page.getByRole('button', { name: 'Nascondi il suggerimento' }).click()
  await until(async () => !(await state()).coach.hint, 10000, 'hidden advice')
  ok(
    'hiding advice clears its arrow and piece ring',
    await until(
      async () =>
        (await page.locator('cg-container svg line, cg-container svg circle').count()) === 0,
      10000,
      'cleared advice shapes'
    ).catch(() => false)
  )

  await page
    .getByRole('button', { name: /^Suggerimento$/ })
    .first()
    .click()
  const hint = await until(
    async () => (await state()).coach?.hint ?? null,
    60000,
    'a coach hint'
  ).catch(() => null)
  // The arrow is a <line> inside chessground's shapes layer: no shape, no line.
  const arrows = await until(
    async () => page.locator('cg-container svg line').count(),
    10000,
    'hint arrow'
  ).catch(() => 0)
  const rings = await page.locator('cg-container svg circle').count()
  ok(
    'the hint is drawn on the board',
    !!hint?.uci && arrows > 0 && rings > 0,
    `${hint?.move ?? '—'} (${arrows} shape lines)`
  )
  await sleep(300)
  await shot('03c-hint.png').catch(() => {})
  await page.getByRole('tab', { name: /^Mosse$/ }).click()
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'night'
  })
  await sleep(400)
  await shot('04-play-night.png')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'editorial'
  })
  await sleep(400)
  await shot('05-play-editorial.png')
  await page.evaluate(() => {
    document.documentElement.dataset.theme = 'night'
  })

  // 4. Takeback (two plies)
  const beforeTb = await plies()
  await page.getByRole('button', { name: /Annulla mossa/ }).click()
  await until(async () => (await plies()) < beforeTb, 15000, 'takeback')
  const afterTb = await state()
  ok(
    'takeback removed the last exchange',
    afterTb.game.moves.length === beforeTb - 2 &&
      afterTb.game.takebacks === 1 &&
      afterTb.userToMove,
    `${beforeTb} → ${afterTb.game.moves.length}`
  )

  // 5. Save & exit, archive, resume
  const gameId = afterTb.game.id
  await page.getByRole('button', { name: /Salva ed esci/ }).click()
  await until(async () => (await state()).status === 'idle', 15000, 'session idle')
  const archived = await api(() => window.api.games.list())
  ok(
    'archive lists the saved game as in progress',
    archived.some((g) => g.id === gameId && g.status === 'in_progress'),
    `${archived.length} games`
  )
  await page
    .getByRole('button', { name: /^Partite$/ })
    .first()
    .click()
    .catch(() => {})
  await sleep(500)
  await shot('06-archive.png')
  await page
    .getByRole('button', { name: /Riprendi/ })
    .first()
    .click()
  await until(
    async () => {
      const s = await state()
      return s.status === 'playing' && s.game?.id === gameId
    },
    aiTimeout,
    'resume'
  )
  const resumed = await state()
  ok(
    'resume restores the game',
    resumed.game?.id === gameId && resumed.game.moves.length >= afterTb.game.moves.length,
    `plies=${resumed.game?.moves?.length}`
  )

  // 6. Resign → result banner
  await waitForUserTurn(resumed.game.moves.length)
  await page.getByRole('button', { name: /Abbandona/ }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Conferma|Abbandona/ })
    .last()
    .click()
  await until(async () => (await state()).status === 'finished', 15000, 'finished')
  const fin = await state()
  ok(
    'resign finishes the game',
    fin.game?.result?.reason === 'resign',
    JSON.stringify(fin.game?.result)
  )
  await sleep(400)
  await shot('07-result.png')

  // 6b. Review (spec §4.4): the pipeline runs by itself when the game ends, the screen shows the
  // accuracy of both colours and the evaluation graph, and the coach writes the lesson.
  const reviewedId = fin.game.id
  await page
    .getByRole('button', { name: /^Rivedi$/ })
    .first()
    .click()
  await page.getByRole('region', { name: 'Revisione' }).waitFor()
  const analysisState = await until(
    async () => {
      const s = await api((id) => window.api.analysis.status(id), reviewedId)
      return s.state === 'done' || s.state === 'unavailable' ? s : null
    },
    300000,
    'analysis done'
  ).catch(() => null)
  ok(
    'the analysis of the finished game completes',
    analysisState?.state === 'done',
    JSON.stringify(analysisState)
  )

  const review = page.getByRole('region', { name: 'Revisione' })
  const accuracies = await until(
    async () => {
      const text = await review.innerText()
      const found = text.match(/\d+([.,]\d)?%/g)
      return found && found.length >= 2 ? found : null
    },
    60000,
    'accuracy numbers'
  ).catch(() => null)
  ok(
    'the review shows the accuracy of both colours',
    !!accuracies && accuracies.length >= 2,
    (accuracies ?? []).slice(0, 2).join(' / ')
  )

  const analysedGame = await api((id) => window.api.games.get(id), reviewedId)
  const points = await page.locator('[data-testid="eval-graph"] [data-ply]').count()
  ok(
    'the evaluation graph has one point per position',
    points === (analysedGame?.moves?.length ?? 0) + 1,
    `${points} points for ${analysedGame?.moves?.length ?? 0} plies`
  )

  const moments = await page.getByRole('region', { name: 'Momenti chiave' }).count()
  ok(
    'the key moments list is on screen',
    moments === 1,
    `keyMoments=${JSON.stringify(analysedGame?.analysis?.keyMoments ?? [])}`
  )

  await page.getByRole('button', { name: /^Lezione della partita$/ }).click()
  const takeaways = await until(
    async () => {
      const n = await page.locator('section[aria-label="Lezione della partita"] ol li').count()
      return n > 0 ? n : null
    },
    120000,
    'the lesson of the game'
  ).catch(() => 0)
  ok('the lesson lists three takeaways', takeaways === 3, `${takeaways} takeaways`)
  await sleep(300)
  await shot('08-review.png')

  // The analysis feeds the profile (spec §6.1): the level and the history are written by then.
  const profile = await until(
    async () => {
      const value = await api(() => window.api.profile.get())
      return value && value.history.length > 0 ? value : null
    },
    60000,
    'the profile of the analysed match'
  ).catch(() => null)
  ok(
    'the analysed match lands in the profile',
    Boolean(profile) &&
      profile.history[0].gameId === reviewedId &&
      profile.level.band.length > 0 &&
      profile.gamesSincePlan === 1,
    profile
      ? `band=${profile.level.band} estimate=${profile.level.estimate} history=${profile.history.length}`
      : 'no profile'
  )

  await page.getByRole('button', { name: /^Chiudi la revisione$/ }).click()
  await page.locator('cg-board').first().waitFor()

  // 6b. Progressi (spec §6.9): the analysed match gives the dashboard a level and one trend point.
  await page
    .getByRole('button', { name: /^Progressi$/ })
    .first()
    .click()
  const levelCard = page.getByRole('region', { name: 'Livello stimato' })
  await levelCard.waitFor()
  const levelText = (await levelCard.innerText()).replace(/\s+/g, ' ')
  ok(
    'the progress dashboard shows the band of the level',
    /Principiante|Novizio|Intermedio|Avanzato|Esperto/.test(levelText),
    levelText.slice(0, 120)
  )
  const trendPoints = await page.locator('[data-testid="accuracy-trend"] [data-point]').count()
  ok(
    'the accuracy trend has one point per analysed match',
    trendPoints === 1,
    `${trendPoints} points`
  )
  const confidence = await page.getByTestId('confidence-ring').getAttribute('aria-label')
  ok(
    'the confidence of the estimate is written in words',
    /\d/.test(confidence ?? ''),
    confidence ?? 'no ring'
  )
  await sleep(300)
  await shot('08b-progress.png')

  // 6c. Allenamento (spec §6.4–§6.8): a thematic set drawn by the coach, the first puzzle solved
  // on the board, and the study plan written from the catalogue of what the app can offer.
  await page
    .getByRole('button', { name: /^Allenamento$/ })
    .first()
    .click()
  await page.getByRole('tablist', { name: 'Aree di allenamento' }).waitFor()
  await page.getByRole('tab', { name: 'Tattica' }).click()
  await page.getByRole('button', { name: /^Nuova serie$/ }).click()
  const player = page.locator('[data-testid="exercise-player"]')
  await player.waitFor({ timeout: 120000 })

  // The puzzle on screen is read through the bridge, exactly as a user would read the board: the
  // first move of its solution is the one to play. A promotion would need the picker, so the set
  // is walked until a plain move comes up.
  let exercise = null
  for (let i = 0; i < 10; i++) {
    const id = await player.getAttribute('data-exercise')
    exercise = await api((value) => window.api.training.exercises.get(value), id)
    if (exercise && exercise.solution[0] && exercise.solution[0].length === 4) break
    exercise = null
    const next = page.getByRole('button', { name: /^Esercizio successivo$/ })
    if (!(await next.count()) || (await next.isDisabled())) break
    await next.click()
    await sleep(200)
  }
  ok(
    'the thematic set opens on a puzzle of the library',
    !!exercise,
    exercise
      ? `${exercise.id} ${exercise.themes ?? exercise.theme} rating=${exercise.rating}`
      : 'no exercise'
  )

  const puzzleBoard = page.locator('cg-board').first()
  await puzzleBoard.scrollIntoViewIfNeeded()
  const puzzleWhite = exercise?.sideToMove === 'w'
  const clickPuzzle = async (sq) => {
    const b = await puzzleBoard.boundingBox()
    const file = sq.charCodeAt(0) - 97,
      rank = Number(sq[1]) - 1
    const size = b.width / 8
    await page.mouse.click(
      b.x + (puzzleWhite ? file : 7 - file) * size + size / 2,
      b.y + (puzzleWhite ? 7 - rank : rank) * size + size / 2
    )
  }
  const solution = exercise?.solution?.[0] ?? ''
  if (solution) {
    await clickPuzzle(solution.slice(0, 2))
    await sleep(200)
    await clickPuzzle(solution.slice(2, 4))
  }
  const feedback = await until(
    async () => {
      const text = await page
        .locator('[data-testid="exercise-feedback"]')
        .textContent()
        .catch(() => null)
      const result = await player.getAttribute('data-feedback')
      return text && ['correct', 'alternative', 'solved'].includes(result) ? text : null
    },
    30000,
    'the feedback of the exercise'
  ).catch(() => null)
  ok(
    'the first move of the solution is accepted',
    !!feedback,
    `${solution} → ${feedback ?? 'no feedback'}`
  )
  await sleep(300)
  await shot('08c-training.png')

  // Regressions: each coach action must settle and leave the other training actions usable.
  await player.getByRole('button', { name: /^Spiega$/ }).click()
  const explained = await until(
    async () => {
      const saved = await api((id) => window.api.training.exercises.get(id), exercise.id)
      return saved?.explanation?.trim() || null
    },
    120000,
    'exercise explanation'
  ).catch(() => null)
  await player.getByRole('button', { name: /^Spiega$/ }).waitFor({ timeout: 30000 })
  const explanationCard = await player.getByTestId('explanation-card').textContent()
  ok(
    'Explain returns text and releases the training controls',
    !!explained && explanationCard.includes(explained),
    explanationCard.slice(0, 160)
  )

  await page.getByRole('tab', { name: 'Aperture', exact: true }).click()
  const openingRows = page.locator('[data-testid="training-openings"] tbody tr')
  await openingRows.first().waitFor({ timeout: 30000 })
  await openingRows.first().getByRole('button').click()
  const openingDetail = page.getByTestId('opening-detail')
  await openingDetail.getByRole('button', { name: 'Mini-lezione', exact: true }).click()
  const lessonText = await until(
    async () => {
      if (!(await openingDetail.getByRole('button', { name: 'Mini-lezione', exact: true }).count()))
        return null
      if (!(await openingDetail.getByTestId('explanation-card').count())) return null
      return await openingDetail.getByTestId('explanation-card').textContent()
    },
    120000,
    'opening lesson'
  )
  ok(
    'opening Mini-lezione displays the completed lesson',
    !!lessonText && !lessonText.includes('sta scrivendo'),
    lessonText.slice(0, 160)
  )

  await page.getByRole('tab', { name: 'Piano di studio' }).click()
  await page.getByRole('button', { name: /^Genera il piano$/ }).click()
  const planItems = await until(
    async () => {
      const n = await page.locator('[data-testid="study-plan"] [data-item]').count()
      return n > 0 ? n : null
    },
    120000,
    'the items of the study plan'
  ).catch(() => 0)
  ok('the study plan lists at least four activities', planItems >= 4, `${planItems} items`)
  await sleep(300)
  await shot('08d-plan.png')

  await page.getByRole('tab', { name: 'Finali', exact: true }).click()
  const endgameCard = page.locator('[data-testid="endgames"] [data-endgame]').first()
  const endgameId = await endgameCard.getAttribute('data-endgame')
  const endgame = (await api(() => window.api.training.endgames.list())).find(
    (entry) => entry.id === endgameId
  )
  await endgameCard.getByRole('button', { name: 'Gioca', exact: true }).click()
  const drill = await until(
    async () => {
      const current = await state()
      return current.status === 'playing' && current.game?.kind === 'endgame_drill' ? current : null
    },
    60000,
    'endgame drill'
  )
  await page.locator('cg-board').first().waitFor()
  ok(
    'endgame Gioca opens the selected position at maximum difficulty',
    drill.game.startFen === endgame.fen && drill.game.opponent.difficulty.level === 6,
    endgameId
  )

  await page
    .getByRole('button', { name: /^Gioca$/ })
    .first()
    .click()
  await page.locator('cg-board').first().waitFor()

  // 7. Clocks (spec §4.3): 5+0 in "solo il mio tempo", where only the user burns time.
  await page
    .getByRole('button', { name: /Nuova partita/ })
    .first()
    .click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('radio', { name: '5+0' }).click()
  await page.getByRole('button', { name: /Inizia partita/ }).click()
  await until(
    async () => {
      const s = await state()
      return s.status === 'playing' && s.clock !== null
    },
    60000,
    'clock game'
  )
  const clocked = await state()
  const before = clocked.clock
  await sleep(1500)
  const after = (await state()).clock
  ok(
    'the user clock runs while the AI has none',
    clocked.game?.userColor === 'w' &&
      after.remainingMs.w < before.remainingMs.w &&
      after.remainingMs.b === clocked.game.clock.initialMs &&
      after.running === 'w',
    `w ${before.remainingMs.w} → ${after.remainingMs.w}, b ${after.remainingMs.b}, running=${after.running}`
  )
  const timers = await page.getByRole('timer').count()
  ok('only the clock of the side that has one is on screen', timers === 1, `${timers} timers`)
  await sleep(300)
  await shot('09-clock.png')

  // 8. Settings
  await page
    .getByRole('link', { name: /Impostazioni/ })
    .or(page.getByRole('button', { name: /Impostazioni/ }))
    .first()
    .click()
  await sleep(600)
  await shot('10-settings.png')
  const quota = await api(() => window.api.codex.quota())
  ok(
    'quota readable',
    quota === null || typeof quota.ordinaryUsageAllowed === 'boolean',
    JSON.stringify(quota)?.slice(0, 100)
  )

  // 9. Theme and language (task T22): both palettes and both languages, from the Settings screen.
  const themeNow = () => page.evaluate(() => document.documentElement.dataset.theme ?? '')
  const pickOption = async (select, option) => {
    await page.getByRole('combobox', { name: select }).click()
    await page.getByRole('option', { name: option }).click()
    await sleep(600)
  }
  await pickOption('Tema', 'Editoriale')
  const editorial = await themeNow()
  ok('the editorial palette is applied', editorial === 'editorial', `data-theme=${editorial}`)
  await shot('11-theme-editorial.png')

  await pickOption('Tema', 'Notturno')
  const night = await themeNow()
  ok('the night palette comes back', night === 'night', `data-theme=${night}`)
  await shot('11b-theme-night.png')

  await pickOption('Lingua', 'Inglese')
  const englishRail = await page.getByRole('navigation').first().textContent()
  const englishLang = await page.evaluate(() => document.documentElement.lang)
  ok(
    'the interface switches to English',
    /Play/.test(englishRail ?? '') && /Settings/.test(englishRail ?? '') && englishLang === 'en',
    `rail="${(englishRail ?? '').replace(/\s+/g, ' ').slice(0, 80)}" lang=${englishLang}`
  )
  await shot('12-english.png')

  // The shortcuts sheet is part of the same pass: it must speak the language in use.
  await page.keyboard.press('?')
  const sheet = await page
    .getByRole('dialog')
    .textContent()
    .catch(() => null)
  ok(
    'the shortcuts sheet opens with ?',
    !!sheet && /Keyboard shortcuts/.test(sheet),
    (sheet ?? '').replace(/\s+/g, ' ').slice(0, 80)
  )
  await shot('12b-shortcuts.png')
  await page.keyboard.press('Escape')
  await sleep(300)
  ok('the sheet closes with Esc', (await page.getByRole('dialog').count()) === 0)

  await page.getByRole('combobox', { name: 'Language' }).click()
  await page.getByRole('option', { name: 'Italian' }).click()
  await sleep(600)
  const backToItalian = await page.getByRole('navigation').first().textContent()
  ok(
    'the interface goes back to Italian',
    /Gioca/.test(backToItalian ?? ''),
    (backToItalian ?? '').replace(/\s+/g, ' ').slice(0, 80)
  )
} catch (e) {
  ok('script completed without exception', false, String(e).slice(0, 400))
  await shot('99-failure.png').catch(() => {})
} finally {
  const pid = app.process().pid
  await app.close().catch(() => {})
  await sleep(1500)
  // The window hides to tray on close; make sure nothing of ours survives.
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  const summary = {
    real: REAL,
    appData,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results
  }
  writeFileSync(join(shots, 'summary.json'), JSON.stringify(summary, null, 2))
  console.log(`\n${summary.passed} passed, ${summary.failed} failed. Screenshots in ${shots}`)
  if (!KEEP && existsSync(appData)) rmSync(appData, { recursive: true, force: true })
  process.exit(summary.failed ? 1 : 0)
}
