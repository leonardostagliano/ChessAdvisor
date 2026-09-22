import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Game, Move } from '@shared/types/game'
import type { SessionState } from '@shared/types/session'
import {
  EMPTY_SESSION,
  START_FEN,
  boardFen,
  boardLastMove,
  fenAtPly,
  isBrowsing,
  useGameStore
} from './gameStore'

const FEN_1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
const FEN_2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'
const FEN_3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'

function move(ply: number, san: string, uci: string, fenAfter: string, by: Move['by']): Move {
  return { ply, san, uci, fenAfter, epdAfter: fenAfter.split(' ').slice(0, 4).join(' '), by }
}

function game(): Game {
  return {
    id: 'g1',
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:05:00.000Z',
    kind: 'match',
    status: 'in_progress',
    userColor: 'w',
    opponent: {
      model: 'gpt-6-astra',
      effort: 'low',
      difficulty: { mode: 'fixed', level: 3, targetElo: 1200 }
    },
    coach: { model: 'gpt-6-astra', effort: 'low' },
    clock: null,
    language: 'it',
    moves: [
      move(0, 'e4', 'e2e4', FEN_1, 'user'),
      move(1, 'e5', 'e7e5', FEN_2, 'ai'),
      move(2, 'Nf3', 'g1f3', FEN_3, 'user')
    ],
    takebacks: 0,
    coachLog: []
  }
}

function session(patch: Partial<SessionState> = {}): SessionState {
  return {
    ...EMPTY_SESSION,
    game: game(),
    fen: FEN_3,
    turn: 'b',
    userToMove: false,
    status: 'playing',
    ...patch
  }
}

beforeEach(() => {
  useGameStore.setState({
    session: EMPTY_SESSION,
    browsePly: null,
    aiThinking: false,
    commentsVisible: true,
    coachStream: null,
    coachRequest: null,
    coachRequestPosition: null,
    busy: false,
    error: null
  })
})

