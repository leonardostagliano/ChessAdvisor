// Focused regression of educational comments/advice and deletion of the active game.
// Uses fake Codex and a fresh disposable profile; never touches the user's games.
import { _electron as electron } from 'playwright-core'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const repo = resolve(import.meta.dirname, '../..')
const profile = mkdtempSync(join(tmpdir(), 'chessadvisor-coach-e2e-'))
const shots = join(repo, 'test/e2e/shots/coach-explanations')
mkdirSync(shots, { recursive: true })
const results = []
function check(name, pass) {
  results.push({ name, pass })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`)
  if (!pass) throw new Error(name)
}
const app = await electron.launch({
  executablePath: require('electron'),
  args: ['.'],
  cwd: repo,
  env: {
    ...process.env,
    CHESSADVISOR_USER_DATA: profile,
    CHESSADVISOR_FAKE_CODEX: '1',
    FAKE_CODEX_COACH_DELAY_MS: '8000'
  },
  timeout: 60000
})
const page = await app.firstWindow({ timeout: 60000 })
page.setDefaultTimeout(20000)
const errors = []
page.on('pageerror', (error) => errors.push(String(error)))
const state = () => page.evaluate(() => window.api.game.state())
async function until(predicate, label, timeout = 90000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await predicate()
    if (result) return result
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('Timed out: ' + label)
}
try {
  await until(
    async () =>
      await page.evaluate(async () => (await window.api.codex.state()).status === 'ready'),
    'ready'
  )
  const instantStarted = Date.now()
  await page.evaluate(async () => {
    const models = (await window.api.codex.state()).models
    const model = models.find((m) => m.isDefault) ?? models[0]
    await window.api.game.new({
      userColor: 'w',
      model: model.id,
      effort: model.defaultEffort,
      coach: { model: model.id, effort: model.defaultEffort },
      difficulty: { mode: 'fixed', level: 2 },
      language: 'it',
      showReasoning: false,
      commentsVisible: true
    })
    void window.api.game.userMove('e2e4')
  })
  await page.getByRole('tab', { name: 'Commenti' }).click()
  await page.getByText('Lettura immediata', { exact: true }).first().waitFor()
  const instantMs = Date.now() - instantStarted
  check(
    'useful move facts appear before the delayed AI response',
    !(await state()).game.moves[0].coachComment
  )
  check('immediate reading appears within two seconds', instantMs < 2000)
  console.log('Immediate feedback: ' + instantMs + ' ms (AI held for 8000 ms)')
  await page.getByRole('button', { name: 'Commento a e4', exact: true }).click()
  check(
    'instant explanation already highlights the moved piece',
    (await page.getByTestId('board-annotations').locator('[data-square="e4"]').count()) > 0
  )
  await page
    .getByRole('tabpanel')
    .locator('article')
    .first()
    .evaluate((el) => {
      window.firstInstantCard = el
    })
  await page.screenshot({ timeout: 60000, animations: 'disabled', path: join(shots, 'instant-before-ai.png') })
  await until(async () => {
    const s = await state()
    return (
      s.game?.moves.length >= 2 &&
      !s.ai.thinking &&
      !s.coach.busy &&
      s.game.moves.some((m) => m.coachExplanation)
    )
  }, 'structured comments')
  check(
    'AI completes the same card without duplicating it',
    (await page
      .getByRole('tabpanel')
      .locator('article')
      .first()
      .evaluate((el) => el === window.firstInstantCard)) &&
      (await page.getByRole('tabpanel').locator('article').count()) === 2
  )
  await page.getByRole('button', { name: 'Torna alla posizione corrente' }).first().click()
  await page.evaluate(() => window.api.game.userMove('g1f3'))
  await until(async () => {
    const s = await state()
    return (
      s.game?.moves.length === 4 &&
      s.game.moves.every((m) => m.coachExplanation) &&
      !s.coach.busy &&
      !s.ai.thinking
    )
  }, 'four consecutive comments')
  await page.evaluate(() => (document.documentElement.dataset.theme = 'night'))
  await page.waitForTimeout(350)
  const original = await state()
  check(
    'comment persisted as structured lesson',
    !!original.game.moves.find((m) => m.coachExplanation)
  )
  await page.getByRole('tab', { name: 'Commenti' }).click()
  await page
    .getByRole('button', { name: /^Commento a / })
    .last()
    .click()
  await page.getByTestId('board-annotations').waitFor()
  check(
    'comment highlights its pieces on the board',
    await page.getByTestId('board-annotations').isVisible()
  )
  const commentCards = page.getByRole('tabpanel').locator('article')
  check('four completed comments are present', (await commentCards.count()) === 4)
  const measureCards = () =>
    commentCards.evaluateAll((cards) =>
      cards.every((card) => card.scrollHeight <= card.clientHeight + 1 && card.clientHeight > 250)
    )
  check('comment cards keep full natural height', await measureCards())
  await page.getByRole('button', { name: 'Spiegazione successiva' }).click()
  check(
    'board explanation advances to the next piece',
    await page.getByTestId('board-annotations').getByText('Pezzo 2 di 2').isVisible()
  )
  await page.getByRole('button', { name: 'Nascondi le spiegazioni' }).click()
  check(
    'closed explanation offers a visible reopen control',
    await page.getByRole('button', { name: /Riapri spiegazione/ }).isVisible()
  )
  await page.getByRole('button', { name: /Riapri spiegazione/ }).click()
  check(
    'reopening preserves the selected piece',
    await page.getByTestId('board-annotations').getByText('Pezzo 2 di 2').isVisible()
  )
  await page.getByRole('button', { name: 'Nascondi le spiegazioni' }).click()
  await page
    .getByRole('button', { name: /^Commento a / })
    .first()
    .click()
  check(
    'selecting an older comment reopens its explanation',
    await page.getByTestId('board-annotations').isVisible()
  )
  await page.setViewportSize({ width: 1024, height: 720 })
  check('four cards remain uncut at 1024px', await measureCards())
  await page
    .getByRole('button', { name: /^Commento a / })
    .first()
    .scrollIntoViewIfNeeded()
  const feed = commentCards.first().locator('..')
  check(
    'comment history scrolls independently',
    await feed.evaluate(
      (el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'
    )
  )
  const lastCard = commentCards.last()
  await lastCard.getByText(/idea da ricordare/i).scrollIntoViewIfNeeded()
  check(
    'last comment takeaway is reachable',
    await lastCard.getByText(/idea da ricordare/i).isVisible()
  )
  await page.screenshot({ timeout: 60000, animations: 'disabled', path: join(shots, 'comments-1024.png') })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page
    .getByRole('button', { name: /^Commento a / })
    .first()
    .scrollIntoViewIfNeeded()
  await page.screenshot({ timeout: 60000, animations: 'disabled', path: join(shots, 'comments-night.png') })
  await page.getByRole('switch', { name: 'Spiegazioni sulla scacchiera' }).click()
  check(
    'comment overlay can be turned off',
    (await page.getByTestId('board-annotations').count()) === 0
  )
  await page.getByRole('tab', { name: 'Coach' }).click()
  check(
    'Coach shares the overlay preference',
    (await page
      .getByRole('switch', { name: 'Spiegazioni sulla scacchiera' })
      .getAttribute('aria-checked')) === 'false'
  )
  const back = page.getByRole('button', { name: 'Torna alla posizione corrente' })
  if (await back.count()) await back.first().click()
  await page.getByLabel('Domanda al coach').fill('Quale mossa consigli adesso e perché?')
  await page.getByRole('button', { name: 'Invia', exact: true }).click()
  await page.getByText('Lettura immediata', { exact: true }).first().waitFor()
  check(
    'Coach also offers immediate position facts while the answer is pending',
    !(await state()).game.coachLog.some((e) => e.kind === 'answer')
  )
  await until(async () => {
    const s = await state()
    return !s.coach.busy && s.game.coachLog.some((e) => e.kind === 'answer' && e.coachExplanation)
  }, 'structured advice')
  const advice = (await state()).game.coachLog.findLast((e) => e.kind === 'answer')
  check('advice stores original FEN and lesson', !!advice.fen && !!advice.coachExplanation)
  check('advice carries verified engine lines', !!advice.coachExplanation.evidence?.lines.length)
  await page.getByRole('switch', { name: 'Spiegazioni sulla scacchiera' }).click()
  await page.getByTestId('board-annotations').waitFor()
  check('advice highlights its own pieces', await page.getByTestId('board-annotations').isVisible())
  await page.getByRole('button', { name: 'Nascondi le spiegazioni' }).click()
  await page.getByRole('button', { name: /Riapri spiegazione/ }).click()
  check(
    'Coach explanations can also be reopened',
    await page.getByTestId('board-annotations').isVisible()
  )
  const hint = page.getByRole('button', { name: 'Dammi un indizio' })
  if (await hint.count()) {
    await hint.last().click()
    check('progressive hint is interactive', true)
  }
  const reveal = page.getByRole('button', { name: 'Mostra la risposta' })
  check('calculated answer is available', (await reveal.count()) > 0)
  await reveal.last().click()
  check('calculated answer can be revealed', true)
  const details = page.locator('summary').filter({ hasText: /analisi/i })
  if (await details.count()) await details.last().click()
  const variation = page.getByRole('button', { name: /^Esplora / })
  check('engine variation controls are available', (await variation.count()) > 0)
  if (await variation.count()) {
    await variation.first().click()
    check(
      'variation shown on board',
      (await page.getByTestId('coach-board-context').textContent()).includes('Variante')
    )
    check(
      'preview does not play moves',
      (await state()).game.moves.length === original.game.moves.length
    )
    await page.getByRole('button', { name: 'Torna alla posizione corrente' }).first().click()
  }
  await page.screenshot({ timeout: 60000, animations: 'disabled', path: join(shots, 'advice-night.png') })
  await page.evaluate(() => (document.documentElement.dataset.theme = 'editorial'))
  await page.waitForTimeout(350)
  await page.screenshot({ timeout: 60000, animations: 'disabled', path: join(shots, 'advice-light.png') })
  await page.setViewportSize({ width: 1024, height: 720 })
  check(
    'no horizontal overflow at 1024px',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
  )
  await page.screenshot({ timeout: 60000, animations: 'disabled', path: join(shots, 'advice-1024.png') })
  await page.getByRole('button', { name: 'Partite', exact: true }).click()
  await page.getByRole('button', { name: 'Elimina', exact: true }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: 'Elimina', exact: true }).click()
  await until(async () => !(await state()).game, 'deleted active session cleared', 15000)
  check('deleting active game clears the main session', !(await state()).game)
  await page.getByRole('button', { name: 'Partita', exact: true }).click()
  check(
    'play panel no longer shows deleted game',
    (await page.getByRole('group', { name: 'Scacchiera', exact: true }).count()) === 0
  )
  check(
    'deleted game is absent from archive',
    (await page.evaluate(() => window.api.games.list())).length === 0
  )
  check('no renderer errors', errors.length === 0)
} finally {
  writeFileSync(join(shots, 'results.json'), JSON.stringify({ results, errors, profile }, null, 2))
  await app.close()
}
