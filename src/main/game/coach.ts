import { randomUUID } from 'node:crypto'
import { Chess } from 'chess.js'
import { normalizeMove } from '@shared/chess/notation'
import { classify } from '../analysis/classify'
import { winPercentLoss } from '../analysis/winPercent'
import type { StreamEnvelope } from '@shared/types/api'
import type { TurnResult } from '@shared/types/codex'
import type {
  CoachAnnotation,
  CoachEvidence,
  CoachEvidenceLine,
  CoachExplanation,
  Eval,
  Game
} from '@shared/types/game'
import type { EngineLine } from '@shared/types/engine'
import type { SettingsStore } from '../store/settingsStore'
import {
  ADVICE_SCHEMA,
  COMMENT_SCHEMA,
  HINT_SCHEMA,
  adviceText,
  coachBaseInstructions,
  commentText,
  hintText,
  resumeSummaryText,
  type CoachEval,
  type EngineContext
} from './coachPrompts'
import type { SessionCodex, SessionEngine } from './gameSession'

/**
 * The coach thread of one game (spec §4.2).
 *
 * It is a second, independent Codex thread: it comments the moves as they are played, answers the
 * questions of the Coach tab and produces the hint arrow. It never sees the opponent thread, and
 * the opponent never sees it. Everything it says is streamed to the renderer by `CodexService`
 * itself — the deltas of a turn carry the `streamId` this class publishes through
 * {@link CoachSession.onActivity} *before* the turn starts, so the feed can subscribe in time.
 *
 * Nothing here ever throws into the game: a comment that cannot be produced is simply `null`, and
 * the game goes on without it.
 */

export type CoachLogEntry = Game['coachLog'][number]

/** Carries a machine-readable code through the IPC error contract (`serializeError`). */
export class CoachError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'CoachError'
  }
}

export interface CoachSessionDeps {
  codex: SessionCodex
  engine: SessionEngine
  settings: SettingsStore
  emit(channel: 'stream', payload: StreamEnvelope): void
  now(): number
}

/** What the session mirrors into `SessionState.coach` while a coach turn is in flight. */
export interface CoachActivity {
  busy: boolean
  streamId: string | null
}

/** Plies of a principal variation written into a prompt: enough to show the idea, no more. */
const PV_PLIES = 12
/** Best lines asked of the engine, as in spec §4.2 ("migliori 3 varianti"). */
const BEST_LINES = 5

const sideToMove = (fen: string): 'w' | 'b' => (fen.split(/\s+/)[1] === 'b' ? 'b' : 'w')

function terminalWinner(fen: string): 'w' | 'b' | null {
  try {
    const chess = new Chess(fen)
    if (!chess.isCheckmate()) return null
    return chess.turn() === 'w' ? 'b' : 'w'
  } catch {
    return null
  }
}

/** Engine scores are from the side to move; every number the coach reads is White's. */
function whiteEval(line: EngineLine | undefined, fen: string): CoachEval | null {
  const winner = terminalWinner(fen)
  if (!line) return winner ? { mate: 0, mateWinner: winner } : null
  const flip = sideToMove(fen) === 'b' ? -1 : 1
  if (typeof line.scoreMate === 'number') {
    if (winner && line.scoreMate === 0) return { mate: 0, mateWinner: winner }
    return { mate: flip * line.scoreMate }
  }
  if (typeof line.scoreCp === 'number') return { cp: flip * line.scoreCp }
  return null
}

/** UCI principal variation rendered in SAN; an unplayable tail is simply dropped. */
function pvInSan(fen: string, pv: string[]): { san: string; pv: string[]; uciPv: string[] } | null {
  let chess: Chess
  try {
    chess = new Chess(fen)
  } catch {
    return null
  }
  const san: string[] = []
  const uciPv: string[] = []
  for (const uci of pv.slice(0, PV_PLIES)) {
    const normalized = normalizeMove(chess.fen(), uci)
    if (!normalized) break
    try {
      san.push(chess.move(normalized.san).san)
      uciPv.push(normalized.uci)
    } catch {
      break
    }
  }
  if (san.length === 0) return null
  return { san: san[0]!, pv: san, uciPv }
}

