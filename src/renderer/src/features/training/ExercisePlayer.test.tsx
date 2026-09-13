import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { AttemptResult, Exercise } from '@shared/types/training'
import { useTrainingStore } from '../../stores/trainingStore'

/**
 * The exercise player against a mocked bridge (spec §6.4–§6.5).
 *
 * The board is replaced by a stub with one button, because chessground needs layout APIs jsdom
 * does not have: what matters here is the contract between the moves the user plays and the
 * answers of the main process — the feedback, the auto-played reply, the solution offered after
 * two failures and the explanation that streams.
 */

const board = vi.hoisted(() => ({ move: 'e2e4' }))

vi.mock('../../board/Board', () => ({
  Board: ({
    fen,
    onMove,
    viewOnly,
    movable
  }: {
    fen: string
    onMove?: (uci: string) => void
    viewOnly?: boolean
    movable?: { color?: string }
  }) => (
    <div data-testid="board" data-fen={fen} data-viewonly={viewOnly ? 'true' : 'false'} data-movable={movable?.color ?? ''}>
      <button type="button" data-testid="play" onClick={() => onMove?.(board.move)}>
        play
      </button>
    </div>
  )
}))

const { ExercisePlayer } = await import('./ExercisePlayer')

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
const AFTER_E5 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'
// chess.js only writes the en-passant square when the capture is actually available, so the
// position the player computes for the user's own move has none.
const AFTER_E4_PLAYED = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'

function exercise(patch: Partial<Exercise> = {}): Exercise {
  return {
    id: 'ex1',
    kind: 'thematic',
    fen: START,
    sideToMove: 'w',
    solution: ['e2e4', 'e7e5', 'g1f3'],
    theme: 'fork',
    rating: 1100,
    status: 'new',
    attempts: 0,
    createdAt: '2026-09-13T10:00:00.000Z',
    ...patch
  }
}

const attempt = vi.fn<(id: string, uci: string) => Promise<AttemptResult>>()
const explain = vi.fn(async () => 'Spiegazione finta.')
const reset = vi.fn(async () => exercise())

function mockApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { training: { exercises: { attempt, reset, explain } }, on: () => () => {} }
  })
}

const CORRECT: AttemptResult = { correct: true, done: false, reply: 'e7e5', fen: AFTER_E5, alternativesAccepted: false }
const WRONG: AttemptResult = { correct: false, done: false, fen: START, alternativesAccepted: false }

