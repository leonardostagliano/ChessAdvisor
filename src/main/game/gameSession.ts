import { randomUUID } from 'node:crypto'
import { applyMove, epdOf, gameStatus, legalMoves } from '@shared/chess/notation'
import { pgnOf } from '@shared/chess/pgn'
import type { StreamEnvelope } from '@shared/types/api'
import type { CoachLogEntry, Game, GameResult, Move } from '@shared/types/game'
import type { Language } from '@shared/types/settings'
import {
  DIFFICULTY_LEVELS,
  nearestLevel,
  type ClockConfig,
  type CoachState,
  type DifficultyChoice,
  type NewGameOptions,
  type OpponentDifficulty,
  type SessionState
} from '@shared/types/session'
import { EMPTY_BOOK, loadOpenings, type OpeningBook } from '../analysis/openings'
import type { CodexService } from '../codex/codexService'
import type { EngineService } from '../engine/engineService'
import type { GameStore } from '../store/gameStore'
import type { ProfileStore } from '../store/profileStore'
import type { SettingsStore } from '../store/settingsStore'
import { GameClock } from './clock'
import { CoachSession, type CoachActivity } from './coach'
import { OpponentTurnError, playOpponentTurn } from './opponentTurn'
import { LiveMoveEvaluator } from './liveMoveEvaluator'
import { DRAW_OFFER_SCHEMA, drawOfferText, opponentBaseInstructions } from './prompts'

/**
 * The one active game (spec §4.3).
 *
 * It owns the position, the opponent thread, the autosave and the live eval, and publishes the
 * whole play screen as a single {@link SessionState} on `game:state` after every transition: the
 * renderer never computes chess state of its own. Everything that can go wrong during an AI turn
 * ends either in a fallback move (see {@link playOpponentTurn}) or in `status:'error'`; the game
 * on disk always stays consistent with what the user sees.
 */

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

/** Adaptive difficulty (spec §4.1): step per result, doubled while the rating is still new. */
const ADAPTIVE_STEP = { win: 75, draw: 25, loss: -75 }
const ADAPTIVE_DOUBLE_UNTIL_GAMES = 3
const ADAPTIVE_MIN_ELO = 500
const ADAPTIVE_MAX_ELO = 2400
const ADAPTIVE_START_ELO = 1200

/** The slices of the two services the session uses; the real ones satisfy them as they are. */
export type SessionCodex = Pick<
  CodexService,
  'startThread' | 'runTurn' | 'interrupt' | 'closeThread' | 'models'
>
export type SessionEngine = Pick<EngineService, 'analyze' | 'state'>

export interface GameFinishedEvent {
  gameId: string
  result: GameResult
}

export interface GameSessionDeps {
  codex: SessionCodex
  engine: SessionEngine
  /** Separate workers keep interactive searches independent of coach/review work. */
  feedbackEngine?: SessionEngine
  opponentEngine?: SessionEngine
  /** Optional local opening dataset, loaded only when the opponent first needs it. */
  openingsPath?(): string
  store: GameStore
  settings: SettingsStore
  /** Adaptive difficulty reads and writes `profile.json` through this store. */
  profile: ProfileStore
  /** `stream` carries the coach deltas straight to the renderer (spec §4.2). */
  emit(
    channel: 'game:state' | 'game:finished' | 'stream',
    payload: SessionState | GameFinishedEvent | StreamEnvelope
  ): void
  /**
   * M3 hook of `game:finished`: the analysis pipeline starts itself when a match ends (spec §3.1).
   * `game:finished` is an event for the renderer, so the main process needs a call of its own;
   * it is fire-and-forget by contract — a failing analysis never touches the game.
   */
  onFinished?(game: Game): void
  now(): number
}

/** Carries a machine-readable code through the IPC error contract (`serializeError`). */
export class GameError extends Error {
  /**
   * Structured payload for the renderer. Electron keeps only name/message/stack of a rejection,
   * so `serializeError` hands this to `IpcError`, which encodes it into the message for
   * `parseIpcError` to read back: the dialog gets the model id, never a scraped string.
   */
  readonly data?: Record<string, unknown>

  constructor(
    readonly code: string,
    message: string,
    /** Model proposed by a `MODEL_UNAVAILABLE` failure, so the renderer can prefill the dialog. */
    readonly suggested?: string
  ) {
    super(message)
    this.name = 'GameError'
    if (suggested) this.data = { suggested }
  }
}

const idleAi = (): SessionState['ai'] => ({
  thinking: false,
  startedAt: null,
  reasoning: '',
  retries: 0,
  streamId: null
})

/** Cap of the "Commenta le mosse saltate" button (spec §4.2). */
export const MAX_SKIPPED_COMMENTS = 6
/** Entries of the coach log the recreated coach thread receives on resume (spec §4.2). */
const RESUME_RECAP_ENTRIES = 10
/** How long `close()` waits for an interrupted comment before walking away from it. */
const COMMENT_SETTLE_MS = 2000
/** How often a running clock republishes the state; the renderer interpolates in between. */
const CLOCK_TICK_MS = 1000
/** Grace the opponent turn gets on top of its remaining time before it is cut off (spec §4.3). */
const CLOCK_TURN_GRACE_MS = 2000

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** The clock a new game is saved with: both sides start on the full initial time. */
function initialClock(cfg: ClockConfig | null | undefined): Game['clock'] {
  if (!cfg || !(cfg.initialMs > 0)) return null
  const initialMs = Math.round(cfg.initialMs)
  return {
    initialMs,
    incrementMs: Math.max(0, Math.round(cfg.incrementMs)),
    aiClock: cfg.aiClock === true,
    remainingMs: { w: initialMs, b: initialMs }
  }
}

