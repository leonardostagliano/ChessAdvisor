import { randomUUID } from 'node:crypto'
import { Chess } from 'chess.js'
import { normalizeMove } from '@shared/chess/notation'
import { pgnOf } from '@shared/chess/pgn'
import type { AnalysisProgress, AnalysisStatus, ReviewActivity, ReviewLesson, StreamEnvelope } from '@shared/types/api'
import type { Eval, Game } from '@shared/types/game'
import type { Language } from '@shared/types/settings'
import { coachBaseInstructions, type EngineContext } from '../game/coachPrompts'
import type { SessionCodex, SessionEngine } from '../game/gameSession'
import type { GameStore } from '../store/gameStore'
import type { SettingsStore } from '../store/settingsStore'
import { analyzeGame, START_FEN } from './pipeline'
import { EMPTY_BOOK, loadOpenings, type OpeningBook } from './openings'
import { commentMoveText, keyMomentsCommentText, lessonText, LESSON_SCHEMA } from './reviewPrompts'

/**
 * Owner of the post-game analysis and of the review's AI calls (spec §3.1, §4.4).
 *
 * The pipeline runs once per game — automatically when a match ends, on demand for a game in the
 * archive — and never twice at the same time for the same game. The review's own calls (comment a
 * move, comment the key moments, the lesson of the game) all go through one `training` thread that
 * lives as long as the review is open: the text streams to the renderer on the usual `stream`
 * channel, announced by a `review:activity` event so the screen can subscribe before the first
 * delta arrives.
 */

/** Key moments commented in one go (spec §4.4). */
export const MAX_KEY_MOMENT_COMMENTS = 8
/** Takeaways kept from the lesson, whatever the model answered. */
export const LESSON_TAKEAWAYS = 3
/** Best lines shown to the model when the analysis has not filled the move yet. */
const BEST_LINES = 3
/** Plies of a principal variation written into a prompt. */
const PV_PLIES = 6

/** Carries a machine-readable code through the IPC error contract (`serializeError`). */
export class AnalysisError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'AnalysisError'
  }
}

export interface AnalysisManagerDeps {
  codex: SessionCodex
  engine: SessionEngine
  store: GameStore
  settings: SettingsStore
  emit(channel: 'analysis:progress' | 'review:activity' | 'stream', payload: AnalysisProgress | ReviewActivity | StreamEnvelope): void
  /** Where `openings.json` lives; resolved lazily so a test can point somewhere else. */
  openingsPath(): string
  now?: () => number
}

interface RunningAnalysis {
  promise: Promise<Game>
  ply: number
  total: number
}

const sideToMove = (fen: string): 'w' | 'b' => (fen.split(/\s+/)[1] === 'b' ? 'b' : 'w')

/** Models like to wrap JSON in ``` fences even when the schema forbids prose. */
function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim()
}

/** UCI principal variation rendered in SAN; an unplayable tail is simply dropped. */
function pvInSan(fen: string, pv: string[]): string[] {
  let chess: Chess
  try {
    chess = new Chess(fen)
  } catch {
    return []
  }
  const san: string[] = []
  for (const uci of pv.slice(0, PV_PLIES)) {
    const normalized = normalizeMove(chess.fen(), uci)
    if (!normalized) break
    try {
      san.push(chess.move(normalized.san).san)
    } catch {
      break
    }
  }
  return san
}

function whiteEval(line: { scoreCp?: number; scoreMate?: number } | undefined, fen: string): Eval | null {
  if (!line) return null
  const flip = sideToMove(fen) === 'b' ? -1 : 1
  if (typeof line.scoreMate === 'number') return { mate: flip * line.scoreMate }
  if (typeof line.scoreCp === 'number') return { cp: flip * line.scoreCp }
  return null
}

/** Turns an evaluation stored from the mover's point of view back into White's. */
function toWhite(value: Eval | undefined, mover: 'w' | 'b'): Eval | null {
  if (!value) return null
  if (mover === 'w') return { ...value }
  if (typeof value.mate === 'number') return { mate: -value.mate }
  if (typeof value.cp === 'number') return { cp: -value.cp }
  return null
}

export class AnalysisManager {
  private book: OpeningBook | null = null
  private readonly running = new Map<string, RunningAnalysis>()
  /** The `training` thread of the open review, and the game it belongs to. */
  private review: { gameId: string; threadId: string } | null = null
  private inFlight = 0