/** Models like to wrap JSON in ``` fences even when the schema forbids prose. */
function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim()
}

const bounded = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed && trimmed.length <= max ? trimmed : undefined
}

function attacksFrom(chess: Chess, from: string, target: string): boolean {
  const piece = chess.get(from as Parameters<Chess['get']>[0])
  return (
    !!piece &&
    chess
      .attackers(target as Parameters<Chess['attackers']>[0], piece.color)
      .includes(from as Parameters<Chess['get']>[0])
  )
}

function validAnnotations(value: unknown, fenAfter: string): CoachAnnotation[] {
  if (!Array.isArray(value)) return []
  let chess: Chess
  try {
    chess = new Chess(fenAfter)
  } catch {
    return []
  }
  const annotations: CoachAnnotation[] = []
  for (const candidate of value.slice(0, 12)) {
    if (!candidate || typeof candidate !== 'object') continue
    const item = candidate as Record<string, unknown>
    const square = item.square
    const label = bounded(item.label, 80)
    if (
      typeof square !== 'string' ||
      !/^[a-h][1-8]$/.test(square) ||
      !label ||
      !chess.get(square as Parameters<Chess['get']>[0])
    )
      continue
    if (item.kind === 'focus') annotations.push({ square, label, kind: 'focus' })
    if (item.kind === 'threat' && typeof item.from === 'string' && /^[a-h][1-8]$/.test(item.from)) {
      const from = item.from
      const attacker = chess.get(from as Parameters<Chess['get']>[0])
      const target = chess.get(square as Parameters<Chess['get']>[0])
      if (attacker && target && attacker.color !== target.color && attacksFrom(chess, from, square))
        annotations.push({ square, label, kind: 'threat', from })
    }
    if (annotations.length >= 4) break
  }
  return annotations
}

function parseComment(
  text: string,
  fenAfter: string
): { text: string; explanation?: CoachExplanation } | null {
  let value: unknown
  try {
    value = JSON.parse(stripFences(text))
  } catch {
    const plain = bounded(text, 4000)
    // A broken JSON answer must not become visible coach prose or a permanent save.
    const unwrapped = stripFences(text)
    return plain && !text.trimStart().startsWith('```') && !/^[\[{]/.test(unwrapped)
      ? { text: plain }
      : null
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  const headline = bounded(data.headline, 100)
  const explanation = bounded(data.explanation, 2000)
  if (!headline || !explanation || (data.version !== undefined && data.version !== 1)) return null
  const hints = Array.isArray(data.hints)
    ? data.hints
        .slice(0, 2)
        .map((hint: unknown) => bounded(hint, 240))
        .filter((hint): hint is string => !!hint)
    : []
  const card: CoachExplanation = {
    version: 1,
    headline,
    explanation,
    hints,
    annotations: validAnnotations(data.annotations, fenAfter)
  }
  const priority = bounded(data.priority, 240)
  const question = bounded(data.question, 240)
  const takeaway = bounded(data.takeaway, 240)
  if (priority) card.priority = priority
  if (question) card.question = question
  if (takeaway) card.takeaway = takeaway
  return { text: `${headline} ${explanation}`.trim(), explanation: card }
}

function plainEval(value: CoachEval | null): Eval | undefined {
  if (!value) return undefined
  if (typeof value.mate === 'number' && Number.isFinite(value.mate)) return { mate: value.mate }
  if (typeof value.cp === 'number' && Number.isFinite(value.cp)) return { cp: value.cp }
  return undefined
}

function evidenceLine(
  kind: 'best' | 'reply',
  startFen: string,
  line: { uciPv?: string[]; eval: CoachEval }
): CoachEvidenceLine | null {
  if (!line.uciPv?.length) return null
  let chess: Chess
  try {
    chess = new Chess(startFen)
  } catch {
    return null
  }
  const moves: CoachEvidenceLine['moves'] = []
  for (const uci of line.uciPv.slice(0, PV_PLIES)) {
    const normalized = normalizeMove(chess.fen(), uci)
    if (!normalized) break
    try {
      const played = chess.move(normalized.san)
      moves.push({ san: played.san, uci: normalized.uci, fenAfter: chess.fen() })
    } catch {
      break
    }
  }
  if (!moves.length) return null
  const evaluation = plainEval(line.eval)
  return { kind, startFen, moves, ...(evaluation ? { evaluation } : {}) }
}

function coachEvidence(
  engine: EngineContext | null,
  source: CoachEvidence['source'],
  fenBefore: string,
  fenAfter: string
): CoachEvidence | undefined {
  if (!engine) return undefined
  const lines = [
    ...engine.bestLines.map((line) => evidenceLine('best', fenBefore, line)),
    ...(engine.replyLines ?? []).map((line) => evidenceLine('reply', fenAfter, line))
  ].filter((line): line is CoachEvidenceLine => line !== null)
  const evalBefore = plainEval(engine.evalBefore)
  const evalAfter = plainEval(engine.evalAfter)
  if (!evalBefore && !evalAfter && lines.length === 0) return undefined
  return {
    source,
    perspective: 'white',
    ...(evalBefore ? { evalBefore } : {}),
    ...(evalAfter ? { evalAfter } : {}),
    lines
  }
}

function parseHint(
  text: string,
  fen: string
): { move: string; reason: string; explanation?: CoachExplanation } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(text))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.move !== 'string' || record.move.trim().length === 0) return null
  const explanation = record.card
    ? parseComment(JSON.stringify(record.card), fen)?.explanation
    : undefined
  return {
    move: record.move,
    reason: typeof record.reason === 'string' ? record.reason : '',
    ...(explanation ? { explanation } : {})
  }
}