export class GameSession {
  private game: Game | null = null
  private threadId: string | null = null
  private status: SessionState['status'] = 'idle'
  private error: string | null = null
  private ai: SessionState['ai'] = idleAi()
  private liveEvalValue: SessionState['liveEval'] = null
  /** Plies removed by the last takeback, told to the opponent in its next turn text. */
  private pendingTakebackNotice: number | null = null
  private showReasoning = false
  private commentsVisible = true
  /** The coach thread of the running game; it never blocks a move (spec §4.2). */
  private readonly coach: CoachSession
  private coachActivity: CoachActivity = { busy: false, streamId: null }
  private coachHint: CoachState['hint'] = null
  private coachAnswer: CoachState['lastAnswer'] = null
  /** Clocks of the running game (spec §4.3); `null` when the game is played without them. */
  private clock: GameClock | null = null
  /** Republishes the state while a clock runs; owned here, cleared on stop and on close. */
  private ticker: NodeJS.Timeout | null = null
  /** Guards against a second expiry landing while the first one is still finishing the game. */
  private expiring = false
  /** Plies pushed while comments were visible and not commented yet, in order. */
  private pendingComments: number[] = []
  /** Comments run one at a time, behind the moves: the AI turn never waits for one. */
  private commentChain: Promise<void> = Promise.resolve()
  /** The one comment currently preparing or streaming; used to cancel positions that disappear. */
  private activeComment: {
    gameId: string
    ply: number
    uci: string
    controller: AbortController
  } | null = null
  /** Invalidates comment closures already moved from `pendingComments` into the promise chain. */
  private commentQueueEpoch = 0
  /**
   * Bumped whenever a running AI turn stops being relevant (takeback, resign, new game, close).
   * The turn that comes back with a stale epoch is dropped instead of landing on the board.
   */
  private turnEpoch = 0
  /** Monotonic board identity: equal FEN and ply after a replay must still reject old results. */
  private positionRevision = 0
  private evalRequest = 0
  private opponentController: AbortController | null = null
  private openingBook: OpeningBook | null = null
  private readonly feedback: LiveMoveEvaluator
  private readonly feedbackTasks = new Set<Promise<void>>()

  constructor(private readonly deps: GameSessionDeps) {
    this.feedback = new LiveMoveEvaluator(deps.feedbackEngine ?? deps.engine)
    let feedbackEnabled = deps.settings.get().liveMoveFeedback
    deps.settings.onChange((settings) => {
      const enabledNow = settings.liveMoveFeedback
      if (enabledNow && !feedbackEnabled && this.game?.status === 'in_progress') {
        const move = this.game.moves.at(-1)
        if (move && !move.liveEval)
          this.gradeMove(this.game, this.fenBefore(this.game, move.ply), move)
      }
      feedbackEnabled = enabledNow
    })
    this.coach = new CoachSession({
      codex: deps.codex,
      engine: deps.engine,
      settings: deps.settings,
      emit: (channel, payload) => deps.emit(channel, payload),
      now: deps.now
    })
    // The renderer must know the stream id before the deltas of that turn arrive.
    this.coach.onActivity = (activity) => {
      this.coachActivity = activity
      this.emitState()
    }
  }

  // ------------------------------------------------------------------ reading

  /** Position on the board: the last move played, or the starting position of the game. */
  private fen(): string {
    const game = this.game
    if (!game) return START_FEN
    const last = game.moves[game.moves.length - 1]
    return last ? last.fenAfter : (game.startFen ?? START_FEN)
  }

  private sideToMove(fen: string): 'w' | 'b' {
    return fen.split(/\s+/)[1] === 'b' ? 'b' : 'w'
  }

  state(): SessionState {
    const fen = this.fen()
    const turn = this.sideToMove(fen)
    return {
      game: this.game,
      fen,
      legal: this.status === 'playing' ? legalMoves(fen) : [],
      turn,
      userToMove:
        this.status === 'playing' &&
        this.game !== null &&
        turn === this.game.userColor &&
        !this.ai.thinking,
      ai: { ...this.ai },
      liveEval: this.liveEvalValue ? { ...this.liveEvalValue } : null,
      status: this.status,
      error: this.error,
      clock: this.clock ? this.clock.snapshot() : null,
      coach: {
        commentsVisible: this.commentsVisible,
        busy: this.coachActivity.busy,
        streamId: this.coachActivity.streamId,
        hint: this.coachHint ? { ...this.coachHint } : null,
        lastAnswer: this.coachAnswer ? { ...this.coachAnswer } : null
      }
    }
  }

  isBusy(): boolean {
    return this.ai.thinking
  }

  /** Session preferences chosen in the new-game dialog; the coach feed of M2 reads them. */
  preferences(): { showReasoning: boolean; commentsVisible: boolean } {
    return { showReasoning: this.showReasoning, commentsVisible: this.commentsVisible }
  }

  /** Current adaptive rating, for the new-game dialog. `null` before the first adaptive game. */
  adaptiveElo(): { elo: number; games: number } | null {
    const adaptive = this.deps.profile.get().adaptive
    return adaptive ? { elo: adaptive.elo, games: adaptive.games } : null
  }

  private emitState(): void {
    this.syncClock()
    this.deps.emit('game:state', this.state())
  }

  private requireGame(): Game {
    if (!this.game) throw new GameError('NO_GAME', 'no game is running')
    return this.game
  }

  // ------------------------------------------------------------------ lifecycle

