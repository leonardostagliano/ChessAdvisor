import { create } from 'zustand'
import { parseIpcError } from '@shared/ipcError'
import type { StreamEnvelope } from '@shared/types/api'
import type { Game } from '@shared/types/game'
import type { NewGameOptions, SessionState } from '@shared/types/session'

/**
 * Renderer mirror of the single game owned by the main process.
 *
 * The main process is the only authority: every action is an IPC call whose answer is the whole
 * `SessionState`, and unsolicited transitions (the AI moving, the eval bar deepening, a timeout)
 * arrive on the `game:state` channel. On top of that mirror the store keeps the two things that
 * are purely local to the renderer: which ply the move list is browsing, and whether the coach
 * comments are shown (spec §4.3).
 */

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

export const EMPTY_SESSION: SessionState = {
  game: null,
  fen: START_FEN,
  legal: [],
  turn: 'w',
  userToMove: false,
  ai: { thinking: false, startedAt: null, reasoning: '', retries: 0, streamId: null },
  liveEval: null,
  status: 'idle',
  error: null,
  clock: null,
  coach: { commentsVisible: true, busy: false, streamId: null, hint: null, lastAnswer: null }
}

export interface GameStoreState {
  session: SessionState
  /** Ply shown on the board: `null` is the live position, `-1` the position before move 1. */
  browsePly: number | null
  /** True while the opponent is producing a move; the updater and the board read it. */
  aiThinking: boolean
  /** Mirror of `session.coach.commentsVisible`, kept optimistic while the call is in flight. */
  commentsVisible: boolean
  /**
   * Text of the coach turn that is streaming right now, keyed by the `streamId` the session
   * published before the turn started. Kept until the next turn opens a new one, so the feed
   * never blinks between the last delta and the state that saves the comment.
   */
  coachStream: { streamId: string; text: string } | null
  /**
   * What *this window* asked the coach for. Comments are started by the main process, so a coach
   * that is busy with no request of ours is writing a comment: that is how the two tabs tell
   * whose stream they are watching.
   */
  coachRequest: 'answer' | 'hint' | null
  /** True while an IPC call started here has not answered yet. */
  busy: boolean
  /** Last failure of a call started here, already unwrapped from the IPC envelope. */
  error: string | null

  apply(session: SessionState): void
  setBrowsePly(ply: number | null): void
  browseBy(delta: number): void
  returnToLive(): void
  clearError(): void
  /** Appends a `stream` delta of the coach turn in flight; everything else is ignored. */
  applyStream(envelope: StreamEnvelope): void

  refresh(): Promise<void>
  newGame(options: NewGameOptions): Promise<SessionState | null>
  resume(id: string, options?: { substituteModel?: string }): Promise<SessionState | null>
  userMove(uci: string): Promise<void>
  takeback(): Promise<void>
  resign(): Promise<void>
  offerDraw(): Promise<{ accepted: boolean; reason: string } | null>
  close(): Promise<void>
  navigateEval(fen: string): Promise<void>

  // --- Task 12: the coach in game (spec §4.2) ---
  setCommentsVisible(visible: boolean): Promise<void>
  askCoach(question: string): Promise<void>
  requestHint(): Promise<void>
  clearHint(): Promise<void>
  commentSkipped(): Promise<void>
}

type BoardView = Pick<GameStoreState, 'session' | 'browsePly'>

/** Position a game starts from: the standard one unless it is a drill from a set-up FEN. */
export function startFenOf(game: Game | null | undefined): string {
  return game?.startFen ?? START_FEN
}

/** FEN after `ply` (0-based). `-1`, or a ply out of range, is the starting position. */
export function fenAtPly(game: Game | null | undefined, ply: number): string {
  const move = game?.moves[ply]
  return move ? move.fenAfter : startFenOf(game)
}

/** Origin and destination of the move played at `ply`, for the board highlight. */
export function lastMoveAtPly(
  game: Game | null | undefined,
  ply: number
): [string, string] | undefined {
  const move = game?.moves[ply]
  if (!move) return undefined
  return [move.uci.slice(0, 2), move.uci.slice(2, 4)]
}

export function isBrowsing(state: BoardView): boolean {
  return state.browsePly !== null
}

/** Index of the last played ply, `-1` before the first move. */
export function livePly(state: BoardView): number {
  return (state.session.game?.moves.length ?? 0) - 1
}

/** FEN the board must show: the live position, or the browsed one. */
export function boardFen(state: BoardView): string {
  if (state.browsePly === null) return state.session.fen
  return fenAtPly(state.session.game, state.browsePly)
}

export function boardLastMove(state: BoardView): [string, string] | undefined {
  const ply = state.browsePly ?? livePly(state)
  return lastMoveAtPly(state.session.game, ply)
}

/** The bridge is absent in unit tests and in a renderer opened without the preload. */
function bridge(): Window['api'] | undefined {
  return typeof window === 'undefined' ? undefined : window.api
}

function failure(error: unknown): string {
  const { message, code } = parseIpcError(error)
  return message.length > 0 ? message : code
}