function parseAdvice(
  text: string,
  fen: string,
  allowMove: boolean
): {
  answer: string
  hint: { move: string; uci: string; reason: string } | null
  explanation?: CoachExplanation
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(text))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.answer !== 'string' || record.answer.trim().length === 0) return null
  if (record.move !== null && typeof record.move !== 'string') return null

  const answer = record.answer.trim()
  const move = allowMove && typeof record.move === 'string' ? normalizeMove(fen, record.move) : null
  const explanation = record.card
    ? parseComment(JSON.stringify(record.card), fen)?.explanation
    : undefined
  return {
    answer,
    hint: move ? { move: move.san, uci: move.uci, reason: answer } : null,
    ...(explanation ? { explanation } : {})
  }
}

export class CoachSession {
  private threadId: string | null = null
  private generation = 0
  private inFlight = 0
  private streamIdValue: string | null = null
  /** Recap of a resumed game, prepended to the first turn instead of costing one of its own. */
  private pendingRecap: string | null = null
  /** Set when a failure makes the coach useless for the rest of the game (quota, no thread). */
  private disabled = false

  /**
   * Additive hook (not a constructor dependency): the game session mirrors `busy`/`streamId`
   * into `SessionState.coach` so the renderer can attach to the stream before the deltas start.
   */
  onActivity: ((activity: CoachActivity) => void) | null = null

  constructor(private readonly deps: CoachSessionDeps) {}

  get busy(): boolean {
    return this.inFlight > 0
  }

  /** `streamId` of the coach turn currently running, or `null`. */
  get streamId(): string | null {
    return this.streamIdValue
  }

  /** True once a failure that retrying cannot fix has switched the coach off for this game. */
  get off(): boolean {
    return this.disabled
  }

  // ------------------------------------------------------------------ lifecycle

  /** Opens the coach thread of `game`. On resume the recap rides on the first real turn. */
  async start(game: Game, opts: { language: 'it' | 'en'; recap?: CoachLogEntry[] }): Promise<void> {
    const generation = this.generation + 1
    await this.close()
    if (this.generation !== generation) return
    this.disabled = false
    const { model } = this.resolve(game)
    const threadId = await this.deps.codex.startThread('coach', {
      model,
      baseInstructions: coachBaseInstructions({
        language: opts.language,
        userColor: game.userColor,
        engineAvailable: this.deps.engine.state().available
      }),
      gameId: game.id
    })
    if (this.generation !== generation) {
      await this.deps.codex.closeThread(threadId).catch(() => undefined)
      return
    }
    this.threadId = threadId
    this.pendingRecap =
      opts.recap && opts.recap.length > 0 ? resumeSummaryText(opts.recap, opts.language) : null
  }