describe('gameStore', () => {
  it('clears a deleted game and ignores a delayed IPC answer for its id', () => {
    const deleted = session({ game: { ...game(), id: 'deleted-game' } })
    useGameStore.getState().apply(deleted)
    useGameStore.getState().setBrowsePly(1)
    useGameStore.getState().discardDeletedGame('deleted-game')

    expect(useGameStore.getState()).toMatchObject({
      session: { game: null, status: 'idle' },
      browsePly: null,
      aiThinking: false
    })
    useGameStore.getState().apply(deleted)
    expect(useGameStore.getState().session.game).toBeNull()
    useGameStore.getState().apply(session({ game: { ...game(), id: 'another-game' } }))
    expect(useGameStore.getState().session.game?.id).toBe('another-game')
  })

  it('starts on the initial position with nothing in flight', () => {
    const state = useGameStore.getState()
    expect(state.session.game).toBeNull()
    expect(boardFen(state)).toBe(START_FEN)
    expect(state.aiThinking).toBe(false)
  })

  it('mirrors game:state, including the derived aiThinking flag', () => {
    useGameStore.getState().apply(
      session({
        ai: { thinking: true, startedAt: 10, reasoning: 'ok', retries: 0, streamId: 's1' }
      })
    )
    const state = useGameStore.getState()
    expect(state.session.fen).toBe(FEN_3)
    expect(state.aiThinking).toBe(true)
    useGameStore.getState().apply(session())
    expect(useGameStore.getState().aiThinking).toBe(false)
  })

  it('derives the FEN of the browsed ply from the move list', () => {
    const store = useGameStore.getState()
    store.apply(session())
    store.setBrowsePly(1)

    let state = useGameStore.getState()
    expect(isBrowsing(state)).toBe(true)
    expect(boardFen(state)).toBe(FEN_2)
    expect(boardLastMove(state)).toEqual(['e7', 'e5'])

    // -1 is the position before the first move.
    useGameStore.getState().setBrowsePly(-1)
    state = useGameStore.getState()
    expect(boardFen(state)).toBe(START_FEN)
    expect(boardLastMove(state)).toBeUndefined()

    useGameStore.getState().returnToLive()
    state = useGameStore.getState()
    expect(isBrowsing(state)).toBe(false)
    expect(boardFen(state)).toBe(FEN_3)
    expect(boardLastMove(state)).toEqual(['g1', 'f3'])
  })

  it('fenAtPly falls back to the start position of the game', () => {
    const drill = { ...game(), startFen: FEN_1, moves: [] }
    expect(fenAtPly(drill, -1)).toBe(FEN_1)
    expect(fenAtPly(drill, 5)).toBe(FEN_1)
    expect(fenAtPly(null, 0)).toBe(START_FEN)
    expect(fenAtPly(game(), 0)).toBe(FEN_1)
  })

  it('walks the move list and clamps at both ends', () => {
    const store = useGameStore.getState()
    store.apply(session())
    store.browseBy(-1)
    expect(useGameStore.getState().browsePly).toBe(1)
    useGameStore.getState().browseBy(-5)
    expect(useGameStore.getState().browsePly).toBe(-1)
    useGameStore.getState().browseBy(1)
    expect(useGameStore.getState().browsePly).toBe(0)
    useGameStore.getState().browseBy(9)
    // Walking past the last move returns to the live position.
    expect(useGameStore.getState().browsePly).toBeNull()
  })

  it('keeps the browsed ply when a move arrives, and drops it when the game changes', () => {
    const store = useGameStore.getState()
    store.apply(session())
    store.setBrowsePly(0)

    const longer = game()
    longer.moves.push(move(3, 'Nc6', 'b8c6', FEN_3, 'ai'))
    useGameStore.getState().apply(session({ game: longer }))
    expect(useGameStore.getState().browsePly).toBe(0)

    useGameStore.getState().apply(session({ game: { ...game(), id: 'g2' } }))
    expect(useGameStore.getState().browsePly).toBeNull()
  })

  it('clamps the browsed ply after a takeback', () => {
    const store = useGameStore.getState()
    store.apply(session())
    store.setBrowsePly(2)
    const shorter = { ...game(), moves: game().moves.slice(0, 1) }
    useGameStore.getState().apply(session({ game: shorter, fen: FEN_1 }))
    expect(useGameStore.getState().browsePly).toBe(0)
  })

  it('sends a user move through the bridge and applies the state it answers with', async () => {
    const next = session({ fen: FEN_1 })
    const userMove = vi.fn().mockResolvedValue(next)
    vi.stubGlobal('window', Object.assign(window, { api: { game: { userMove } } }))

    await useGameStore.getState().userMove('e2e4')
    expect(userMove).toHaveBeenCalledWith('e2e4')
    expect(useGameStore.getState().session.fen).toBe(FEN_1)
    expect(useGameStore.getState().busy).toBe(false)
  })

  it('never marks the store busy for a browse eval, so the controls stay usable', async () => {
    // Held in an object so TypeScript cannot narrow the assignment away to `null`.
    const deferred = { resolve: () => {} }
    const navigateEval = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          deferred.resolve = resolve
        })
    )
    vi.stubGlobal('window', Object.assign(window, { api: { game: { navigateEval } } }))

    const pending = useGameStore.getState().navigateEval(FEN_2)
    expect(navigateEval).toHaveBeenCalledWith(FEN_2)
    // The request is still in flight: nothing on the play screen may be disabled because of it.
    expect(useGameStore.getState().busy).toBe(false)
    deferred.resolve()
    await pending
    expect(useGameStore.getState().busy).toBe(false)
  })

  it('swallows a failed browse eval instead of raising an alert over the board', async () => {
    const navigateEval = vi.fn().mockRejectedValue(new Error('ENGINE_UNAVAILABLE: no engine'))
    vi.stubGlobal('window', Object.assign(window, { api: { game: { navigateEval } } }))

    await expect(useGameStore.getState().navigateEval(FEN_2)).resolves.toBeUndefined()
    expect(useGameStore.getState().error).toBeNull()
  })

  it('runs a coach turn without marking the store busy, and remembers what it asked for', async () => {
    const deferred = { resolve: (_: SessionState) => {} }
    const askCoach = vi.fn(
      () =>
        new Promise<SessionState>((resolve) => {
          deferred.resolve = resolve
        })
    )
    vi.stubGlobal('window', Object.assign(window, { api: { game: { askCoach } } }))

    useGameStore.getState().apply(session())
    const pending = useGameStore.getState().askCoach('  Che piano seguo?  ')
    expect(askCoach).toHaveBeenCalledWith('Che piano seguo?')
    // A question can take half a minute: greying out every game control for that long would be
    // the wrong trade, so the coach has its own in-flight marker.
    expect(useGameStore.getState().busy).toBe(false)
    expect(useGameStore.getState().coachRequest).toBe('answer')
    expect(useGameStore.getState().coachRequestPosition).toEqual({ gameId: 'g1', fen: FEN_3 })
    useGameStore.getState().apply(session({ fen: FEN_1 }))
    expect(useGameStore.getState().coachRequestPosition).toEqual({ gameId: 'g1', fen: FEN_3 })

    deferred.resolve(session())
    await pending
    expect(useGameStore.getState().coachRequest).toBeNull()
    expect(useGameStore.getState().coachRequestPosition).toBeNull()
    expect(useGameStore.getState().session.fen).toBe(FEN_3)
  })

  it('releases Coach controls on a new game and ignores the old delayed answer', async () => {
    let finish!: (value: SessionState) => void
    const askCoach = vi.fn(
      () =>
        new Promise<SessionState>((resolve) => {
          finish = resolve
        })
    )
    vi.stubGlobal('window', Object.assign(window, { api: { game: { askCoach } } }))
    useGameStore.getState().apply(session())
    const pending = useGameStore.getState().askCoach('Quale piano?')
    const next = session({ game: { ...game(), id: 'new-coach-game' } })
    useGameStore.getState().apply(next)
    expect(useGameStore.getState().coachRequest).toBeNull()
    expect(useGameStore.getState().coachRequestPosition).toBeNull()
    finish(session())
    await pending
    expect(useGameStore.getState().session.game?.id).toBe('new-coach-game')
  })

  it('collects the deltas of the coach turn in flight and ignores every other stream', () => {
    useGameStore
      .getState()
      .apply(session({ coach: { ...EMPTY_SESSION.coach, busy: true, streamId: 's-coach' } }))
    const store = useGameStore.getState()
    store.applyStream({
      streamId: 's-ai',
      threadId: 't',
      turnId: 'u',
      itemId: 'i',
      kind: 'text',
      chunk: 'ignored'
    })
    store.applyStream({
      streamId: 's-coach',
      threadId: 't',
      turnId: 'u',
      itemId: 'i',
      kind: 'reasoning',
      chunk: 'ignored'
    })
    store.applyStream({
      streamId: 's-coach',
      threadId: 't',
      turnId: 'u',
      itemId: 'i',
      kind: 'text',
      chunk: 'Buona '
    })
    store.applyStream({
      streamId: 's-coach',
      threadId: 't',
      turnId: 'u',
      itemId: 'i',
      kind: 'text',
      chunk: 'apertura.'
    })
    expect(useGameStore.getState().coachStream).toEqual({
      streamId: 's-coach',
      text: 'Buona apertura.'
    })

    // A different game starts with an empty feed.
    useGameStore.getState().apply(session({ game: { ...game(), id: 'g2' } }))
    expect(useGameStore.getState().coachStream).toBeNull()
  })

  it('keeps the failure of a call in the store instead of throwing at the caller', async () => {
    const resign = vi
      .fn()
      .mockRejectedValue(
        new Error(
          "Error invoking remote method 'game:resign': GameError: NO_GAME: no game is running"
        )
      )
    vi.stubGlobal('window', Object.assign(window, { api: { game: { resign } } }))

    await expect(useGameStore.getState().resign()).resolves.toBeUndefined()
    expect(useGameStore.getState().error).toBe('no game is running')
    expect(useGameStore.getState().busy).toBe(false)
  })
})