  /** Creates the game, its opponent thread and, when the AI has White, its first move. */
  async newGame(opts: NewGameOptions): Promise<SessionState> {
    await this.close()

    const kind = opts.kind ?? 'match'
    const userColor =
      opts.userColor === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : opts.userColor
    const difficulty = this.resolveDifficulty(opts.difficulty, kind)

    const game = await this.deps.store.create({
      kind,
      userColor,
      opponent: { model: opts.model, effort: opts.effort, difficulty },
      coach: { model: opts.coach.model, effort: opts.coach.effort },
      clock: initialClock(opts.clock),
      language: opts.language,
      ...(opts.startFen ? { startFen: opts.startFen } : {})
    })

    // The dialog reopens on the same choices next time (spec §4.3). Only a real match writes them:
    // an endgame drill is started from the training screen with a difficulty of its own (level 6,
    // see `resolveDifficulty`) and must not overwrite what the user chose for their games.
    if (kind === 'match') {
      await this.deps.settings
        .save({
          defaultModel: opts.model,
          defaultEffort: opts.effort,
          lastDifficulty: { ...opts.difficulty }
        })
        .catch((error) => console.error('[game] the new-game choices could not be saved:', error))
    }

    this.game = game
    this.buildClock(game)
    this.showReasoning = opts.showReasoning
    this.commentsVisible = opts.commentsVisible
    this.pendingTakebackNotice = null
    this.liveEvalValue = null
    this.error = null
    this.status = 'playing'
    await this.openThread()
    await this.openCoach(opts.language)
    this.emitState()

    await this.runEval(this.fen())
    if (!this.state().userToMove) await this.aiMove()
    return this.state()
  }

  /**
   * Difficulty of a new game (spec §4.1). Endgame drills always play at level 6: a drill exists
   * to be solved against best play, not against a plausible 900.
   */
  private resolveDifficulty(choice: DifficultyChoice, kind: Game['kind']): OpponentDifficulty {
    if (kind === 'endgame_drill') return { mode: 'fixed', level: 6, targetElo: null }
    if (choice.mode === 'adaptive') {
      const elo = this.deps.profile.get().adaptive?.elo ?? ADAPTIVE_START_ELO
      return { mode: 'adaptive', level: nearestLevel(elo), targetElo: elo }
    }
    return { mode: 'fixed', level: choice.level, targetElo: DIFFICULTY_LEVELS[choice.level].elo }
  }

  /** The optional database is immutable and shared by every turn of this session. */
  private openings(): OpeningBook {
    if (this.openingBook) return this.openingBook
    this.openingBook = this.deps.openingsPath ? loadOpenings(this.deps.openingsPath()) : EMPTY_BOOK
    return this.openingBook
  }

  /** Codex threads are ephemeral: every game and every resume starts a brand new one. */
  private async openThread(): Promise<void> {
    const game = this.requireGame()
    const aiColor = game.userColor === 'w' ? 'b' : 'w'
    this.threadId = await this.deps.codex.startThread('opponent', {
      model: game.opponent.model,
      baseInstructions: opponentBaseInstructions({
        color: aiColor,
        difficulty: game.opponent.difficulty,
        language: game.language
      }),
      gameId: game.id
    })
  }

  /**
   * Reopens a saved game. The model and the effort are validated against the live catalogue:
   * a missing model needs the user's decision (`MODEL_UNAVAILABLE`), a missing effort silently
   * falls back to the model's default (spec §4.3).
   */
  async resume(gameId: string, opts?: { substituteModel?: string }): Promise<SessionState> {
    const game = await this.deps.store.get(gameId)
    if (!game) throw new GameError('GAME_NOT_FOUND', `no game with id ${gameId}`)
    await this.close()

    const models = this.deps.codex.models()
    const suggested = models.find((model) => model.isDefault)?.id ?? models[0]?.id
    const substitute = opts?.substituteModel
    if (substitute && substitute !== game.opponent.model) {
      if (models.length > 0 && !models.some((model) => model.id === substitute)) {
        throw new GameError(
          'MODEL_UNAVAILABLE',
          `the model ${substitute} is not available; suggested: ${suggested ?? 'none'}`,
          suggested
        )
      }
      game.opponent.substitutedFrom = game.opponent.model
      game.opponent.model = substitute
    }

    const known = models.find((model) => model.id === game.opponent.model)
    if (!known && models.length > 0) {
      throw new GameError(
        'MODEL_UNAVAILABLE',
        `the model ${game.opponent.model} is no longer available; suggested: ${suggested ?? 'none'}`,
        suggested
      )
    }
    if (known && !known.efforts.some((effort) => effort.id === game.opponent.effort)) {
      game.opponent.effort = known.defaultEffort
    }
    await this.deps.store.save(game)

    this.game = game
    // The clocks resume where the last committed move left them (spec §4.3).
    this.buildClock(game)
    this.showReasoning = this.deps.settings.get().showReasoning
    this.commentsVisible = true
    this.pendingTakebackNotice = null
    this.liveEvalValue = null
    this.error = null
    if (game.status === 'finished') {
      this.status = 'finished'
      this.emitState()
      return this.state()
    }

    this.status = 'playing'
    await this.openThread()
    // Codex threads are ephemeral: the coach comes back with a recap of what it already said.
    await this.openCoach(
      this.deps.settings.get().language,
      game.coachLog.slice(-RESUME_RECAP_ENTRIES)
    )
    this.emitState()
    await this.runEval(this.fen())
    if (!this.state().userToMove) await this.aiMove()
    return this.state()
  }

  /**
   * Opens the coach thread of the current game (spec §4.2). A coach that cannot start is a
   * missing feature, never a failed game: the comments simply stay empty.
   */
  private async openCoach(language: Language, recap?: CoachLogEntry[]): Promise<void> {
    const game = this.requireGame()
    this.commentQueueEpoch += 1
    this.pendingComments = []
    this.coachHint = null
    this.coachAnswer = null
    try {
      await this.coach.start(game, { language, ...(recap && recap.length > 0 ? { recap } : {}) })
    } catch (error) {
      console.error('[game] the coach thread could not be opened:', error)
    }
  }

  /** Unsubscribes the thread and forgets the game; the game stays `in_progress` on disk. */
  async close(): Promise<void> {
    this.opponentController?.abort()
    this.feedback.reset()
    this.evalRequest += 1
    this.turnEpoch += 1
    this.positionRevision += 1
    await this.settleFeedback()
    this.commentQueueEpoch += 1
    this.pendingComments = []
    this.activeComment?.controller.abort()
    await this.coach
      .close()
      .catch((error) => console.error('[game] closing the coach failed:', error))
    // The interrupted comment must be given the chance to notice: a write landing after the game
    // has been forgotten would hit the next game's file (or none at all).
    await this.settleComments()
    if (this.game) await this.autosave(this.game)
    const threadId = this.threadId
    this.threadId = null
    if (threadId) {
      if (this.ai.thinking) await this.deps.codex.interrupt(threadId).catch(() => undefined)
      await this.deps.codex.closeThread(threadId).catch(() => undefined)
    }
    this.stopTicker()
    this.clock = null
    this.game = null
    this.status = 'idle'
    this.error = null
    this.ai = idleAi()
    this.liveEvalValue = null
    this.pendingTakebackNotice = null
    this.coachHint = null
    this.coachAnswer = null
    this.emitState()
  }

