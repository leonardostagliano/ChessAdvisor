import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encodeIpcErrorMessage } from '@shared/ipcError'
import type { Game, Move } from '@shared/types/game'
import { IDLE_STATUS, clampCursor, cursorOfPly, initReviewStore, useReviewStore } from './reviewStore'

const FEN_1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
const FEN_2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'
const FEN_3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'

function move(ply: number, san: string, uci: string, fenAfter: string, by: Move['by'], patch: Partial<Move> = {}): Move {
  return { ply, san, uci, fenAfter, epdAfter: fenAfter.split(' ').slice(0, 4).join(' '), by, ...patch }
}

function game(patch: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:05:00.000Z',
    kind: 'match',
    status: 'finished',
    userColor: 'w',
    opponent: { model: 'gpt-6-astra', effort: 'low', difficulty: { mode: 'fixed', level: 3, targetElo: 1200 } },
    coach: { model: 'gpt-6-astra', effort: 'low' },
    clock: null,
    language: 'it',
    moves: [move(1, 'e4', 'e2e4', FEN_1, 'user'), move(2, 'e5', 'e7e5', FEN_2, 'ai'), move(3, 'Nf3', 'g1f3', FEN_3, 'user')],
    takebacks: 0,
    coachLog: [],
    result: { outcome: '1-0', reason: 'resign' },
    ...patch
  }
}

const analysed = (): Game =>
  game({
    analysis: { accuracy: { w: 88.2, b: 61.5 }, acpl: { w: 21, b: 84 }, keyMoments: [3], analyzedAt: '2026-09-12T10:06:00.000Z' }
  })

const getGame = vi.fn(async () => game())
const status = vi.fn(async () => ({ state: 'idle' }) as const)
const run = vi.fn(async () => analysed())
const commentMove = vi.fn(async () => 'Commento finto in revisione.')
const commentKeyMoments = vi.fn(async () => [{ ply: 3, text: 'Momento chiave.' }])
const lesson = vi.fn(async () => ({ takeaways: ['a', 'b', 'c'], summary: 'fake', language: 'it' }) as const)
const close = vi.fn(async () => undefined)
const listeners = new Map<string, (payload: never) => void>()
const off = vi.fn()

function mockApi(): void {
  listeners.clear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      games: { get: getGame },
      analysis: { run, status },
      review: { commentMove, commentKeyMoments, lesson, close },
      on: (channel: string, cb: (payload: never) => void) => {
        listeners.set(channel, cb)
        return off
      }
    }
  })
}

