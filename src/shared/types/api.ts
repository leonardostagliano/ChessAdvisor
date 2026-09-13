import type { Game, GameAnalysis, GameFilter, GameSummary } from './game'
import type { CodexState, ModelInfo, QuotaSnapshot } from './codex'
import type { NewGameOptions, SessionState } from './session'
import type { Settings } from './settings'
import type { Profile } from './profile'
import type {
  AttemptResult,
  EndgameListEntry,
  Exercise,
  ExerciseKind,
  OpeningOverviewEntry,
  StudyPlanView,
  ThematicSet,
  TrainingChanged
} from './training'
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

// ─── Task 15: post-game analysis and review (spec §3.1, §4.4) ─────────────────
// The pipeline runs in the main process and pushes its progress; the review's AI calls resolve
// with their own text and stream it meanwhile on the usual `stream` channel.

export interface AnalysisStatus {
  state: 'idle' | 'running' | 'done' | 'unavailable'
  /** Plies already analysed and plies in total, while the state is `running` or `done`. */
  ply?: number
  total?: number
}

export interface AnalysisProgress {
  gameId: string
  /** Ply just analysed; `0` is emitted once when the run starts. */
  ply: number
  total: number
}

/** Announces a review turn *before* it starts, so the screen can subscribe to `streamId` in time. */
export interface ReviewActivity {
  gameId: string
  kind: 'move' | 'keyMoments' | 'lesson'
  /** Ply the turn is about; `null` for the lesson of the whole game. */
  ply: number | null
  streamId: string | null
  busy: boolean
}

export type ReviewLesson = NonNullable<GameAnalysis['lesson']>

export interface AnalysisApi {
  /** Analyses the game (or joins the run already in flight) and resolves with the saved game. */
  run(gameId: string): Promise<Game>
  status(gameId: string): Promise<AnalysisStatus>
}

export interface ReviewApi {
  /** Comments one past ply; the text is saved into `Move.coachComment`. */
  commentMove(gameId: string, ply: number): Promise<string>
  /** One comment per key moment, at most eight (spec §4.4). */
  commentKeyMoments(gameId: string): Promise<{ ply: number; text: string }[]>
  /** Three takeaways and a summary, saved into `Game.analysis.lesson`. */
  lesson(gameId: string): Promise<ReviewLesson>
  /** Closes the `training` thread of the review; the next call opens a new one. */
  close(): Promise<void>
}

export interface Api {
  analysis: AnalysisApi
  review: ReviewApi
  on(channel: 'analysis:progress', cb: (e: AnalysisProgress) => void): () => void
  on(channel: 'review:activity', cb: (e: ReviewActivity) => void): () => void
}

// ─── Task 17: the player profile (spec §5, §6.1, §6.3) ────────────────────────
// The profile is written by the main process alone — the analysis of a match feeds it — so the
// renderer only reads it and follows `profile:changed`.

export interface ProfileApi {
  get(): Promise<Profile>
  /** Asks the coach for a fresh qualitative assessment; resolves with the saved profile. */
  refreshQualitative(): Promise<Profile>
}

export interface Api {
  profile: ProfileApi
  on(channel: 'profile:changed', cb: (p: Profile) => void): () => void
}

// ─── Task 20: the training section (spec §6.4–§6.8) ───────────────────────────
// One namespace with five groups, one per way of training, and a single event: the main process
// owns every file behind them, so the renderer reads, plays and follows `training:changed`.

export interface ExercisesApi {
  /** Every exercise, newest first; optionally of one kind only. */
  list(kind?: ExerciseKind): Promise<Exercise[]>
  get(id: string): Promise<Exercise | null>
  /** One move played through the board; the answer says what the board must show next. */
  attempt(id: string, uci: string): Promise<AttemptResult>
  /** Puts the exercise back to its starting position and forgets the attempts made at it. */
  reset(id: string): Promise<Exercise>
  /** Coach explanation of the solution; the text also streams on the `stream` channel. */
  explain(id: string): Promise<string>
}

export interface TrainingApi {
  exercises: ExercisesApi
  thematic: {
    /** A new set of ten puzzles, chosen by the coach from the profile (spec §6.5). */
    next(): Promise<ThematicSet>
  }
  openings: {
    overview(): Promise<OpeningOverviewEntry[]>
    /** Mini-lesson of one opening; it streams like every other plain-text turn. */
    lesson(eco: string): Promise<string>
  }
  endgames: {
    list(): Promise<EndgameListEntry[]>
    /** Starts the drill: the answer is the state of the game that has just begun. */
    start(id: string): Promise<SessionState>
  }
  plan: {
    get(): Promise<StudyPlanView>
    generate(): Promise<StudyPlanView>
    markDone(itemId: string, done?: boolean): Promise<StudyPlanView>
  }
}

export interface Api {
  training: TrainingApi
  on(channel: 'training:changed', cb: (e: TrainingChanged) => void): () => void
}