  async interrupt(): Promise<void> {
    const threadId = this.threadId
    if (!threadId || !this.busy) return
    await this.deps.codex.interrupt(threadId).catch(() => undefined)
  }

  async close(): Promise<void> {
    this.generation += 1
    const threadId = this.threadId
    this.threadId = null
    this.pendingRecap = null
    if (threadId) {
      if (this.busy) await this.deps.codex.interrupt(threadId).catch(() => undefined)
      await this.deps.codex.closeThread(threadId).catch(() => undefined)
    }
    this.inFlight = 0
    this.streamIdValue = null
    this.notify()
  }

  // ------------------------------------------------------------------ turns

  /**
   * Comment on the move at `ply` (1-based), with the engine's view of the position it was played
   * from. Returns `null` when the coach cannot answer: the game never waits on a comment.
   */
  async commentOn(
    game: Game,
    ply: number,
    opts: { fenBefore: string; fenAfter: string; pgn: string; signal?: AbortSignal }
  ): Promise<{ streamId: string; text: string; explanation?: CoachExplanation } | null> {
    const move = game.moves[ply - 1]
    const threadId = this.threadId
    if (!move || !threadId || this.disabled || opts.signal?.aborted) return null
    const language = this.language()
    let engine = await this.engineContext(opts.fenBefore, opts.fenAfter, 'comment', opts.signal)
    // The fast grade may arrive while the deeper contextual search is running.
    const measured = move.eval ?? move.liveEval
    // If Stockfish is unavailable, retain the move-time oracle so the coach can still explain
    // the recorded classification and measured before/after evaluations.
    if (!engine && measured) {
      const flip = sideToMove(opts.fenBefore) === 'b' ? -1 : 1
      const toWhite = (value: Eval, fen: string): CoachEval => {
        const winner = value.mate === 0 ? terminalWinner(fen) : null
        if (winner) return { mate: 0, mateWinner: winner }
        return value.mate !== undefined
          ? { mate: flip * value.mate }
          : { cp: flip * (value.cp ?? 0) }
      }
      const beforeWinner = terminalWinner(opts.fenBefore)
      const afterWinner = terminalWinner(opts.fenAfter)
      engine = {
        evalBefore: toWhite(measured.before, opts.fenBefore),
        evalAfter: toWhite(measured.after, opts.fenAfter),
        classification: measured.classification,
        bestLines: [],
        ...(beforeWinner
          ? { terminal: { winner: beforeWinner, at: 'before' as const } }
          : afterWinner
            ? { terminal: { winner: afterWinner, at: 'after' as const } }
            : {})
      }
    }
    // The game may have closed or been replaced while Stockfish was preparing the prompt.
    // Never let an old position leak into the new game's coach thread.
    if (opts.signal?.aborted || this.threadId !== threadId) return null
    if (engine) {
      // The badge and explanation share the same measured judgement when available.
      if (measured) {
        const flip = sideToMove(opts.fenBefore) === 'b' ? -1 : 1
        const toWhite = (value: Eval, fen: string): CoachEval => {
          const winner = value.mate === 0 ? terminalWinner(fen) : null
          if (winner) return { mate: 0, mateWinner: winner }
          return value.mate !== undefined
            ? { mate: flip * value.mate }
            : { cp: flip * (value.cp ?? 0) }
        }
        engine.evalBefore = toWhite(measured.before, opts.fenBefore)
        engine.evalAfter = toWhite(measured.after, opts.fenAfter)
        engine.classification = measured.classification
      } else if (engine.evalBefore && engine.evalAfter) {
        engine.classification = classify({
          loss: winPercentLoss(engine.evalBefore, engine.evalAfter, sideToMove(opts.fenBefore)),
          playedUci: move.uci,
          bestUci: normalizeMove(opts.fenBefore, engine.bestLines[0]?.san ?? '')?.uci ?? '',
          inBook: false
        })
      }
    }
    const text = commentText({
      move,
      by: move.by,
      fen: opts.fenAfter,
      pgn: opts.pgn,
      history: game.moves.slice(0, ply),
      engine,
      language
    })

    const run = await this.runTurn(game, text, language, {
      threadId,
      signal: opts.signal,
      outputSchema: COMMENT_SCHEMA
    })
    if (!run.result.ok) {
      if (run.result.reason === 'interrupted' && opts.signal?.aborted) return null
      // A quota or an unusable session is not worth one call per move for the rest of the game.
      if (run.result.reason === 'quota') this.disabled = true
      console.error('[coach] the comment turn failed:', run.result.reason, run.result.message)
      return null
    }
    if (opts.signal?.aborted || this.threadId !== threadId) return null
    const parsed = parseComment(run.result.text, opts.fenAfter)
    if (!parsed) return null
    if (parsed.explanation) {
      const source = move.eval ? 'review' : move.liveEval ? 'live' : 'engine'
      parsed.explanation.evidence = coachEvidence(engine, source, opts.fenBefore, opts.fenAfter)
    }
    return { streamId: run.streamId, ...parsed }
  }