beforeEach(() => {
  vi.clearAllMocks()
  board.move = 'e2e4'
  mockApi()
  useTrainingStore.setState({ request: null, activity: null, stream: null, explanations: {}, exercises: [], error: null })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

describe('ExercisePlayer', () => {
  it('asks for the best move of the side that has to play, with theme and rating', () => {
    render(<ExercisePlayer exercise={exercise({ sideToMove: 'b', fen: AFTER_E4 })} />)
    expect(screen.getByText('Trova la mossa migliore per il Nero')).toBeInTheDocument()
    expect(screen.getByText('Forchetta')).toBeInTheDocument()
    expect(screen.getByText('Rating 1100')).toBeInTheDocument()
  })

  it('shows the progress of a set when it is played inside one', () => {
    render(<ExercisePlayer exercise={exercise()} position={{ index: 3, total: 10 }} />)
    expect(screen.getByTestId('exercise-position')).toHaveTextContent('3/10')
  })

  it('accepts the move of the solution and plays the reply after it', async () => {
    attempt.mockResolvedValueOnce(CORRECT)
    render(<ExercisePlayer exercise={exercise()} />)
    fireEvent.click(screen.getByTestId('play'))

    await waitFor(() => expect(screen.getByTestId('exercise-feedback')).toHaveTextContent('Mossa corretta.'))
    expect(attempt).toHaveBeenCalledWith('ex1', 'e2e4')
    // The user's move lands first, the reply a moment later: never one single jump.
    expect(screen.getByTestId('board')).toHaveAttribute('data-fen', AFTER_E4_PLAYED)
    await waitFor(() => expect(screen.getByTestId('board')).toHaveAttribute('data-fen', AFTER_E5))
  })

  it('announces the exercise as solved and says so to whoever is showing it', async () => {
    const onSolved = vi.fn()
    attempt.mockResolvedValueOnce({ correct: true, done: true, fen: AFTER_E4, alternativesAccepted: false })
    render(<ExercisePlayer exercise={exercise({ solution: ['e2e4'] })} onSolved={onSolved} />)
    fireEvent.click(screen.getByTestId('play'))

    await waitFor(() => expect(screen.getByTestId('exercise-feedback')).toHaveTextContent('Esercizio risolto.'))
    expect(onSolved).toHaveBeenCalledTimes(1)
    // A solved exercise is not playable any more.
    await waitFor(() => expect(screen.getByTestId('board')).toHaveAttribute('data-viewonly', 'true'))
  })

  it('says an equally good alternative was accepted', async () => {
    attempt.mockResolvedValueOnce({ correct: true, done: true, fen: AFTER_E4, alternativesAccepted: true })
    render(<ExercisePlayer exercise={exercise()} />)
    fireEvent.click(screen.getByTestId('play'))
    await waitFor(() =>
      expect(screen.getByTestId('exercise-feedback')).toHaveTextContent('Mossa corretta: un’alternativa altrettanto buona.')
    )
  })

  it('leaves the position alone on a wrong move and offers the solution after two of them', async () => {
    attempt.mockResolvedValue(WRONG)
    board.move = 'd2d4'
    render(<ExercisePlayer exercise={exercise()} />)

    fireEvent.click(screen.getByTestId('play'))
    await waitFor(() => expect(screen.getByTestId('exercise-feedback')).toHaveTextContent('Non è la mossa migliore'))
    expect(screen.getByTestId('board')).toHaveAttribute('data-fen', START)
    expect(screen.queryByRole('button', { name: 'Mostra soluzione' })).toBeNull()

    fireEvent.click(screen.getByTestId('play'))
    const reveal = await screen.findByRole('button', { name: 'Mostra soluzione' })
    fireEvent.click(reveal)
    expect(screen.getByTestId('exercise-solution')).toHaveTextContent('1. e4 e5 2. Nf3')
  })

  it('asks the coach for an explanation and shows it while it streams', async () => {
    render(<ExercisePlayer exercise={exercise()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Spiega' }))
    await waitFor(() => expect(explain).toHaveBeenCalledWith('ex1'))

    act(() => {
      useTrainingStore.setState({
        activity: { kind: 'explain', ref: 'ex1', streamId: 's1', busy: true },
        stream: { streamId: 's1', text: 'Il cavallo forchetta' }
      })
    })
    expect(screen.getByTestId('explanation-card')).toHaveTextContent('Il cavallo forchetta')

    act(() => {
      useTrainingStore.setState({ activity: null, stream: null, explanations: { ex1: 'Spiegazione finta.' } })
    })
    expect(screen.getByTestId('explanation-card')).toHaveTextContent('Spiegazione finta.')
  })

  it('starts the exercise again when it is restarted', async () => {
    attempt.mockResolvedValueOnce(CORRECT)
    render(<ExercisePlayer exercise={exercise()} />)
    fireEvent.click(screen.getByTestId('play'))
    await waitFor(() => expect(screen.getByTestId('board')).toHaveAttribute('data-fen', AFTER_E5))

    fireEvent.click(screen.getByRole('button', { name: 'Ricomincia' }))
    expect(screen.getByTestId('board')).toHaveAttribute('data-fen', START)
    expect(screen.queryByTestId('exercise-feedback')).toBeNull()
    await waitFor(() => expect(reset).toHaveBeenCalledWith('ex1'))
  })
})
