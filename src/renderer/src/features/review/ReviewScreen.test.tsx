import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { Game, Move } from '@shared/types/game'
import { encodeIpcErrorMessage } from '@shared/ipcError'
import { IDLE_STATUS, useReviewStore } from '../../stores/reviewStore'
import { useEngineStore } from '../../stores/engineStore'

/**
 * The review against a mocked bridge (chessground needs layout APIs jsdom does not implement, so
 * the board is the only stand-in). Everything else is the real screen: the numbers of the
 * analysis, the graph, the key moments, the per-move panel and the three review turns.
 */
vi.mock('@lichess-org/chessground', () => ({
  Chessground: (el: HTMLElement) => {
    el.innerHTML = '<cg-container></cg-container>'
    return { set: () => {}, destroy: () => {}, redrawAll: () => {} }
  }
}))

const { ReviewScreen } = await import('./ReviewScreen')

const FEN_1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
const FEN_2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'
const FEN_3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'

function move(
  ply: number,
  san: string,
  uci: string,
  fenAfter: string,
  by: Move['by'],
  patch: Partial<Move> = {}
): Move {
  return {
    ply,
    san,
    uci,
    fenAfter,
    epdAfter: fenAfter.split(' ').slice(0, 4).join(' '),
    by,
    ...patch
  }
}

/** Three plies whose last one is a blunder of the user: the only key moment of the game. */
function analysedGame(): Game {
  return {
    id: 'g1',
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:05:00.000Z',
    kind: 'match',
    status: 'finished',
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
      move(1, 'e4', 'e2e4', FEN_1, 'user', {
        eval: {
          before: { cp: 20 },
          after: { cp: 15 },
          cpLoss: 5,
          winPercentLoss: 0.9,
          classification: 'best',
          bestMove: 'e2e4',
          bestLine: ['e2e4', 'e7e5']
        }
      }),
      move(2, 'e5', 'e7e5', FEN_2, 'ai', {
        eval: {
          before: { cp: -15 },
          after: { cp: -20 },
          cpLoss: 5,
          winPercentLoss: 0.9,
          classification: 'excellent',
          bestMove: 'e7e5',
          bestLine: ['e7e5']
        }
      }),
      move(3, 'Nf3', 'g1f3', FEN_3, 'user', {
        eval: {
          before: { cp: 20 },
          after: { cp: -300 },
          cpLoss: 320,
          winPercentLoss: 45.2,
          classification: 'blunder',
          bestMove: 'd2d4',
          bestLine: ['d2d4', 'd7d5']
        }
      })
    ],
    takebacks: 0,
    coachLog: [],
    result: { outcome: '0-1', reason: 'resign' },
    opening: { eco: 'C40', name: "King's Knight Opening", lastBookPly: 3 },
    analysis: {
      accuracy: { w: 62.4, b: 88.2 },
      acpl: { w: 108, b: 12 },
      keyMoments: [3],
      analyzedAt: '2026-09-12T10:06:00.000Z'
    }
  }
}

const unanalysed = (): Game => {
  const game = analysedGame()
  delete game.analysis
  for (const move of game.moves) delete move.eval
  return game
}

const getGame = vi.fn(async () => analysedGame())
const status = vi.fn(async () => ({ state: 'done', ply: 3, total: 3 }) as never)
const run = vi.fn(async () => analysedGame())
const commentMove = vi.fn(async () => 'La casa f3 lasciava il pedone e4 indifeso.')
const commentKeyMoments = vi.fn(async () => [{ ply: 3, text: 'Momento chiave commentato.' }])
const lesson = vi.fn(
  async () =>
    ({
      takeaways: ['Guarda le forchette', 'Sviluppa i pezzi', 'Controlla il centro'],
      summary: 'Partita persa per una svista.',
      language: 'it'
    }) as never
)
const close = vi.fn(async () => undefined)
const off = vi.fn()
const listeners = new Map<string, (payload: never) => void>()

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
  useEngineStore.setState({
    state: { available: true, binary: 'avx2', version: 'Stockfish 17.1', message: null },
    available: true,
    error: null
  })
}

