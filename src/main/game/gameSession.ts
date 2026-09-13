import { randomUUID } from 'node:crypto'
import { applyMove, epdOf, gameStatus, legalMoves } from '@shared/chess/notation'
import { pgnOf } from '@shared/chess/pgn'
import type { Game, GameResult, Move } from '@shared/types/game'
import { DIFFICULTY_LEVELS, nearestLevel, type DifficultyChoice, type NewGameOptions, type OpponentDifficulty, type SessionState } from '@shared/types/session'
import type { CodexService } from '../codex/codexService'
import type { EngineService } from '../engine/engineService'
import type { GameStore } from '../store/gameStore'
import type { ProfileStore } from '../store/profileStore'
import type { SettingsStore } from '../store/settingsStore'
import { OpponentTurnError, playOpponentTurn } from './opponentTurn'
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
export type SessionCodex = Pick<CodexService, 'startThread' | 'runTurn' | 'interrupt' | 'closeThread' | 'models'>
export type SessionEngine = Pick<EngineService, 'analyze' | 'state'>

export interface GameFinishedEvent {
  gameId: string
  result: GameResult
}

export interface GameSessionDeps {
  codex: SessionCodex
  engine: SessionEngine
  store: GameStore
  settings: SettingsStore
  /** Adaptive difficulty reads and writes `profile.json` through this store. */
  profile: ProfileStore
  emit(channel: 'game:state' | 'game:finished', payload: SessionState | GameFinishedEvent): void
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

const idleAi = (): SessionState['ai'] => ({ thinking: false, startedAt: null, reasoning: '', retries: 0, streamId: null })

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

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
  /**
   * Bumped whenever a running AI turn stops being relevant (takeback, resign, new game, close).
   * The turn that comes back with a stale epoch is dropped instead of landing on the board.
   */
  private turnEpoch = 0

  constructor(private readonly deps: GameSessionDeps) {}

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
      userToMove: this.status === 'playing' && this.game !== null && turn === this.game.userColor && !this.ai.thinking,
      ai: { ...this.ai },
      liveEval: this.liveEvalValue ? { ...this.liveEvalValue } : null,
      status: this.status,
      error: this.error
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
    const userColor = opts.userColor === 'random' ? (Math.random() < 0.5 ? 'w' : 'b') : opts.userColor
    const difficulty = this.resolveDifficulty(opts.difficulty, kind)

    const game = await this.deps.store.create({
      kind,
      userColor,
      opponent: { model: opts.model, effort: opts.effort, difficulty },
      coach: { model: opts.coach.model, effort: opts.coach.effort },
      clock: null,
      language: opts.language,
      ...(opts.startFen ? { startFen: opts.startFen } : {})
    })

    // The dialog reopens on the same choices next time (spec §4.3).
    await this.deps.settings
      .save({ defaultModel: opts.model, defaultEffort: opts.effort, lastDifficulty: { ...opts.difficulty } })
      .catch((error) => console.error('[game] the new-game choices could not be saved:', error))

