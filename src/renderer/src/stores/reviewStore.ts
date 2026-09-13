import { create } from 'zustand'
import { parseIpcError } from '@shared/ipcError'
import type { AnalysisProgress, AnalysisStatus, ReviewActivity, StreamEnvelope } from '@shared/types/api'
import type { Game } from '@shared/types/game'

/**
 * Renderer state of one open review (spec §4.4).
 *
 * The main process owns everything durable: the analysis pipeline, the `training` thread of the
 * review and the comments it saves into the game. This store is the window's view of that work —
 * which game is open, how far the analysis got, which ply the board shows, and the text of the
 * turn that is streaming right now — so the screen can stay a pure function of it.
 *
 * A review is opened for exactly one game at a time: opening another one, or closing the screen,
 * closes the thread in the main process (`review.close`).
 */

export const IDLE_STATUS: AnalysisStatus = { state: 'idle' }

/** The turn the main process announced on `review:activity`, while it is running. */
export interface ReviewActivityState {
  kind: ReviewActivity['kind']
  /** `Move.ply` (1-based) the turn is about; `null` for the lesson of the whole game. */
  ply: number | null
  streamId: string | null
}

export type ReviewRequest = ReviewActivity['kind']

export interface ReviewStoreState {
  gameId: string | null
  game: Game | null
  status: AnalysisStatus
  /** Ply shown on the board: `-1` is the starting position, then the index of the played ply. */
  cursor: number
  /** True while the game is being read from disk. */
  loading: boolean
  activity: ReviewActivityState | null
  /** Text of the review turn in flight, keyed by the `streamId` that announced it. */
  stream: { streamId: string; text: string } | null
  /** What *this* window asked for; the header buttons disable themselves on it. */
  request: ReviewRequest | null
  error: string | null

  open(gameId: string): Promise<void>
  close(): Promise<void>
  setCursor(cursor: number): void
  moveBy(delta: number): void
  analyze(): Promise<void>
  /** `ply` is `Move.ply`, 1-based, exactly as the IPC contract wants it. */
  commentMove(ply: number): Promise<void>
  commentKeyMoments(): Promise<void>
  lesson(): Promise<void>
  clearError(): void

  applyProgress(progress: AnalysisProgress): void
  applyActivity(activity: ReviewActivity): void
  applyStream(envelope: StreamEnvelope): void
}

/** The bridge is absent in unit tests and in a renderer opened without the preload. */
function bridge(): Window['api'] | undefined {
  return typeof window === 'undefined' ? undefined : window.api
}

function failure(error: unknown): string {
  const { message, code } = parseIpcError(error)
  return message.length > 0 ? message : code
}

/** Index of `ply` (1-based) in the move list, or `-1` when the game does not have it. */
export function cursorOfPly(game: Game | null | undefined, ply: number): number {
  const moves = game?.moves ?? []
  const index = moves.findIndex((move) => move.ply === ply)
  return index >= 0 ? index : Math.min(Math.max(ply - 1, -1), moves.length - 1)
}

/** Clamps a cursor to `[-1, moves.length - 1]`. */
export function clampCursor(game: Game | null | undefined, cursor: number): number {
  const total = game?.moves.length ?? 0
  if (total === 0) return -1
  return Math.min(Math.max(Math.round(cursor), -1), total - 1)
}

const CLEARED = {
  game: null,
  status: IDLE_STATUS,
  cursor: -1,
  loading: false,
  activity: null,
  stream: null,
  request: null,
  error: null
} as const