export const useGameStore = create<GameStoreState>((set, get) => {
  /** Every action shares the same shape: mark busy, call, mirror the answer, keep the failure. */
  async function call<T>(
    run: (api: Window['api']) => Promise<T>,
    mirror?: (value: T) => void
  ): Promise<T | null> {
    const api = bridge()
    if (!api) return null
    set({ busy: true, error: null })
    try {
      const value = await run(api)
      mirror?.(value)
      return value
    } catch (error) {
      set({ error: failure(error) })
      return null
    } finally {
      set({ busy: false })
    }
  }

  const applySession = (session: SessionState): void => get().apply(session)

  /**
   * A coach turn is deliberately outside `call()`: asking a question can take half a minute, and
   * `busy` greys out every game control. The coach has its own in-flight marker instead, which is
   * also what tells the feed whether the stream in flight is an answer, a hint or a comment.
   */
  async function coachCall(
    kind: 'answer' | 'hint',
    run: (api: Window['api']) => Promise<SessionState>
  ): Promise<void> {
    const api = bridge()
    if (!api) return
    set({ coachRequest: kind, coachStream: null, error: null })
    try {
      applySession(await run(api))
    } catch (error) {
      set({ error: failure(error) })
    } finally {
      set({ coachRequest: null })
    }
  }

  return {
    session: EMPTY_SESSION,
    browsePly: null,
    aiThinking: false,
    commentsVisible: true,
    coachStream: null,
    coachRequest: null,
    busy: false,
    error: null,

    apply(session) {
      const previous = get()
      const total = session.game?.moves.length ?? 0
      let browsePly = previous.browsePly
      const changed = session.game?.id !== previous.session.game?.id
      if (changed) browsePly = null
      else if (browsePly !== null) browsePly = total === 0 ? null : Math.min(browsePly, total - 1)
      set({
        session,
        browsePly,
        aiThinking: session.ai.thinking,
        commentsVisible: session.game ? session.coach.commentsVisible : previous.commentsVisible,
        ...(changed ? { coachStream: null } : {})
      })
    },

    setBrowsePly(ply) {
      const total = get().session.game?.moves.length ?? 0
      if (ply === null || total === 0) {
        set({ browsePly: null })
        return
      }
      set({ browsePly: Math.min(Math.max(ply, -1), total - 1) })
    },

    browseBy(delta) {
      const state = get()
      const total = state.session.game?.moves.length ?? 0
      if (total === 0) return
      const next = (state.browsePly ?? total - 1) + delta
      if (next >= total - 1) {
        set({ browsePly: null })
        return
      }
      set({ browsePly: Math.max(-1, next) })
    },

    returnToLive() {
      set({ browsePly: null })
    },

    clearError() {
      set({ error: null })
    },

    applyStream(envelope) {
      if (!envelope || envelope.kind !== 'text') return
      const { session, coachStream } = get()
      // Only the coach streams into the feed: the opponent's turn carries its own id and its
      // deltas are JSON, which has no business in a prose card.
      if (!session.coach.streamId || envelope.streamId !== session.coach.streamId) return
      const previous = coachStream?.streamId === envelope.streamId ? coachStream.text : ''
      set({ coachStream: { streamId: envelope.streamId, text: previous + envelope.chunk } })
    },

    async refresh() {
      await call((api) => api.game.state(), applySession)
    },

    async newGame(options) {
      set({ commentsVisible: options.commentsVisible })
      const state = await call((api) => api.game.new(options), applySession)
      if (state) set({ browsePly: null })
      return state
    },

    async resume(id, options) {
      const state = await call((api) => api.game.resume(id, options), applySession)
      if (state) set({ browsePly: null })
      return state
    },

    async userMove(uci) {
      // Playing from a browsed position always means "play on the live board".
      set({ browsePly: null })
      await call((api) => api.game.userMove(uci), applySession)
    },

    async takeback() {
      await call((api) => api.game.takeback(), applySession)
    },

    async resign() {
      await call((api) => api.game.resign(), applySession)
    },

    async offerDraw() {
      return call((api) => api.game.offerDraw())
    },

    async close() {
      await call((api) => api.game.close(), applySession)
    },

    // --- Task 12: the coach in game (spec §4.2) ---

    async setCommentsVisible(visible) {
      set({ commentsVisible: visible })
      await call((api) => api.game.setCommentsVisible(visible), applySession)
    },

    async askCoach(question) {
      const asked = String(question ?? '').trim()
      if (asked.length === 0) return
      await coachCall('answer', (api) => api.game.askCoach(asked))
    },

    async requestHint() {
      await coachCall('hint', (api) => api.game.requestHint())
    },

    async clearHint() {
      await call((api) => api.game.clearHint(), applySession)
    },

    async commentSkipped() {
      await call((api) => api.game.commentSkipped(), applySession)
    },

    async navigateEval(fen) {
      // Deliberately outside `call()`: asking the engine for the score of the position on screen
      // is a background refresh, not a user action. Routing it through `call()` would raise
      // `busy` — and so grey out every control — for as long as the engine takes to answer, and
      // would turn a failed eval into a red alert over the board. Neither belongs here.
      const api = bridge()
      if (!api) return
      try {
        await api.game.navigateEval(fen)
      } catch {
        /* the eval bar simply keeps the last score it had */
      }
    }
  }
})

/**
 * Subscribes the store to `game:state` and reads the current one. Call it once from the shell;
 * the returned function unsubscribes.
 */
export function initGameStore(): () => void {
  const api = bridge()
  if (!api) return () => {}
  const unsubscribe = api.on('game:state', (session) => useGameStore.getState().apply(session))
  const unsubscribeStream = api.on('stream', (envelope) =>
    useGameStore.getState().applyStream(envelope)
  )
  void useGameStore.getState().refresh()
  return () => {
    unsubscribe()
    unsubscribeStream()
  }
}