  /** Free question from the Coach tab; the answer streams into the same channel as the comments. */
  async ask(
    game: Game,
    question: string,
    ctx: { fen: string; pgn: string }
  ): Promise<{
    streamId: string
    text: string
    hint: { move: string; uci: string; reason: string } | null
    explanation?: CoachExplanation
  }> {
    const asked = String(question ?? '').trim()
    if (!asked) throw new CoachError('COACH_EMPTY_QUESTION', 'a question is required')
    const threadId = this.threadId
    if (!threadId) throw new CoachError('COACH_NO_THREAD', 'the coach thread is not open')
    const language = this.language()
    const engine = await this.engineContext(ctx.fen, null)
    const text = adviceText({
      question: asked,
      userColor: game.userColor,
      fen: ctx.fen,
      pgn: ctx.pgn,
      engine,
      language
    })

    const run = await this.runTurn(game, text, language, {
      threadId,
      outputSchema: ADVICE_SCHEMA
    })
    if (!run.result.ok) {
      if (run.result.reason === 'quota') this.disabled = true
      throw new CoachError('COACH_TURN_FAILED', run.result.message)
    }
    const parsed = parseAdvice(run.result.text, ctx.fen, sideToMove(ctx.fen) === game.userColor)
    if (!parsed)
      throw new CoachError('COACH_TURN_FAILED', 'the coach returned malformed structured advice')
    if (parsed.explanation)
      parsed.explanation.evidence = coachEvidence(engine, 'engine', ctx.fen, ctx.fen)
    return {
      streamId: run.streamId,
      text: parsed.answer,
      hint: parsed.hint,
      ...(parsed.explanation ? { explanation: parsed.explanation } : {})
    }
  }