    this.game = game
    this.showReasoning = opts.showReasoning
    this.commentsVisible = opts.commentsVisible
    this.pendingTakebackNotice = null
    this.liveEvalValue = null
    this.error = null
    this.status = 'playing'
    await this.openThread()
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
        throw new GameError('MODEL_UNAVAILABLE', `the model ${substitute} is not available; suggested: ${suggested ?? 'none'}`, suggested)
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
    this.emitState()
    await this.runEval(this.fen())
    if (!this.state().userToMove) await this.aiMove()
    return this.state()
  }

  /** Unsubscribes the thread and forgets the game; the game stays `in_progress` on disk. */
  async close(): Promise<void> {
    this.turnEpoch += 1
    const threadId = this.threadId
    this.threadId = null
    if (threadId) {
      if (this.ai.thinking) await this.deps.codex.interrupt(threadId).catch(() => undefined)
      await this.deps.codex.closeThread(threadId).catch(() => undefined)
    }
    this.game = null
    this.status = 'idle'
    this.error = null
    this.ai = idleAi()
    this.liveEvalValue = null
    this.pendingTakebackNotice = null
    this.emitState()
  }

  // ------------------------------------------------------------------ moves

  async userMove(uci: string): Promise<SessionState> {
    const game = this.requireGame()
    if (this.status !== 'playing') throw new GameError('GAME_NOT_PLAYING', `the game is ${this.status}`)
    if (this.ai.thinking) throw new GameError('AI_THINKING', 'the opponent is still thinking')
    const fen = this.fen()
    if (this.sideToMove(fen) !== game.userColor) throw new GameError('NOT_YOUR_TURN', 'it is not your turn')

    const applied = applyMove(fen, uci)
    if (!applied) throw new GameError('ILLEGAL_MOVE', `${uci} is not legal in ${fen}`)

    this.pushMove(game, { san: applied.san, uci, fenAfter: applied.fen, by: 'user' })
    await this.autosave(game)
    this.emitState()

    if (await this.checkEnd()) return this.state()
    await this.runEval(this.fen())
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

    const epoch = (this.turnEpoch += 1)
    const streamId = randomUUID()
    this.ai = { thinking: true, startedAt: this.deps.now(), reasoning: '', retries: 0, streamId }
    this.emitState()

    const notice = this.pendingTakebackNotice
    this.pendingTakebackNotice = null
    const lastMove = game.moves[game.moves.length - 1]

    try {
      const move = await playOpponentTurn(
        { codex: this.deps.codex, engine: this.deps.engine, now: this.deps.now },
        {
          threadId: this.threadId,
          model: game.opponent.model,
          effort: game.opponent.effort,
          language: game.language,
          fen,
          pgn: pgnOf(game.moves, game.startFen ? { startFen: game.startFen } : undefined),
          lastUserMove: lastMove?.by === 'user' ? lastMove.san : null,
          takebackNotice: notice,
          timeoutMs: this.deps.settings.get().turnTimeoutSec * 1000,
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

      const applied = applyMove(fen, move.uci)
      if (!applied) {
        this.fail(`the opponent answered with ${move.uci}, which is not legal in ${fen}`)
        return
      }
      this.pushMove(game, {
        san: applied.san,
        uci: move.uci,
        fenAfter: applied.fen,
        by: 'ai',
        thinkingMs: move.thinkingMs,
        thinkingOverheadMs: move.overheadMs,
        ...(move.effectiveModel ? { effectiveModel: move.effectiveModel } : {}),
        ...(move.fallback ? { fallback: move.fallback } : {}),
        ...(move.shortComment ? { aiShortComment: move.shortComment } : {})
      })
      this.ai = idleAi()
      await this.autosave(game)
      this.emitState()
      if (await this.checkEnd()) return
      await this.runEval(this.fen())
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
    game.moves.push({ ...move, ply: game.moves.length + 1, epdAfter: epdOf(move.fenAfter) })
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
    if (game.status === 'finished' || !game.moves.some((move) => move.by === 'user')) return this.state()

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
    game.takebacks += 1
    this.pendingTakebackNotice = removed
    this.status = 'playing'
    this.error = null
    await this.autosave(game)
    this.emitState()
    await this.runEval(this.fen())
    return this.state()
  }

  async resign(): Promise<SessionState> {
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
    if (this.ai.thinking) throw new GameError('AI_THINKING', 'the opponent is still thinking')
    if (!this.threadId) throw new GameError('NO_THREAD', 'the opponent thread is not open')

    const result = await this.deps.codex.runTurn({
      threadId: this.threadId,
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
    if (typeof fen !== 'string' || fen.trim().length === 0) throw new GameError('BAD_FEN', 'a FEN string is required')
    await this.runEval(fen)
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
    game.result = result
    this.turnEpoch += 1
    this.ai = idleAi()
    await this.autosave(game)

    const threadId = this.threadId
    this.threadId = null
    if (threadId) await this.deps.codex.closeThread(threadId).catch(() => undefined)

    await this.updateAdaptive(game, result)
    this.status = 'finished'
    this.emitState()
    this.deps.emit('game:finished', { gameId: game.id, result })
  }

  /**
   * Adaptive rating after a finished match (spec §4.1): ±75 for a decisive result, +25 for a
   * draw, doubled while fewer than three adaptive games have been played, clamped to 500–2400.
   */
  private async updateAdaptive(game: Game, result: GameResult): Promise<void> {
    if (game.kind !== 'match' || game.opponent.difficulty.mode !== 'adaptive') return
    const adaptive = this.deps.profile.get().adaptive
    const elo = adaptive?.elo ?? ADAPTIVE_START_ELO
    const games = adaptive?.games ?? 0

    const userWon = result.outcome === (game.userColor === 'w' ? '1-0' : '0-1')
    const base = result.outcome === '1/2-1/2' ? ADAPTIVE_STEP.draw : userWon ? ADAPTIVE_STEP.win : ADAPTIVE_STEP.loss
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

  /** Live eval converted to White's perspective; an unavailable engine simply hides the bar. */
  private async runEval(fen: string): Promise<void> {
    if (!this.deps.engine.state().available) {
      this.liveEvalValue = null
      return
    }
    try {
      const analysis = await this.deps.engine.analyze(fen, 'live')
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
      // A live request pre-empted by the next one is normal; anything else is only a missing bar.
      if ((error as Error)?.name !== 'AbortError') console.error('[game] the live eval failed:', error)
    }
  }
}
