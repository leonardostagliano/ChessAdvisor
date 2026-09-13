import type { Game, GameFilter, GameSummary } from './game'
import type { CodexState, ModelInfo, QuotaSnapshot } from './codex'
import type { NewGameOptions, SessionState } from './session'
import type { Settings } from './settings'
import type { Analysis, AnalysisProfile, EngineState } from './engine'
import type { UpdateStatus, UpdatesApi } from '../updates'

/** Version identity of the running build (Task 5). */
export interface AppVersionInfo {
  version: string
  isPackaged: boolean
}

/** Delta envelope pushed on the `stream` channel while a turn is running. */
export interface StreamEnvelope {
  streamId: string
  threadId: string
  turnId: string
  itemId: string
  kind: 'text' | 'reasoning' | 'progress' | 'eval'
  chunk: string
}

export interface Api {
  settings: { get(): Promise<Settings>; save(patch: Partial<Settings>): Promise<Settings> }
  app: {
    version(): Promise<string>
    openExternal(url: string): Promise<void>
    showWindow(): Promise<void>
    // --- Task 5: updater and licences ---
    versionInfo(): Promise<AppVersionInfo>
    readNotices(): Promise<string>
  }
  on(channel: 'stream', cb: (e: StreamEnvelope) => void): () => void
  on(channel: 'settings:changed', cb: (s: Settings) => void): () => void

  // --- Task 7: Stockfish engine ---
  /**
   * Analysis is driven by the main process (GameSession owns the live eval); the renderer only
   * reads the state and, in M3, asks for an explicit analysis of a browsed position.
   */
  engine: {
    state(): Promise<EngineState>
    analyze(fen: string, profile: AnalysisProfile): Promise<Analysis>
  }
  on(channel: 'engine:state', cb: (s: EngineState) => void): () => void
  // --- end Task 7 ---
  // --- Task 6: Codex session ---------------------------------------------------------------
  codex: {
    state(): Promise<CodexState>
    retry(): Promise<void>
    models(): Promise<ModelInfo[]>
    quota(): Promise<QuotaSnapshot | null>
  }
  on(channel: 'codex:state', cb: (s: CodexState) => void): () => void
  // --- Task 5: in-app updater ---
  updates: UpdatesApi
  on(channel: 'updates:changed', cb: (s: UpdateStatus) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}

// ─── Task 8: games archive ────────────────────────────────────────────────────
// Declaration merging keeps this namespace additive: sibling tasks append their own
// `Api` block below without touching the ones already here.

export interface GamesApi {
  /** Archive rows, newest first. */
  list(filter?: GameFilter): Promise<GameSummary[]>
  get(id: string): Promise<Game | null>
  delete(id: string): Promise<void>
}

export interface Api {
  games: GamesApi
}

// ─── Task 9: the active game ──────────────────────────────────────────────────
// One game at a time: every call acts on the single live session, and every transition is
// also pushed on the `game:state` event, so the renderer can stay purely reactive.

export interface GameApi {
  /** Quoted so it declares a method called `new`, not a construct signature. */
  'new'(opts: NewGameOptions): Promise<SessionState>
  /**
   * `substituteModel` answers a `MODEL_UNAVAILABLE` failure of a previous call: the rejection of
   * that call carries the model to prefill in `parseIpcError(error).data.suggested`
   * (see `@shared/ipcError`), on both sides of the IPC boundary.
   */
  resume(id: string, opts?: { substituteModel?: string }): Promise<SessionState>
  userMove(uci: string): Promise<SessionState>
  takeback(): Promise<SessionState>
  resign(): Promise<SessionState>
  offerDraw(): Promise<{ accepted: boolean; reason: string }>
  /** Live eval of a position browsed in the move list; the game is not touched. */
  navigateEval(fen: string): Promise<void>
  state(): Promise<SessionState>
  close(): Promise<SessionState>
  /** Current adaptive rating, or `null` before the first adaptive game. */
  adaptiveElo(): Promise<{ elo: number; games: number } | null>
}

export interface GameFinished {
  gameId: string
  result: NonNullable<Game['result']>
}

export interface Api {
  game: GameApi
  on(channel: 'game:state', cb: (s: SessionState) => void): () => void
  on(channel: 'game:finished', cb: (e: GameFinished) => void): () => void
}

// ─── Task 12: the coach in game ───────────────────────────────────────────────
// The coach lives in the same session as the game: every call answers with the whole
// `SessionState`, and the text of comments, answers and hints streams on the `stream`
// channel under `SessionState.coach.streamId`.

export interface GameApi {
  /** Shows or hides the comments; hiding never comments backwards afterwards (spec §4.2). */
  setCommentsVisible(visible: boolean): Promise<SessionState>
  /** Free question of the Coach tab. Resolves when the whole answer has arrived. */
  askCoach(question: string): Promise<SessionState>
  /** One hint: the move lands in `coach.hint` and is drawn as an arrow on the board. */
  requestHint(): Promise<SessionState>
  /** Removes the hint arrow without playing the move. */
  clearHint(): Promise<SessionState>
  /** Comments the last uncommented moves, at most six (spec §4.2). */
  commentSkipped(): Promise<SessionState>
}