  constructor(private readonly deps: AnalysisManagerDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private language(): Language {
    return this.deps.settings.get().language
  }

  /** Coach model and effort: the separate ones when the user asked for them, else the game's. */
  private resolveModel(game: Game): { model: string; effort: string } {
    const settings = this.deps.settings.get()
    if (settings.separateCoach && settings.coachModel) {
      return { model: settings.coachModel, effort: settings.coachEffort ?? game.coach.effort }
    }
    return { model: game.coach.model || game.opponent.model, effort: game.coach.effort || game.opponent.effort }
  }

  private openings(): OpeningBook {
    if (!this.book) {
      try {
        this.book = loadOpenings(this.deps.openingsPath())
      } catch (error) {
        console.error('[analysis] the openings dataset could not be loaded:', error)
        this.book = EMPTY_BOOK
      }
    }
    return this.book
  }

  // ------------------------------------------------------------------ pipeline

  /** Hook of `game:finished`: a finished match is analysed by itself, in the background. */
  onGameFinished(game: Game): void {
    if (game.kind !== 'match') return
    void this.run(game.id).catch((error) => console.error('[analysis] the automatic analysis failed:', error))
  }

  async status(gameId: string): Promise<AnalysisStatus> {
    const current = this.running.get(gameId)
    if (current) return { state: 'running', ply: current.ply, total: current.total }
    if (!this.deps.engine.state().available) return { state: 'unavailable' }
    const game = await this.deps.store.get(gameId)
    return game?.analysis ? { state: 'done', ply: game.moves.length, total: game.moves.length } : { state: 'idle' }
  }

  /**
   * Analyses the game and saves the result. A second call while the first one is running joins it
   * instead of starting a second search: the engine queue is serial, and the file would be written
   * twice with the same numbers.
   */
  run(gameId: string): Promise<Game> {
    const current = this.running.get(gameId)
    if (current) return current.promise
    if (!this.deps.engine.state().available) {
      return Promise.reject(new AnalysisError('ANALYSIS_UNAVAILABLE', this.deps.engine.state().message ?? 'the chess engine is not available'))
    }

    const entry: RunningAnalysis = { promise: Promise.resolve(null as unknown as Game), ply: 0, total: 0 }
    const work = (async () => {
      const game = await this.deps.store.get(gameId)
      if (!game) throw new AnalysisError('GAME_NOT_FOUND', `no game ${gameId}`)
      entry.total = game.moves.length
      this.deps.emit('analysis:progress', { gameId, ply: 0, total: entry.total })

      const analysed = await analyzeGame(
        game,
        this.deps.engine,
        this.openings(),
        (progress) => {
          entry.ply = progress.ply
          this.deps.emit('analysis:progress', progress)
        },
        { now: () => this.now() }
      )
      await this.deps.store.save(analysed)
      return analysed
    })()
    // Every caller — the one that started the run and the ones that joined it — waits on the very
    // same promise, so a second `run()` can never start a second search for the same game.
    entry.promise = work.finally(() => {
      this.running.delete(gameId)
    })
    this.running.set(gameId, entry)
    return entry.promise
  }

  // ------------------------------------------------------------------ review turns

  /** Opens (or reuses) the `training` thread of the review of `game`. */
  private async ensureThread(game: Game): Promise<string> {
    if (this.review && this.review.gameId === game.id) return this.review.threadId
    await this.close()
    const { model } = this.resolveModel(game)
    const threadId = await this.deps.codex.startThread('training', {
      model,
      baseInstructions: coachBaseInstructions({
        language: this.language(),
        userColor: game.userColor,
        engineAvailable: this.deps.engine.state().available
      }),
      gameId: game.id
    })
    this.review = { gameId: game.id, threadId }
    return threadId
  }

  /** Closes the review thread; the next call opens a new one. */
  async close(): Promise<void> {
    const review = this.review
    this.review = null
    if (!review) return
    if (this.inFlight > 0) await this.deps.codex.interrupt(review.threadId).catch(() => undefined)
    await this.deps.codex.closeThread(review.threadId).catch(() => undefined)
  }

  get busy(): boolean {
    return this.inFlight > 0
  }

  /**
   * One review turn. The `streamId` is announced on `review:activity` before the turn starts, so
   * the screen can attach to the deltas; a turn that never streams gets one envelope with the
   * whole answer, exactly like the coach's.
   */
  private async runTurn(
    game: Game,
    body: string,
    activity: { kind: ReviewActivity['kind']; ply: number | null },
    outputSchema?: object
  ): Promise<string> {
    const threadId = await this.ensureThread(game)
    const language = this.language()
    const { model, effort } = this.resolveModel(game)
    const streamId = randomUUID()

    this.inFlight += 1
    this.deps.emit('review:activity', { gameId: game.id, kind: activity.kind, ply: activity.ply, streamId, busy: true })

    let streamed = false
    try {
      const result = await this.deps.codex.runTurn(
        {
          threadId,
          text: body,
          model,
          effort,
          ...(outputSchema ? { outputSchema } : {}),
          language,
          timeoutMs: this.deps.settings.get().turnTimeoutSec * 1000,
          streamId
        },
        (kind) => {
          if (kind === 'text') streamed = true
        }
      )
      if (!result.ok) throw new AnalysisError('REVIEW_TURN_FAILED', result.message)
      if (!streamed && !outputSchema && result.text.trim().length > 0) {
        this.deps.emit('stream', { streamId, threadId, turnId: result.turnId, itemId: '', kind: 'text', chunk: result.text })
      }
      return result.text.trim()
    } finally {
      this.inFlight = Math.max(0, this.inFlight - 1)
      this.deps.emit('review:activity', { gameId: game.id, kind: activity.kind, ply: activity.ply, streamId: null, busy: this.inFlight > 0 })
    }
  }

  // ------------------------------------------------------------------ review calls

  private async requireGame(gameId: string): Promise<Game> {
    const game = await this.deps.store.get(gameId)
    if (!game) throw new AnalysisError('GAME_NOT_FOUND', `no game ${gameId}`)
    return game
  }

  /** Position a ply was played from. */
  private fenBefore(game: Game, ply: number): string {
    const previous = game.moves[ply - 2]
    return previous ? previous.fenAfter : (game.startFen ?? START_FEN)
  }

  private pgnUpTo(game: Game, plies?: number): string {
    const moves = typeof plies === 'number' ? game.moves.slice(0, plies) : game.moves
    return pgnOf(moves, game.startFen ? { startFen: game.startFen } : undefined)
  }

  /**
   * What the model is told about the engine's view of a ply: the numbers the pipeline already
   * saved when the game has been analysed, a fresh `coach` search when it has not, and `null`
   * when there is no engine at all (the oracle-less mode of spec §4.2).
   */
  private async engineContext(game: Game, ply: number): Promise<EngineContext | null> {
    const move = game.moves[ply - 1]
    if (!move) return null
    const fenBefore = this.fenBefore(game, ply)
    const mover = sideToMove(fenBefore)

    const saved = move.eval
    if (saved) {
      const bestSan = pvInSan(fenBefore, saved.bestLine.length > 0 ? saved.bestLine : [saved.bestMove])
      const before = toWhite(saved.before, mover)
      return {
        evalBefore: before,
        evalAfter: toWhite(saved.after, mover),
        classification: saved.classification,
        bestLines: bestSan.length > 0 ? [{ san: bestSan[0]!, pv: bestSan, eval: before ?? {} }] : []
      }
    }

    if (!this.deps.engine.state().available) return null
    try {
      const analysis = await this.deps.engine.analyze(fenBefore, 'coach')
      const bestLines: EngineContext['bestLines'] = []
      for (const line of analysis.lines.slice(0, BEST_LINES)) {
        const san = pvInSan(fenBefore, line.pv.length > 0 ? line.pv : [line.move])
        const score = whiteEval(line, fenBefore)
        if (san.length === 0 || !score) continue
        bestLines.push({ san: san[0]!, pv: san, eval: score })
      }
      const after = await this.deps.engine.analyze(move.fenAfter, 'live').catch(() => null)
      return {
        evalBefore: whiteEval(analysis.lines[0], fenBefore),
        evalAfter: after ? whiteEval(after.lines[0], move.fenAfter) : null,
        bestLines
      }
    } catch (error) {
      console.error('[analysis] the engine context is unavailable:', error)
      return null
    }
  }

  private async comment(game: Game, ply: number, text: string, kind: ReviewActivity['kind']): Promise<string> {
    const move = game.moves[ply - 1]
    if (!move) throw new AnalysisError('BAD_PLY', `ply ${ply} is not part of game ${game.id}`)
    const language = this.language()
    const answer = await this.runTurn(game, text, { kind, ply })
    if (answer.length === 0) throw new AnalysisError('REVIEW_EMPTY_ANSWER', 'the review answered with an empty comment')
    move.coachComment = answer
    move.coachCommentLanguage = language
    return answer
  }

  /** "Commenta questa mossa" (spec §4.4); the text is saved on the move itself. */
  async commentMove(gameId: string, ply: number): Promise<string> {
    const game = await this.requireGame(gameId)
    const move = game.moves[ply - 1]
    if (!move) throw new AnalysisError('BAD_PLY', `ply ${ply} is not part of game ${gameId}`)
    const text = commentMoveText({
      move,
      fenBefore: this.fenBefore(game, ply),
      fenAfter: move.fenAfter,
      pgn: this.pgnUpTo(game, ply),
      engine: await this.engineContext(game, ply),
      language: this.language(),
      userColor: game.userColor
    })
    const answer = await this.comment(game, ply, text, 'move')
    await this.deps.store.save(game)
    return answer
  }

  /** "Commenta i momenti chiave": one call per moment, at most {@link MAX_KEY_MOMENT_COMMENTS}. */
  async commentKeyMoments(gameId: string): Promise<{ ply: number; text: string }[]> {
    const game = await this.requireGame(gameId)
    const plies = (game.analysis?.keyMoments ?? []).filter((ply) => Boolean(game.moves[ply - 1])).slice(0, MAX_KEY_MOMENT_COMMENTS)
    const comments: { ply: number; text: string }[] = []
    for (const [index, ply] of plies.entries()) {
      const move = game.moves[ply - 1]!
      const text = keyMomentsCommentText({
        move,
        fenBefore: this.fenBefore(game, ply),
        fenAfter: move.fenAfter,
        pgn: this.pgnUpTo(game, ply),
        engine: await this.engineContext(game, ply),
        language: this.language(),
        userColor: game.userColor,
        index: index + 1,
        count: plies.length
      })
      comments.push({ ply, text: await this.comment(game, ply, text, 'keyMoments') })
    }
    if (comments.length > 0) await this.deps.store.save(game)
    return comments
  }

  /**
   * "Lezione della partita" (spec §4.4): three takeaways and a summary, clamped on this side.
   * It is saved into `Game.analysis.lesson`; a game that has never been analysed still gets its
   * lesson, it simply has nowhere to keep it.
   */
  async lesson(gameId: string): Promise<ReviewLesson> {
    const game = await this.requireGame(gameId)
    const language = this.language()
    const text = lessonText({ game, language, pgn: this.pgnUpTo(game) })
    const answer = await this.runTurn(game, text, { kind: 'lesson', ply: null }, LESSON_SCHEMA)

    let parsed: unknown
    try {
      parsed = JSON.parse(stripFences(answer))
    } catch {
      throw new AnalysisError('LESSON_INVALID', 'the lesson did not come back as JSON')
    }
    const record = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>
    const takeaways = (Array.isArray(record.takeaways) ? record.takeaways : [])
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map((entry) => entry.trim())
      .slice(0, LESSON_TAKEAWAYS)
    const summary = typeof record.summary === 'string' ? record.summary.trim() : ''
    if (takeaways.length === 0 && summary.length === 0) throw new AnalysisError('LESSON_INVALID', 'the lesson came back empty')

    const lesson: ReviewLesson = { takeaways, summary, language }
    if (game.analysis) {
      game.analysis.lesson = lesson
      await this.deps.store.save(game)
    }
    return lesson
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandleFn = <T>(channel: string, fn: (...args: any[]) => Promise<T>) => void

export interface RegisterAnalysisIpcDeps {
  handle: HandleFn
  manager: AnalysisManager
}

const gameId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) throw new AnalysisError('BAD_GAME_ID', 'a game id is required')
  return value
}

const plyNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) throw new AnalysisError('BAD_PLY', 'a ply number is required')
  return Math.round(value)
}

/** Binds the `analysis` and `review` namespaces of `window.api`. */
export function registerAnalysisIpc(deps: RegisterAnalysisIpcDeps): void {
  deps.handle('analysis:run', async (id: unknown): Promise<Game> => deps.manager.run(gameId(id)))
  deps.handle('analysis:status', async (id: unknown): Promise<AnalysisStatus> => deps.manager.status(gameId(id)))
  deps.handle('review:commentMove', async (id: unknown, ply: unknown): Promise<string> => deps.manager.commentMove(gameId(id), plyNumber(ply)))
  deps.handle('review:commentKeyMoments', async (id: unknown): Promise<{ ply: number; text: string }[]> => deps.manager.commentKeyMoments(gameId(id)))
  deps.handle('review:lesson', async (id: unknown): Promise<ReviewLesson> => deps.manager.lesson(gameId(id)))
  deps.handle('review:close', async (): Promise<void> => deps.manager.close())
}