  // ------------------------------------------------------------------ moves

  async userMove(uci: string): Promise<SessionState> {
    const game = this.requireGame()
    if (this.status !== 'playing')
      throw new GameError('GAME_NOT_PLAYING', `the game is ${this.status}`)
    if (this.ai.thinking) throw new GameError('AI_THINKING', 'the opponent is still thinking')
    const fen = this.fen()
    if (this.sideToMove(fen) !== game.userColor)
      throw new GameError('NOT_YOUR_TURN', 'it is not your turn')

    const applied = applyMove(fen, uci)
    if (!applied) throw new GameError('ILLEGAL_MOVE', `${uci} is not legal in ${fen}`)

    // The arrow belongs to the position the user has just left (spec §4.2).
    this.coachHint = null
    this.pushMove(game, { san: applied.san, uci, fenAfter: applied.fen, by: 'user' })
    await this.autosave(game)
    this.emitState()

    if (await this.checkEnd()) {
      this.flushComments()
      return this.state()
    }
    if (await this.checkTimeout()) {
      this.flushComments()
      return this.state()
    }
    const evalTask = this.runEval(this.fen())
    // Queue the comment as soon as the move is committed. Stockfish's already-started live
    // request keeps priority, while the independent coach/model work overlaps the opponent turn.
    this.flushComments()
    await evalTask
    await this.aiMove()
    return this.state()
  }

  /** One opponent turn, from the "sta pensando…" state to the move on the board. */
  async aiMove(): Promise<void> {
    const game = this.game
    if (!game || this.status !== 'playing' || this.ai.thinking) return
    const fen = this.fen()
    if (this.sideToMove(fen) === game.userColor) return
    if (!this.threadId) throw new GameError('NO_THREAD', 'the opponent thread is not open')

    this.opponentController?.abort()
    const controller = new AbortController()
    this.opponentController = controller
    const epoch = (this.turnEpoch += 1)
    const streamId = randomUUID()
    this.ai = { thinking: true, startedAt: this.deps.now(), reasoning: '', retries: 0, streamId }
    this.emitState()

    const notice = this.pendingTakebackNotice
    this.pendingTakebackNotice = null
    const lastMove = game.moves[game.moves.length - 1]

    try {
      const move = await playOpponentTurn(
        {
          codex: this.deps.codex,
          engine: this.deps.opponentEngine ?? this.deps.engine,
          now: this.deps.now
        },
        {
          threadId: this.threadId,
          difficulty: game.opponent.difficulty,
          difficultySeed: `${game.id}:${game.moves.length}:${fen}`,
          openingBook: this.openings(),
          allowResign: game.kind === 'match',
          signal: controller.signal,
          model: game.opponent.model,
          effort: game.opponent.effort,
          language: game.language,
          fen,
          pgn: pgnOf(game.moves, game.startFen ? { startFen: game.startFen } : undefined),
          lastUserMove: lastMove?.by === 'user' ? lastMove.san : null,
          takebackNotice: notice,
          timeoutMs: this.turnTimeoutMs(game),
          streamId,
          onDelta: (kind, delta) => {
            if (kind !== 'reasoning' || !this.showReasoning || epoch !== this.turnEpoch) return
            this.ai = { ...this.ai, reasoning: this.ai.reasoning + delta }
            this.emitState()
          },
          onRetry: (attempt) => {
            if (epoch !== this.turnEpoch) return
            this.ai = { ...this.ai, retries: attempt }
            this.emitState()
          }
        }
      )
      // A takeback, a resign or a new game happened while the model was answering.
      if (epoch !== this.turnEpoch) return

      if (move.resign) {
        await this.finish({ outcome: game.userColor === 'w' ? '1-0' : '0-1', reason: 'resign' })
        return
      }
      const applied = applyMove(fen, move.uci)
      if (!applied) {
        this.fail(`the opponent answered with ${move.uci}, which is not legal in ${fen}`)
        return
      }
      // Only the attempt that produced this move is charged; the retries are given back.
      this.clock?.chargeAi(move.thinkingMs)
      this.coachHint = null
      this.pushMove(game, {
        san: applied.san,
        uci: move.uci,
        fenAfter: applied.fen,
        by: 'ai',
        thinkingMs: move.thinkingMs,
        thinkingOverheadMs: move.overheadMs,
        ...(move.effectiveModel ? { effectiveModel: move.effectiveModel } : {}),
        ...(move.fallback ? { fallback: move.fallback } : {}),
        engineAssisted: move.engineAssisted,
        engineVerified: move.engineVerified,
        ...(move.shortComment ? { aiShortComment: move.shortComment } : {})
      })
      this.ai = idleAi()
      await this.autosave(game)
      this.emitState()
      if (await this.checkEnd()) {
        this.flushComments()
        return
      }
      // Spec §4.3: the flag is also checked when a turn completes, not only on the tick.
      if (await this.checkTimeout()) {
        this.flushComments()
        return
      }
      const evalTask = this.runEval(this.fen())
      // Start the live analysis synchronously, then release the comment queue before waiting.
      // This keeps the board/eval responsive without putting the model behind this await.
      this.flushComments()
      await evalTask
    } catch (error) {
      if (epoch !== this.turnEpoch) return
      this.ai = idleAi()
      if (error instanceof OpponentTurnError && error.reason === 'interrupted') {
        // The turn was cancelled on purpose: whoever cancelled it already fixed the state.
        this.emitState()
        return
      }
      this.fail(error instanceof Error ? error.message : String(error))
    }
  }