export const useReviewStore = create<ReviewStoreState>((set, get) => {
  /**
   * Applies a change to the open game without mutating the object the screen is rendering. A game
   * is exactly what the store keeps on disk, so a JSON round-trip is a faithful deep copy.
   */
  function patchGame(change: (game: Game) => Game): void {
    const current = get().game
    if (!current) return
    set({ game: change(JSON.parse(JSON.stringify(current)) as Game) })
  }

  /**
   * One review turn. Like the coach's, it is deliberately outside any global "busy" flag: a
   * comment can take half a minute and must not grey the whole screen out, only its own button.
   */
  async function turn(kind: ReviewRequest, run: (api: Window['api'], gameId: string) => Promise<void>): Promise<void> {
    const api = bridge()
    const gameId = get().gameId
    if (!api || !gameId) return
    set({ request: kind, error: null })
    try {
      await run(api, gameId)
    } catch (error) {
      set({ error: failure(error) })
    } finally {
      set({ request: null })
    }
  }

  return {
    gameId: null,
    ...CLEARED,

    async open(gameId) {
      const api = bridge()
      set({ gameId, ...CLEARED, loading: true })
      if (!api) {
        set({ loading: false })
        return
      }
      try {
        const game = await api.games.get(gameId)
        // A second `open()` may have overtaken this read: whoever asked last wins.
        if (get().gameId !== gameId) return
        const status = await api.analysis.status(gameId)
        if (get().gameId !== gameId) return
        set({ game, status, loading: false, cursor: clampCursor(game, (game?.moves.length ?? 0) - 1) })
        // The analysis of a game that has just finished is already running: joining it costs
        // nothing (the main process hands back the very same promise) and fills the screen.
        if (status.state === 'running') void get().analyze()
      } catch (error) {
        if (get().gameId !== gameId) return
        set({ loading: false, error: failure(error) })
      }
    },

    async close() {
      const api = bridge()
      set({ gameId: null, ...CLEARED })
      if (!api) return
      try {
        await api.review.close()
      } catch {
        /* the thread is closed by the main process on quit anyway */
      }
    },

    setCursor(cursor) {
      set({ cursor: clampCursor(get().game, cursor) })
    },

    moveBy(delta) {
      set({ cursor: clampCursor(get().game, get().cursor + delta) })
    },

    async analyze() {
      const api = bridge()
      const gameId = get().gameId
      if (!api || !gameId) return
      const total = get().game?.moves.length ?? 0
      set({ status: { state: 'running', ply: 0, total }, error: null })
      try {
        const game = await api.analysis.run(gameId)
        if (get().gameId !== gameId) return
        set({ game, status: { state: 'done', ply: game.moves.length, total: game.moves.length } })
      } catch (error) {
        if (get().gameId !== gameId) return
        const { code, message } = parseIpcError(error)
        if (code === 'ANALYSIS_UNAVAILABLE') {
          set({ status: { state: 'unavailable' }, error: null })
          return
        }
        set({ status: IDLE_STATUS, error: message.length > 0 ? message : code })
      }
    },

    async commentMove(ply) {
      await turn('move', async (api, gameId) => {
        const text = await api.review.commentMove(gameId, ply)
        patchGame((game) => {
          const move = game.moves.find((entry) => entry.ply === ply)
          if (move) move.coachComment = text
          return game
        })
      })
    },

    async commentKeyMoments() {
      await turn('keyMoments', async (api, gameId) => {
        const comments = await api.review.commentKeyMoments(gameId)
        patchGame((game) => {
          for (const comment of comments) {
            const move = game.moves.find((entry) => entry.ply === comment.ply)
            if (move) move.coachComment = comment.text
          }
          return game
        })
      })
    },

    async lesson() {
      await turn('lesson', async (api, gameId) => {
        const lesson = await api.review.lesson(gameId)
        patchGame((game) => {
          if (game.analysis) game.analysis.lesson = lesson
          return game
        })
      })
    },

    clearError() {
      set({ error: null })
    },

    applyProgress(progress) {
      if (!progress || progress.gameId !== get().gameId) return
      set({ status: { state: 'running', ply: progress.ply, total: progress.total } })
    },

    applyActivity(activity) {
      if (!activity || activity.gameId !== get().gameId) return
      if (!activity.busy && !activity.streamId) {
        set({ activity: null })
        return
      }
      set({
        activity: { kind: activity.kind, ply: activity.ply, streamId: activity.streamId },
        ...(activity.streamId ? { stream: null } : {})
      })
    },

    applyStream(envelope) {
      if (!envelope || envelope.kind !== 'text') return
      const { activity, stream } = get()
      if (!activity?.streamId || envelope.streamId !== activity.streamId) return
      const previous = stream?.streamId === envelope.streamId ? stream.text : ''
      set({ stream: { streamId: envelope.streamId, text: previous + envelope.chunk } })
    }
  }
})

/**
 * Subscribes the store to the three channels a review listens to. The screen calls it while it is
 * mounted; the returned function unsubscribes.
 */
export function initReviewStore(): () => void {
  const api = bridge()
  if (!api) return () => {}
  const unsubscribe = [
    api.on('analysis:progress', (progress) => useReviewStore.getState().applyProgress(progress)),
    api.on('review:activity', (activity) => useReviewStore.getState().applyActivity(activity)),
    api.on('stream', (envelope) => useReviewStore.getState().applyStream(envelope))
  ]
  return () => {
    for (const stop of unsubscribe) stop()
  }
}