async function open(): Promise<void> {
  render(<ReviewScreen gameId="g1" onClose={() => {}} />)
  await screen.findByText('62.4%')
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockApi()
})

afterEach(cleanup)

describe('ReviewScreen', () => {
  it('shows the result, the opening and the accuracy of both colours', async () => {
    await open()
    expect(screen.getByText(/Hai perso/)).toBeInTheDocument()
    expect(screen.getByText('62.4%')).toBeInTheDocument()
    expect(screen.getByText('88.2%')).toBeInTheDocument()
    expect(screen.getByText('ACPL 108')).toBeInTheDocument()
    expect(screen.getByText(/gpt-6-astra/)).toBeInTheDocument()
  })

  it('draws the graph with one point per position', async () => {
    const { container } = render(<ReviewScreen gameId="g1" onClose={() => {}} />)
    await screen.findByText('62.4%')
    expect(container.querySelectorAll('[data-testid="eval-graph"] [data-ply]')).toHaveLength(4)
  })

  it('lists the key moments and navigates to the one that is clicked', async () => {
    await open()
    const moment = screen.getByRole('button', { name: /3\. Nf3/ })
    expect(moment).toHaveTextContent('al posto di d4')
    expect(moment).toHaveTextContent('45.2')
    fireEvent.click(moment)
    await waitFor(() => expect(useReviewStore.getState().cursor).toBe(2))
    expect(screen.getByRole('heading', { name: '3. Nf3' })).toBeInTheDocument()
    // The judgement appears twice on purpose: on the chip of the moment and in the move panel.
    expect(screen.getAllByText('Errore grave').length).toBeGreaterThanOrEqual(2)
  })

  it('walks the game with the arrow keys of the move list', async () => {
    await open()
    const list = screen.getByRole('group', { name: /frecce/ })
    fireEvent.keyDown(list, { key: 'Home' })
    await waitFor(() => expect(useReviewStore.getState().cursor).toBe(-1))
    fireEvent.keyDown(list, { key: 'ArrowRight' })
    await waitFor(() => expect(useReviewStore.getState().cursor).toBe(0))
    fireEvent.keyDown(list, { key: 'End' })
    await waitFor(() => expect(useReviewStore.getState().cursor).toBe(2))
    fireEvent.keyDown(list, { key: 'ArrowLeft' })
    await waitFor(() => expect(useReviewStore.getState().cursor).toBe(1))
  })

  it('walks the game with the arrow keys from anywhere on the screen', async () => {
    await open()
    fireEvent.keyDown(window, { key: 'Home' })
    await waitFor(() => expect(useReviewStore.getState().cursor).toBe(-1))
    fireEvent.keyDown(window, { key: 'ArrowRight' })
    await waitFor(() => expect(useReviewStore.getState().cursor).toBe(0))
    fireEvent.keyDown(window, { key: 'End' })
    await waitFor(() => expect(useReviewStore.getState().cursor).toBe(2))
    fireEvent.keyDown(window, { key: 'ArrowLeft' })
    await waitFor(() => expect(useReviewStore.getState().cursor).toBe(1))
  })

  it('shows the best line of the selected move in SAN', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: /3\. Nf3/ }))
    expect(await screen.findByText(/Migliore: 2\. d4 d5/)).toBeInTheDocument()
  })

  it('asks the coach to comment the selected move and shows the answer', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: /3\. Nf3/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Commenta questa mossa' }))
    await waitFor(() => expect(commentMove).toHaveBeenCalledWith('g1', 3))
    expect(await screen.findByText(/pedone e4 indifeso/)).toBeInTheDocument()
  })

  it('comments every key moment in one go', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Commenta i momenti chiave' }))
    await waitFor(() => expect(commentKeyMoments).toHaveBeenCalledWith('g1'))
    expect(useReviewStore.getState().game?.moves[2]?.coachComment).toBe(
      'Momento chiave commentato.'
    )
  })

  it('writes the lesson of the game with its three takeaways', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: 'Lezione della partita' }))
    await waitFor(() => expect(lesson).toHaveBeenCalledWith('g1'))
    expect(await screen.findByText('Guarda le forchette')).toBeInTheDocument()
    expect(screen.getByText('Sviluppa i pezzi')).toBeInTheDocument()
    expect(screen.getByText('Controlla il centro')).toBeInTheDocument()
    expect(screen.getByText('Partita persa per una svista.')).toBeInTheDocument()
  })

  it('streams the comment in flight into the card of the move it is about', async () => {
    await open()
    fireEvent.click(screen.getByRole('button', { name: /3\. Nf3/ }))
    const activity = listeners.get('review:activity')!
    const stream = listeners.get('stream')!
    activity({ gameId: 'g1', kind: 'move', ply: 3, streamId: 's1', busy: true } as never)
    stream({
      streamId: 's1',
      threadId: 't',
      turnId: 'u',
      itemId: 'i',
      kind: 'text',
      chunk: 'Il cavallo'
    } as never)
    expect(await screen.findByText(/Il cavallo/)).toBeInTheDocument()
  })

  it('follows the progress of an analysis that is still running', async () => {
    status.mockResolvedValueOnce({ state: 'running', ply: 0, total: 3 } as never)
    run.mockImplementationOnce(() => new Promise(() => {}))
    render(<ReviewScreen gameId="g1" onClose={() => {}} />)
    await waitFor(() => expect(screen.getByRole('progressbar')).toBeInTheDocument())
    listeners.get('analysis:progress')!({ gameId: 'g1', ply: 2, total: 3 } as never)
    await waitFor(() =>
      expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '2')
    )
    expect(screen.getByText(/semimossa 2 di 3/)).toBeInTheDocument()
  })

  it('offers to analyse a game nobody has analysed yet', async () => {
    getGame.mockResolvedValueOnce(unanalysed())
    status.mockResolvedValueOnce({ state: 'idle' } as never)
    render(<ReviewScreen gameId="g1" onClose={() => {}} />)
    const analyse = await screen.findByRole('button', { name: 'Analizza' })
    expect(screen.getByText('Partita non ancora analizzata')).toBeInTheDocument()
    expect(screen.getByText(/Questa partita non è ancora stata analizzata/)).toBeInTheDocument()
    fireEvent.click(analyse)
    await waitFor(() => expect(run).toHaveBeenCalledWith('g1'))
    expect(await screen.findByText('62.4%')).toBeInTheDocument()
  })

  it('says so when the engine is missing instead of pretending to analyse', async () => {
    getGame.mockResolvedValueOnce(unanalysed())
    status.mockResolvedValueOnce({ state: 'unavailable' } as never)
    render(<ReviewScreen gameId="g1" onClose={() => {}} />)
    expect(await screen.findByText(/Stockfish non disponibile/)).toBeInTheDocument()
    expect(screen.getByText('Analisi non disponibile')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Analizza' })).toBeNull()
    // Spec §8: without the engine the review is the coach's prose, so the lesson is the way on.
    expect(screen.getAllByRole('button', { name: 'Lezione della partita' }).length).toBeGreaterThan(
      1
    )
  })

  it('shows a failed review turn without losing the screen', async () => {
    await open()
    lesson.mockRejectedValueOnce(
      new Error(encodeIpcErrorMessage('REVIEW_TURN_FAILED', 'il turno è fallito'))
    )
    fireEvent.click(screen.getByRole('button', { name: 'Lezione della partita' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('il turno è fallito')
    expect(screen.getByText('62.4%')).toBeInTheDocument()
  })

  it('closes the review thread when it leaves the screen', async () => {
    const { unmount } = render(<ReviewScreen gameId="g1" onClose={() => {}} />)
    await screen.findByText('62.4%')
    unmount()
    await waitFor(() => expect(close).toHaveBeenCalled())
    expect(off).toHaveBeenCalled()
  })
})