  private pushMove(game: Game, move: Omit<Move, 'ply' | 'epdAfter'>): void {
    const beforeFen = this.fen()
    const ply = game.moves.length + 1
    // The increment belongs to the move that has just been validated, final move included.
    const clockAfter = this.commitClock(
      game,
      move.by === 'user' ? game.userColor : this.aiColor(game)
    )
    game.moves.push({
      ...move,
      ply,
      epdAfter: epdOf(move.fenAfter),
      ...(clockAfter ? { clockAfter } : {})
    })
    this.positionRevision += 1
    this.liveEvalValue = null
    this.gradeMove(game, beforeFen, game.moves[game.moves.length - 1]!)
    // Reactivating the comments never comments backwards (spec §4.2): only what is pushed while
    // they are visible is ever queued.
    if (this.commentsVisible) this.pendingComments.push(ply)
  }

  private fail(message: string): void {
    this.ai = idleAi()
    this.status = 'error'
    this.error = message
    console.error('[game]', message)
    this.emitState()
  }

  /** Spec §8: a failed autosave is visible, never silent — the position is kept in memory. */
  private async autosave(game: Game): Promise<void> {
    try {
      await this.deps.store.save(game)
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error)
      console.error('[game] autosave failed:', error)
    }
  }

  // ------------------------------------------------------------------ controls

  /** Removes the last user move and the AI answer that followed it (spec §4.3). */
  async takeback(): Promise<SessionState> {
    const game = this.requireGame()
    // Nothing of the user's to undo, or a game already over: a no-op, never an error.
    if (game.status === 'finished' || !game.moves.some((move) => move.by === 'user'))
      return this.state()

    this.opponentController?.abort()
    if (this.ai.thinking) {
      this.turnEpoch += 1
      this.ai = idleAi()
      if (this.threadId) await this.deps.codex.interrupt(this.threadId).catch(() => undefined)
    }

    let removed = 0
    if (game.moves[game.moves.length - 1]?.by === 'ai') {
      game.moves.pop()
      removed += 1
    }
    if (game.moves[game.moves.length - 1]?.by === 'user') {
      game.moves.pop()
      removed += 1
    }
    this.feedback.reset()
    this.evalRequest += 1
    game.takebacks += 1
    this.positionRevision += 1
    // The clocks go back with the moves: `clockAfter` of what is left, or the initial time.
    this.restoreClock(game)
    this.pendingComments = this.pendingComments.filter((ply) => ply <= game.moves.length)
    this.cancelStaleComment()
    this.coachHint = null
    this.pendingTakebackNotice = removed
    this.status = 'playing'
    this.error = null
    await this.autosave(game)
    this.emitState()
    await this.runEval(this.fen())
    return this.state()
  }

  async resign(): Promise<SessionState> {
    this.opponentController?.abort()
    const game = this.requireGame()
    if (this.ai.thinking) {
      this.turnEpoch += 1
      this.ai = idleAi()
      if (this.threadId) await this.deps.codex.interrupt(this.threadId).catch(() => undefined)
    }
    await this.finish({ outcome: game.userColor === 'w' ? '0-1' : '1-0', reason: 'resign' })
    return this.state()
  }

  /** One structured turn on the opponent thread; a failed turn is simply a refusal. */
  async offerDraw(): Promise<{ accepted: boolean; reason: string }> {
    const game = this.requireGame()
    if (this.status !== 'playing' || game.status !== 'in_progress')
      throw new GameError('GAME_NOT_PLAYING', `the game is ${this.status}`)
    if (this.ai.thinking) throw new GameError('AI_THINKING', 'the opponent is still thinking')
    if (!this.threadId) throw new GameError('NO_THREAD', 'the opponent thread is not open')

    const threadId = this.threadId
    const revision = this.positionRevision
    const result = await this.deps.codex.runTurn({
      threadId,
      text: drawOfferText({
        fen: this.fen(),
        pgn: pgnOf(game.moves, game.startFen ? { startFen: game.startFen } : undefined),
        language: game.language
      }),
      model: game.opponent.model,
      effort: game.opponent.effort,
      outputSchema: DRAW_OFFER_SCHEMA,
      language: game.language,
      timeoutMs: this.deps.settings.get().turnTimeoutSec * 1000,
      streamId: randomUUID()
    })
    if (
      this.game !== game ||
      this.status !== 'playing' ||
      game.status !== 'in_progress' ||
      this.threadId !== threadId ||
      this.positionRevision !== revision
    )
      return { accepted: false, reason: '' }
    if (!result.ok) return { accepted: false, reason: result.message }

    let accepted = false
    let reason = ''
    try {
      const parsed = JSON.parse(result.text.trim()) as { accept?: unknown; reason?: unknown }
      accepted = parsed.accept === true
      reason = typeof parsed.reason === 'string' ? parsed.reason : ''
    } catch {
      return { accepted: false, reason: '' }
    }
    if (accepted) await this.finish({ outcome: '1/2-1/2', reason: 'draw_agreed' })
    return { accepted, reason }
  }

  /** Live eval of a position the user is browsing in the move list; the game is not touched. */
  async navigateEval(fen: string): Promise<void> {
    if (typeof fen !== 'string' || fen.trim().length === 0)
      throw new GameError('BAD_FEN', 'a FEN string is required')
    await this.runEval(fen)
  }

  // ------------------------------------------------------------------ clocks (spec §4.3)

  private aiColor(game: Game): 'w' | 'b' {
    return game.userColor === 'w' ? 'b' : 'w'
  }

  /** (Re)creates the live clock from what the game carries; a game without clocks has none. */
  private buildClock(game: Game): void {
    this.stopTicker()
    this.expiring = false
    this.clock = game.clock
      ? new GameClock(
          {
            initialMs: game.clock.initialMs,
            incrementMs: game.clock.incrementMs,
            aiClock: game.clock.aiClock,
            aiColor: this.aiColor(game)
          },
          game.clock.remainingMs,
          this.deps.now
        )
      : null
  }

  /** Stops the mover's clock, credits the increment and writes the result into the game. */
  private commitClock(game: Game, color: 'w' | 'b'): { w: number; b: number } | null {
    if (!this.clock || !game.clock) return null
    const remaining = this.clock.onMoveCommitted(color)
    game.clock.remainingMs = { ...remaining }
    return remaining
  }

  /** A takeback puts the clocks back where the move that is still on the board left them. */
  private restoreClock(game: Game): void {
    if (!game.clock) return
    const last = game.moves[game.moves.length - 1]
    game.clock.remainingMs = last?.clockAfter
      ? { ...last.clockAfter }
      : { w: game.clock.initialMs, b: game.clock.initialMs }
    this.buildClock(game)
  }

  /**
   * Points the running clock at the side to move, and keeps the ticker alive only while one is
   * actually burning time. Called before every published state, so no transition can leave a
   * clock running for the wrong side.
   */
  private syncClock(): void {
    const clock = this.clock
    if (!clock) {
      this.stopTicker()
      return
    }
    const game = this.game
    if (!game || this.status !== 'playing' || game.status === 'finished') {
      clock.stop()
      this.stopTicker()
      return
    }
    clock.start(this.sideToMove(this.fen()))
    if (clock.snapshot().running) this.startTicker()
    else this.stopTicker()
  }

  private startTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => void this.onTick(), CLOCK_TICK_MS)
    // A running clock must never be the reason the process stays alive.
    this.ticker.unref?.()
  }

  private stopTicker(): void {
    if (!this.ticker) return
    clearInterval(this.ticker)
    this.ticker = null
  }

  /** One second of clock: either the flag falls, or the renderer gets a fresh state to show. */
  private async onTick(): Promise<void> {
    if (!this.clock) {
      this.stopTicker()
      return
    }
    if (await this.checkTimeout()) return
    if (this.clock.snapshot().running === null) {
      this.stopTicker()
      return
    }
    this.emitState()
  }

  /**
   * Settles the clocks and checks the flag outside the tick: after a suspended machine
   * (`powerMonitor 'resume'`) the interval may not have run for hours (spec §4.3).
   */
  async checkClock(): Promise<SessionState> {
    if (this.clock && !(await this.checkTimeout())) this.emitState()
    return this.state()
  }

  private async checkTimeout(): Promise<boolean> {
    const expired = this.clock?.expired() ?? null
    if (!expired || !this.game || this.game.status === 'finished') return false
    await this.handleExpiry(expired)
    return true
  }

  /** The flag has fallen: the turn in flight is dropped and the game ends on time. */
  private async handleExpiry(color: 'w' | 'b'): Promise<void> {
    const game = this.game
    if (!game || game.status === 'finished' || this.expiring) return
    this.expiring = true
    try {
      this.stopTicker()
      this.clock?.stop()
      if (this.ai.thinking) {
        this.turnEpoch += 1
        this.ai = idleAi()
        if (this.threadId) await this.deps.codex.interrupt(this.threadId).catch(() => undefined)
      }
      // Spec §6.1: a game the AI lost on time is excluded from the level estimation of M4, which
      // reads `result.reason === 'timeout'` and the losing colour off `outcome` and `userColor`.
      // The adaptive rating of §4.1 is a different quantity and keeps counting this game.
      await this.finish({ outcome: color === 'w' ? '0-1' : '1-0', reason: 'timeout' })
    } finally {
      this.expiring = false
    }
  }

  /** Spec §4.3: with a clock on the AI the turn can never outlive the time it has left. */
  private turnTimeoutMs(game: Game): number {
    const base = this.deps.settings.get().turnTimeoutSec * 1000
    if (!this.clock || !game.clock?.aiClock) return base
    return Math.max(
      0,
      Math.min(base, this.clock.remaining()[this.aiColor(game)] + CLOCK_TURN_GRACE_MS)
    )
  }

  // ------------------------------------------------------------------ coach (spec §4.2)

  /** Position the ply was played from: the previous move, or the start of the game. */
  private fenBefore(game: Game, ply: number): string {
    const previous = game.moves[ply - 2]
    return previous ? previous.fenAfter : (game.startFen ?? START_FEN)
  }

  private pgnUpTo(game: Game, plies?: number): string {
    const moves = typeof plies === 'number' ? game.moves.slice(0, plies) : game.moves
    return pgnOf(moves, game.startFen ? { startFen: game.startFen } : undefined)
  }

  private logCoach(game: Game, entry: Omit<CoachLogEntry, 'id' | 'createdAt'>): void {
    game.coachLog.push({
      ...entry,
      id: randomUUID(),
      createdAt: new Date(this.deps.now()).toISOString()
    })
  }

  /** Shows or hides the comments. Hiding drops what has not been commented yet. */
  setCommentsVisible(visible: boolean): SessionState {
    this.commentsVisible = visible === true
    if (!this.commentsVisible) {
      this.commentQueueEpoch += 1
      this.pendingComments = []
      this.activeComment?.controller.abort()
    }
    this.emitState()
    return this.state()
  }

  /** Comments the last uncommented moves, at most {@link MAX_SKIPPED_COMMENTS} of them. */
  commentSkipped(): SessionState {
    const game = this.requireGame()
    const skipped = game.moves.filter((move) => !move.coachComment).slice(-MAX_SKIPPED_COMMENTS)
    for (const move of skipped) {
      if (!this.pendingComments.includes(move.ply)) this.pendingComments.push(move.ply)
    }
    this.pendingComments.sort((a, b) => a - b)
    this.flushComments()
    return this.state()
  }

  /**
   * Waits for the comment currently in flight, which `close()` has just interrupted.
   * A coach that never answers must not keep the app from quitting: the wait is bounded.
   */
  private async settleComments(): Promise<void> {
    const settled = this.commentChain.catch(() => undefined)
    let timer: NodeJS.Timeout | null = null
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, COMMENT_SETTLE_MS)
      timer.unref?.()
    })
    await Promise.race([settled, deadline])
    if (timer) clearTimeout(timer)
  }

  /** Hands the queued plies to the coach, one at a time, without ever awaiting the chain. */
  private flushComments(): void {
    if (this.pendingComments.length === 0) return
    const game = this.game
    if (!game) {
      this.pendingComments = []
      return
    }
    const plies = this.pendingComments.splice(0, this.pendingComments.length)
    const epoch = this.commentQueueEpoch
    for (const ply of plies) {
      const move = game.moves[ply - 1]
      if (!move || move.coachComment) continue
      const gameId = game.id
      const uci = move.uci
      this.commentChain = this.commentChain
        .then(() => {
          if (epoch !== this.commentQueueEpoch) return
          return this.commentOne(gameId, ply, uci)
        })
        .catch((error) => console.error('[game] the comment failed:', error))
    }
  }

  /** One comment. Everything that could have moved under it is checked again before saving. */
  private async commentOne(gameId: string, ply: number, uci: string): Promise<void> {
    const game = this.game
    const move = game?.moves[ply - 1]
    if (!game || game.id !== gameId || !move || move.uci !== uci || move.coachComment) return

    const language = this.deps.settings.get().language
    const active = { gameId, ply, uci, controller: new AbortController() }
    this.activeComment = active
    let comment: Awaited<ReturnType<CoachSession['commentOn']>>
    try {
      comment = await this.coach.commentOn(game, ply, {
        fenBefore: this.fenBefore(game, ply),
        fenAfter: move.fenAfter,
        pgn: this.pgnUpTo(game, ply),
        signal: active.controller.signal
      })
    } finally {
      if (this.activeComment === active) this.activeComment = null
    }
    if (!comment || comment.text.length === 0) return

    // The game may have been taken back, closed or replaced while the coach was writing.
    const current = this.game
    const target = current?.moves[ply - 1]
    if (!current || current.id !== gameId || !target || target.uci !== uci) return
    target.coachComment = comment.text
    target.coachCommentLanguage = language
    this.logCoach(current, { ply, kind: 'comment', text: comment.text, move: target.san, language })
    await this.autosave(current)
    this.emitState()
  }

  /** Cancels only a comment whose exact move no longer exists; valid queued comments stay ordered. */
  private cancelStaleComment(): void {
    const active = this.activeComment
    if (!active) return
    const game = this.game
    const move = game?.moves[active.ply - 1]
    if (!game || game.id !== active.gameId || !move || move.uci !== active.uci) {
      active.controller.abort()
    }
  }

  /** Free question from the Coach tab; both the question and the answer enter the coach log. */
  async askCoach(question: string): Promise<SessionState> {
    const game = this.requireGame()
    const asked = String(question ?? '').trim()
    if (!asked) throw new GameError('BAD_QUESTION', 'a question is required')

    const language = this.deps.settings.get().language
    const ply = game.moves.length
    const fen = this.fen()
    const revision = this.positionRevision
    const pgn = this.pgnUpTo(game)
    this.logCoach(game, { ply, kind: 'question', text: asked, language })
    await this.autosave(game)
    this.emitState()

    const answer = await this.coach.ask(game, asked, { fen, pgn })
    const current = this.game
    if (
      !current ||
      current.id !== game.id ||
      current.moves.length !== ply ||
      this.fen() !== fen ||
      this.positionRevision !== revision
    )
      return this.state()
    this.logCoach(current, {
      ply,
      kind: 'answer',
      text: answer.text,
      ...(answer.hint ? { move: answer.hint.move } : {}),
      language
    })
    this.coachAnswer = { question: asked, text: answer.text, ply }
    // A newer answer owns the indication for this position, including an explicit `move: null`.
    this.coachHint =
      this.status === 'playing' && this.sideToMove(fen) === current.userColor ? answer.hint : null
    await this.autosave(current)
    this.emitState()
    return this.state()
  }

  /** "Suggerimento": one validated move, drawn as an arrow until the user moves. */
  async requestHint(): Promise<SessionState> {
    const game = this.requireGame()
    if (this.status !== 'playing')
      throw new GameError('GAME_NOT_PLAYING', `the game is ${this.status}`)
    if (this.sideToMove(this.fen()) !== game.userColor)
      throw new GameError('NOT_YOUR_TURN', 'it is not your turn')

    const language = this.deps.settings.get().language
    const ply = game.moves.length
    const fen = this.fen()
    const revision = this.positionRevision
    const hint = await this.coach.hint(game, { fen, pgn: this.pgnUpTo(game) })
    const current = this.game
    if (
      !current ||
      current.id !== game.id ||
      current.moves.length !== ply ||
      this.fen() !== fen ||
      this.positionRevision !== revision ||
      this.status !== 'playing' ||
      this.sideToMove(fen) !== current.userColor
    )
      return this.state()
    this.coachHint = hint
    this.logCoach(current, {
      ply: current.moves.length,
      kind: 'hint',
      text: hint.reason,
      move: hint.move,
      language
    })
    await this.autosave(current)
    this.emitState()
    return this.state()
  }

  /** Removes the arrow without playing the move. */
  clearHint(): SessionState {
    this.coachHint = null
    this.emitState()
    return this.state()
  }

  // ------------------------------------------------------------------ end of game

  /** Checks the terminal states of the current position and finishes the game when it is over. */
  private async checkEnd(): Promise<boolean> {
    const game = this.game
    if (!game) return false
    const fen = this.fen()
    const history = [game.startFen ?? START_FEN, ...game.moves.map((move) => move.fenAfter)]
    const status = gameStatus(fen, history)
    if (!status.over) return false

    const turn = this.sideToMove(fen)
    const result: GameResult =
      status.reason === 'checkmate'
        ? { outcome: turn === 'w' ? '0-1' : '1-0', reason: 'checkmate' }
        : { outcome: '1/2-1/2', reason: status.reason ?? 'stalemate' }
    await this.finish(result)
    return true
  }

  private async finish(result: GameResult): Promise<void> {
    const game = this.requireGame()
    // Idempotent, like `takeback()`: a second resign, or a resign racing with the checkmate
    // `checkEnd()` just recorded, must not overwrite the result nor apply the adaptive step twice.
    if (game.status === 'finished') return
    game.status = 'finished'
    this.status = 'finished'
    this.opponentController?.abort()
    game.result = result
    this.coachHint = null
    this.turnEpoch += 1
    this.ai = idleAi()
    this.stopTicker()
    if (this.clock && game.clock) {
      this.clock.stop()
      game.clock.remainingMs = { ...this.clock.remaining() }
    }
    // Detach this thread before yielding: a concurrent new game must keep its own thread.
    const threadId = this.threadId
    this.threadId = null
    // Settle grades before the deeper review reads and saves this game.
    await this.settleFeedback()
    await this.autosave(game)
    if (threadId) await this.deps.codex.closeThread(threadId).catch(() => undefined)

    await this.updateAdaptive(game, result)
    if (this.game === game) {
      this.status = 'finished'
      this.emitState()
    }
    this.deps.emit('game:finished', { gameId: game.id, result })
    // The game on disk is already saved above: the pipeline reads it back by id.
    try {
      this.deps.onFinished?.(game)
    } catch (error) {
      console.error('[game] the post-game hook failed:', error)
    }
  }

  /**
   * Adaptive rating after a finished match (spec §4.1): ±75 for a decisive result, +25 for a
   * draw, doubled while fewer than three adaptive games have been played, clamped to 500–2400.
   */
  private async updateAdaptive(game: Game, result: GameResult): Promise<void> {
    if (
      game.kind !== 'match' ||
      game.opponent.difficulty.mode !== 'adaptive' ||
      this.deps.profile.get().retiredGameIds.includes(game.id)
    )
      return
    const adaptive = this.deps.profile.get().adaptive
    const elo = adaptive?.elo ?? ADAPTIVE_START_ELO
    const games = adaptive?.games ?? 0

    const userWon = result.outcome === (game.userColor === 'w' ? '1-0' : '0-1')
    const base =
      result.outcome === '1/2-1/2'
        ? ADAPTIVE_STEP.draw
        : userWon
          ? ADAPTIVE_STEP.win
          : ADAPTIVE_STEP.loss
    const step = games < ADAPTIVE_DOUBLE_UNTIL_GAMES ? base * 2 : base

    await this.deps.profile
      .update({
        adaptive: {
          elo: clamp(elo + step, ADAPTIVE_MIN_ELO, ADAPTIVE_MAX_ELO),
          games: games + 1,
          updatedAt: new Date(this.deps.now()).toISOString()
        }
      })
      .catch((error) => console.error('[game] the adaptive rating could not be saved:', error))
  }

  // ------------------------------------------------------------------ engine

  private async settleFeedback(): Promise<void> {
    const game = this.game
    let timer: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([
      Promise.allSettled([...this.feedbackTasks]).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 2000)
      })
    ])
    if (timer) clearTimeout(timer)
    if (!settled) this.feedback.reset()
    // A cancelled, disabled or timed-out request must not be stored as pending forever.
    for (const move of game?.moves ?? []) {
      if (move.liveEvalStatus === 'pending') move.liveEvalStatus = 'unavailable'
    }
  }

  private gradeMove(game: Game, beforeFen: string, move: Move): void {
    if (!this.deps.settings.get().liveMoveFeedback) return
    if (!(this.deps.feedbackEngine ?? this.deps.engine).state().available) {
      move.liveEvalStatus = 'unavailable'
      return
    }
    move.liveEvalStatus = 'pending'
    const history = [game.startFen ?? START_FEN, ...game.moves.map((entry) => entry.fenAfter)]
    const task = this.feedback
      .evaluate(beforeFen, move, history, this.deps.now)
      .then(async (evaluation) => {
        if (
          this.game !== game ||
          game.moves[move.ply - 1] !== move ||
          move.liveEvalStatus !== 'pending' ||
          !this.deps.settings.get().liveMoveFeedback
        )
          return
        if (!evaluation) {
          move.liveEvalStatus = 'unavailable'
          this.emitState()
          return
        }
        delete move.liveEvalStatus
        move.liveEval = evaluation
        this.emitState()
        // A terminal game is saved by finish(), before the post-game review starts.
        if (game.status === 'in_progress') await this.autosave(game)
      })
      .catch((error) => {
        if ((error as Error)?.name !== 'AbortError') {
          console.error('[game] move feedback failed:', error)
          if (this.game === game && game.moves[move.ply - 1] === move) {
            move.liveEvalStatus = 'unavailable'
            this.emitState()
          }
        }
      })
      .finally(() => this.feedbackTasks.delete(task))
    this.feedbackTasks.add(task)
  }

  /** Request identity also protects the bar while browsing and undoing a move. */
  private async runEval(fen: string): Promise<void> {
    const request = ++this.evalRequest
    const game = this.game
    if (!(this.deps.feedbackEngine ?? this.deps.engine).state().available) {
      this.liveEvalValue = null
      return
    }
    try {
      const analysis = await this.feedback.analyze(fen)
      if (request !== this.evalRequest || game !== this.game) return
      const line = analysis.lines[0]
      if (!line) return
      const flip = this.sideToMove(fen) === 'b' ? -1 : 1
      this.liveEvalValue = {
        ...(typeof line.scoreCp === 'number' ? { cp: flip * line.scoreCp } : {}),
        ...(typeof line.scoreMate === 'number' ? { mate: flip * line.scoreMate } : {}),
        depth: analysis.depth
      }
      this.emitState()
    } catch (error) {
      if ((error as Error)?.name !== 'AbortError')
        console.error('[game] the live eval failed:', error)
    }
  }
}