  /**
   * One hint (spec §4.2): structured `{move, reason}`, validated for legality, one retry with the
   * error quoted back, then Stockfish's best move with a reason asked in plain text.
   */
  async hint(
    game: Game,
    ctx: { fen: string; pgn: string }
  ): Promise<{ move: string; uci: string; reason: string; explanation?: CoachExplanation }> {
    const threadId = this.threadId
    if (!threadId) throw new CoachError('COACH_NO_THREAD', 'the coach thread is not open')
    const language = this.language()
    const engine = await this.engineContext(ctx.fen, null)
    if (this.threadId !== threadId)
      throw new CoachError('COACH_NO_THREAD', 'the coach thread is not open')
    let text = hintText({ fen: ctx.fen, pgn: ctx.pgn, engine, language })

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const run = await this.runTurn(game, text, language, {
        threadId,
        outputSchema: HINT_SCHEMA
      })
      if (!run.result.ok) {
        if (run.result.reason === 'quota') this.disabled = true
        if (this.threadId !== threadId)
          throw new CoachError('COACH_NO_THREAD', 'the coach thread is not open')
        break
      }
      const parsed = parseHint(run.result.text, ctx.fen)
      const move = parsed ? normalizeMove(ctx.fen, parsed.move) : null
      if (parsed && move) {
        if (parsed.explanation)
          parsed.explanation.evidence = coachEvidence(engine, 'engine', ctx.fen, ctx.fen)
        return {
          move: move.san,
          uci: move.uci,
          reason: parsed.reason.trim(),
          ...(parsed.explanation ? { explanation: parsed.explanation } : {})
        }
      }
      if (attempt === 2) break
      text = `${text}\n\n${
        language === 'it'
          ? `ERRORE: la risposta precedente (${JSON.stringify(run.result.text.slice(0, 120))}) non è il JSON richiesto o non è una mossa legale in questa posizione. Riprova con una mossa legale.`
          : `ERROR: the previous answer (${JSON.stringify(run.result.text.slice(0, 120))}) is not the requested JSON or is not a legal move in this position. Try again with a legal move.`
      }`
    }