function reset(): void {
  useReviewStore.setState({
    gameId: null,
    game: null,
    status: IDLE_STATUS,
    cursor: -1,
    loading: false,
    activity: null,
    stream: null,
    request: null,
    error: null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockApi()
})

describe('cursorOfPly', () => {
  it('maps a 1-based ply to its index in the move list', () => {
    expect(cursorOfPly(game(), 1)).toBe(0)
    expect(cursorOfPly(game(), 3)).toBe(2)
  })

  it('clamps a ply the game does not have', () => {
    expect(cursorOfPly(game(), 99)).toBe(2)
    expect(cursorOfPly(null, 4)).toBe(-1)
  })
})

describe('clampCursor', () => {
  it('keeps the cursor inside the game', () => {
    expect(clampCursor(game(), -5)).toBe(-1)
    expect(clampCursor(game(), 9)).toBe(2)
    expect(clampCursor(game({ moves: [] }), 2)).toBe(-1)
  })
})

describe('reviewStore.open', () => {
  it('reads the game, its analysis status and shows the last ply', async () => {
    await useReviewStore.getState().open('g1')
    const state = useReviewStore.getState()
    expect(getGame).toHaveBeenCalledWith('g1')
    expect(state.game?.id).toBe('g1')
    expect(state.status).toEqual({ state: 'idle' })
    expect(state.cursor).toBe(2)
    expect(state.loading).toBe(false)
  })

  it('joins an analysis that is already running', async () => {
    status.mockResolvedValueOnce({ state: 'running', ply: 1, total: 3 } as never)
    await useReviewStore.getState().open('g1')
    await vi.waitFor(() => expect(useReviewStore.getState().status.state).toBe('done'))
    expect(run).toHaveBeenCalledWith('g1')
    expect(useReviewStore.getState().game?.analysis?.accuracy.w).toBe(88.2)
  })

  it('keeps the failure of the read', async () => {
    getGame.mockRejectedValueOnce(new Error('disk is gone'))
    await useReviewStore.getState().open('g1')
    expect(useReviewStore.getState().error).toContain('disk is gone')
    expect(useReviewStore.getState().loading).toBe(false)
  })
})

describe('reviewStore.analyze', () => {
  it('runs the pipeline and keeps the analysed game', async () => {
    await useReviewStore.getState().open('g1')
    await useReviewStore.getState().analyze()
    const state = useReviewStore.getState()
    expect(state.status).toEqual({ state: 'done', ply: 3, total: 3 })
    expect(state.game?.analysis?.keyMoments).toEqual([3])
  })

  it('turns ANALYSIS_UNAVAILABLE into the unavailable state, not into an error', async () => {
    await useReviewStore.getState().open('g1')
    run.mockRejectedValueOnce(new Error(encodeIpcErrorMessage('ANALYSIS_UNAVAILABLE', 'no engine')))
    await useReviewStore.getState().analyze()
    expect(useReviewStore.getState().status).toEqual({ state: 'unavailable' })
    expect(useReviewStore.getState().error).toBeNull()
  })
})

describe('reviewStore review turns', () => {
  it('saves the comment of one move into the open game', async () => {
    await useReviewStore.getState().open('g1')
    await useReviewStore.getState().commentMove(3)
    expect(commentMove).toHaveBeenCalledWith('g1', 3)
    expect(useReviewStore.getState().game?.moves[2]?.coachComment).toBe('Commento finto in revisione.')
    expect(useReviewStore.getState().request).toBeNull()
  })

  it('saves one comment per key moment', async () => {
    await useReviewStore.getState().open('g1')
    await useReviewStore.getState().commentKeyMoments()
    expect(useReviewStore.getState().game?.moves[2]?.coachComment).toBe('Momento chiave.')
  })

  it('saves the lesson into the analysis', async () => {
    getGame.mockResolvedValueOnce(analysed())
    await useReviewStore.getState().open('g1')
    await useReviewStore.getState().lesson()
    expect(useReviewStore.getState().game?.analysis?.lesson?.takeaways).toEqual(['a', 'b', 'c'])
  })

  it('keeps a failed turn as an error and clears the request', async () => {
    await useReviewStore.getState().open('g1')
    commentMove.mockRejectedValueOnce(new Error(encodeIpcErrorMessage('REVIEW_TURN_FAILED', 'the turn failed')))
    await useReviewStore.getState().commentMove(1)
    expect(useReviewStore.getState().error).toContain('the turn failed')
    expect(useReviewStore.getState().request).toBeNull()
  })
})

describe('reviewStore events', () => {
  it('mirrors the progress of the open game only', async () => {
    await useReviewStore.getState().open('g1')
    useReviewStore.getState().applyProgress({ gameId: 'other', ply: 2, total: 9 })
    expect(useReviewStore.getState().status.state).toBe('idle')
    useReviewStore.getState().applyProgress({ gameId: 'g1', ply: 2, total: 3 })
    expect(useReviewStore.getState().status).toEqual({ state: 'running', ply: 2, total: 3 })
  })

  it('collects the deltas of the announced stream and drops the others', async () => {
    await useReviewStore.getState().open('g1')
    useReviewStore.getState().applyActivity({ gameId: 'g1', kind: 'move', ply: 3, streamId: 's1', busy: true })
    const delta = (streamId: string, chunk: string): void =>
      useReviewStore.getState().applyStream({ streamId, threadId: 't', turnId: 'u', itemId: 'i', kind: 'text', chunk })
    delta('s1', 'Il ')
    delta('other', 'no')
    delta('s1', 'commento')
    expect(useReviewStore.getState().stream?.text).toBe('Il commento')
    useReviewStore.getState().applyActivity({ gameId: 'g1', kind: 'move', ply: 3, streamId: null, busy: false })
    expect(useReviewStore.getState().activity).toBeNull()
  })

  it('subscribes to the three channels and unsubscribes', () => {
    const stop = initReviewStore()
    expect([...listeners.keys()].sort()).toEqual(['analysis:progress', 'review:activity', 'stream'])
    stop()
    expect(off).toHaveBeenCalledTimes(3)
  })
})

describe('reviewStore.close', () => {
  it('closes the thread in the main process and forgets the game', async () => {
    await useReviewStore.getState().open('g1')
    await useReviewStore.getState().close()
    expect(close).toHaveBeenCalled()
    expect(useReviewStore.getState().gameId).toBeNull()
    expect(useReviewStore.getState().game).toBeNull()
  })
})