    return this.engineHint(game, ctx, language, threadId)
  }

  // ------------------------------------------------------------------ internals

  /** Coach model and effort: the separate ones when the user asked for them, else the opponent's. */
  private resolve(game: Game): { model: string; effort: string } {
    const settings = this.deps.settings.get()
    if (settings.separateCoach && settings.coachModel) {
      return { model: settings.coachModel, effort: settings.coachEffort ?? game.opponent.effort }
    }
    return { model: game.opponent.model, effort: game.opponent.effort }
  }

  /** The UI language as it is right now: a language changed mid-game applies from the next call. */
  private language(): 'it' | 'en' {
    return this.deps.settings.get().language
  }

  private notify(): void {
    this.onActivity?.({ busy: this.busy, streamId: this.streamIdValue })
  }

  /**
   * One coach turn. The recap of a resumed game is prepended here, so it never costs a call of
   * its own; the `streamId` is published before the turn starts and cleared when it ends.
   */
  private async runTurn(
    game: Game,
    body: string,
    language: 'it' | 'en',
    opts: { threadId: string; outputSchema?: object; signal?: AbortSignal }
  ): Promise<{ streamId: string; result: TurnResult }> {
    const { threadId } = opts
    if (this.threadId !== threadId || opts.signal?.aborted) {
      return {
        streamId: '',
        result: {
          ok: false,
          reason: opts.signal?.aborted ? 'interrupted' : 'failed',
          message: opts.signal?.aborted
            ? 'the coach comment was cancelled'
            : 'the coach thread is not open',
          turnId: null
        }
      }
    }
    const recap = this.pendingRecap
    this.pendingRecap = null
    const text = recap ? `${recap}\n\n${body}` : body

    const streamId = randomUUID()
    const { model, effort } = this.resolve(game)
    this.inFlight += 1
    this.streamIdValue = streamId
    this.notify()

    let streamed = false
    const onAbort = (): void => {
      void this.deps.codex.interrupt(threadId).catch(() => undefined)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const result = await this.deps.codex.runTurn(
        {
          threadId,
          text,
          model,
          effort,
          ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
          language,
          timeoutMs: this.deps.settings.get().turnTimeoutSec * 1000,
          streamId
        },
        (kind) => {
          if (kind === 'text') streamed = true
        }
      )
      // A turn whose text never streamed (no deltas at all) would leave the feed empty: one
      // envelope with the whole answer keeps the renderer's stream handling uniform.
      if (opts.signal?.aborted) {
        return {
          streamId,
          result: {
            ok: false,
            reason: 'interrupted',
            message: 'the coach comment was cancelled',
            turnId: result.turnId
          }
        }
      }
      if (result.ok && !streamed && result.text.trim().length > 0) {
        this.deps.emit('stream', {
          streamId,
          threadId,
          turnId: result.turnId,
          itemId: '',
          kind: 'text',
          chunk: result.text
        })
      }
      return { streamId, result }
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      // `close()` resets the activity counters. A late result from that old thread must not
      // decrement or clear a turn that is already running on a replacement thread.
      if (this.threadId === threadId) {
        this.inFlight = Math.max(0, this.inFlight - 1)
        if (this.streamIdValue === streamId) this.streamIdValue = null
        this.notify()
      }
    }
  }

  /**
   * Stockfish's view of the position the move was played from, plus the score after it.
   * `null` whenever the engine is unavailable or the analysis fails: the oracle-less mode of
   * spec §4.2 is a normal way to run, not an error.
   */
  private async engineContext(
    fenBefore: string,
    fenAfter: string | null,
    profile: 'comment' | 'coach' = 'coach',
    signal?: AbortSignal
  ): Promise<EngineContext | null> {
    if (!this.deps.engine.state().available) return null
    try {
      const analysis = await this.deps.engine.analyze(fenBefore, profile, { signal })
      const bestLines: EngineContext['bestLines'] = []
      for (const line of analysis.lines.slice(0, BEST_LINES)) {
        const rendered = pvInSan(fenBefore, line.pv.length > 0 ? line.pv : [line.move])
        const score = whiteEval(line, fenBefore)
        if (!rendered || !score) continue
        bestLines.push({ ...rendered, eval: score })
      }
      // The score after the move is only worth the cheap live budget: the comment quotes it, the
      // judgement comes from the deeper analysis of the position the move was played from.
      let evalAfter: CoachEval | null = null
      const replyLines: EngineContext['bestLines'] = []
      if (fenAfter) {
        const after = await this.deps.engine.analyze(fenAfter, 'live', { signal })
        evalAfter = whiteEval(after.lines[0], fenAfter)
        const reply = after.lines[0]
        const rendered = reply ? pvInSan(fenAfter, reply.pv.length ? reply.pv : [reply.move]) : null
        if (rendered && evalAfter) replyLines.push({ ...rendered, eval: evalAfter })
      }
      const beforeWinner = terminalWinner(fenBefore)
      const afterWinner = fenAfter ? terminalWinner(fenAfter) : null
      return {
        evalBefore: whiteEval(analysis.lines[0], fenBefore),
        evalAfter,
        bestLines,
        replyLines,
        ...(beforeWinner
          ? { terminal: { winner: beforeWinner, at: 'before' as const } }
          : afterWinner
            ? { terminal: { winner: afterWinner, at: 'after' as const } }
            : {})
      }
    } catch (error) {
      if (signal?.aborted || (error as Error)?.name === 'AbortError') return null
      console.error('[coach] the engine context is unavailable:', error)
      return null
    }
  }

  /** Last resort of `hint()`: the engine picks the move, the coach only explains it. */
  private async engineHint(
    game: Game,
    ctx: { fen: string; pgn: string },
    language: 'it' | 'en',
    threadId: string
  ): Promise<{ move: string; uci: string; reason: string }> {
    if (!this.deps.engine.state().available)
      throw new CoachError('COACH_HINT_FAILED', 'no legal hint could be produced')
    let best: { san: string; uci: string } | null = null
    try {
      const analysis = await this.deps.engine.analyze(ctx.fen, 'coach')
      const uci = analysis.bestMove ?? analysis.lines[0]?.move ?? null
      best = uci ? normalizeMove(ctx.fen, uci) : null
    } catch (error) {
      console.error('[coach] the engine hint failed:', error)
    }
    if (!best) throw new CoachError('COACH_HINT_FAILED', 'no legal hint could be produced')

    const explain =
      language === 'it'
        ? [
            `Spiega in una frase perché ${best.san} è la mossa da giocare in questa posizione.`,
            `FEN: ${ctx.fen}`,
            'Testo semplice, niente JSON.'
          ].join('\n')
        : [
            `Explain in one sentence why ${best.san} is the move to play in this position.`,
            `FEN: ${ctx.fen}`,
            'Plain text, no JSON.'
          ].join('\n')
    const run = await this.runTurn(game, explain, language, { threadId })
    return { move: best.san, uci: best.uci, reason: run.result.ok ? run.result.text.trim() : '' }
  }
}
