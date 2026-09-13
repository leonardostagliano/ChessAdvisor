import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { SessionState } from '@shared/types/session'
import type { EndgameListEntry, Exercise, OpeningOverviewEntry, StudyPlanView, ThematicSet } from '@shared/types/training'
import { EMPTY_SESSION, useGameStore } from '../../stores/gameStore'
import { useTrainingStore } from '../../stores/trainingStore'
import { useUiStore } from '../../stores/uiStore'

/**
 * The training section against a mocked bridge (spec §6.4–§6.8): five tabs over the material the
 * main process owns. chessground is stubbed because jsdom has no layout, everything else — the
 * tab strip, the empty states, the thematic set, the endgames and their drill — runs for real.
 */

vi.mock('@lichess-org/chessground', () => ({
  Chessground: (el: HTMLElement) => {
    el.innerHTML = '<cg-container></cg-container>'
    return { set: () => {}, destroy: () => {}, redrawAll: () => {} }
  }
}))

const { TrainingScreen } = await import('./TrainingScreen')

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

function exercise(patch: Partial<Exercise> = {}): Exercise {
  return {
    id: 'og-g1-7',
    kind: 'own_game',
    fen: START,
    sideToMove: 'w',
    solution: ['e2e4'],
    theme: 'hanging_piece',
    sourceGameId: 'g1',
    sourcePly: 7,
    status: 'new',
    attempts: 0,
    createdAt: '2026-09-12T10:00:00.000Z',
    ...patch
  }
}

const endgame: EndgameListEntry = {
  id: 'lucena',
  name: { it: 'Posizione di Lucena', en: 'Lucena position' },
  fen: '1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1',
  sideToMove: 'w',
  goal: 'win',
  difficulty: 2,
  theme: 'endgame_technique',
  status: 'new',
  attempts: 0,
  gameId: null
}

const thematicSet: ThematicSet = {
  theme: 'fork',
  ratingMin: 800,
  ratingMax: 1200,
  motivation: 'Le forchette ti sfuggono spesso.',
  fallback: false,
  exercises: Array.from({ length: 10 }, (_, index) =>
    exercise({ id: `tac-${index}`, kind: 'thematic', theme: 'fork', rating: 900 + index, sourceGameId: undefined, sourcePly: undefined })
  )
}

const opening: OpeningOverviewEntry = {
  eco: 'B20',
  name: 'Sicilian Defense',
  games: 5,
  score: 40,
  avgAccuracyFirst10: 64.2,
  deviations: [{ epd: 'epd-1', san: 'Nf3', count: 3, bestSan: 'd4' }]
}

const emptyPlan: StudyPlanView = { plan: null, suggestRegenerate: false, invalidRefs: 0, gamesSincePlan: 0 }

const list = vi.fn(async (): Promise<Exercise[]> => [exercise()])
const endgames = vi.fn(async (): Promise<EndgameListEntry[]> => [endgame])
const planGet = vi.fn(async (): Promise<StudyPlanView> => emptyPlan)
const overview = vi.fn(async (): Promise<OpeningOverviewEntry[]> => [opening])
const next = vi.fn(async (): Promise<ThematicSet> => thematicSet)
const start = vi.fn(async (): Promise<SessionState> => ({ ...EMPTY_SESSION, status: 'playing' }))
const lesson = vi.fn(async () => 'Lezione finta.')
const listeners = new Map<string, (payload: never) => void>()

function mockApi(): void {
  listeners.clear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      training: {
        exercises: { list, get: vi.fn(), attempt: vi.fn(), reset: vi.fn(), explain: vi.fn() },
        thematic: { next },
        openings: { overview, lesson },
        endgames: { list: endgames, start },
        plan: { get: planGet, generate: vi.fn(), markDone: vi.fn() }
      },
      on: (channel: string, cb: (payload: never) => void) => {
        listeners.set(channel, cb)
        return () => listeners.delete(channel)
      }
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi()
  useTrainingStore.setState({
    tab: 'own',
    exercises: [],
    endgames: [],
    openings: [],
    plan: null,
    thematic: null,
    lessons: {},
    explanations: {},
    selectedExercise: null,
    selectedOpening: null,
    loading: false,
    request: null,
    activity: null,
    stream: null,
    error: null
  })
  useUiStore.setState({ area: 'training', reviewTarget: null })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

describe('TrainingScreen', () => {
  it('offers the five areas of the section', async () => {
    render(<TrainingScreen />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    const strip = screen.getByRole('tablist', { name: 'Aree di allenamento' })
    expect(within(strip).getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'Dalle tue partite',
      'Tattica',
      'Aperture',
      'Finali',
      'Piano di studio'
    ])
  })

  it('lists the exercises of the analysed games and links back to the move they come from', async () => {
    render(<TrainingScreen />)
    const list0 = await screen.findByTestId('own-exercises')
    expect(within(list0).getByText('Pezzo in presa')).toBeInTheDocument()
    expect(within(list0).getByText('semimossa 7')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Vedi nella revisione' }))
    expect(useUiStore.getState().reviewTarget).toEqual({ gameId: 'g1', ply: 7 })
    expect(useUiStore.getState().area).toBe('play')
  })

  it('guides the user to the board while no exercise has been built yet', async () => {
    list.mockResolvedValueOnce([])
    render(<TrainingScreen />)
    expect(await screen.findByText('Ancora nessun esercizio')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Vai alla scacchiera' }))
    expect(useUiStore.getState().area).toBe('play')
  })

  it('draws a thematic set and shows its motivation and the first puzzle', async () => {
    render(<TrainingScreen />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'Tattica' }))
    expect(await screen.findByText('Nessuna serie in corso')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Nuova serie' }))
    await waitFor(() => expect(next).toHaveBeenCalledTimes(1))
    const card = await screen.findByTestId('thematic-set')
    expect(within(card).getByText('Forchetta')).toBeInTheDocument()
    expect(within(card).getByText('Le forchette ti sfuggono spesso.')).toBeInTheDocument()
    expect(within(card).getByText('Rating 800–1200')).toBeInTheDocument()
    expect(screen.getByTestId('exercise-position')).toHaveTextContent('1/10')
  })

  it('shows the openings with their recurring deviations', async () => {
    render(<TrainingScreen />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'Aperture' }))
    const table = await screen.findByTestId('training-openings')
    expect(within(table).getByText('Sicilian Defense')).toBeInTheDocument()

    fireEvent.click(within(table).getByRole('button', { name: 'Apri Sicilian Defense' }))
    const detail = await screen.findByTestId('opening-detail')
    expect(within(detail).getByText('Nf3')).toBeInTheDocument()
    expect(within(detail).getByText('3 volte')).toBeInTheDocument()
    expect(within(detail).getByText('il motore preferiva d4')).toBeInTheDocument()

    fireEvent.click(within(detail).getByRole('button', { name: 'Mini-lezione' }))
    await waitFor(() => expect(lesson).toHaveBeenCalledWith('B20'))
    await waitFor(() => expect(within(screen.getByTestId('opening-detail')).getByTestId('explanation-card')).toHaveTextContent('Lezione finta.'))
  })

  it('starts an endgame drill and hands the user over to the board', async () => {
    render(<TrainingScreen />)
    await waitFor(() => expect(endgames).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'Finali' }))
    const cards = await screen.findByTestId('endgames')
    expect(within(cards).getByText('Posizione di Lucena')).toBeInTheDocument()
    expect(within(cards).getByText('Vincere')).toBeInTheDocument()
    expect(within(cards).getByText('Medio')).toBeInTheDocument()

    fireEvent.click(within(cards).getByRole('button', { name: 'Gioca' }))
    await waitFor(() => expect(start).toHaveBeenCalledWith('lucena'))
    await waitFor(() => expect(useUiStore.getState().area).toBe('play'))
    expect(useGameStore.getState().session.status).toBe('playing')
  })

  it('offers to reload the endgames when the catalogue could not be read', async () => {
    endgames.mockResolvedValue([])
    render(<TrainingScreen />)
    await waitFor(() => expect(endgames).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('tab', { name: 'Finali' }))

    expect(await screen.findByText('Nessun finale disponibile')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Ricarica i finali' }))
    await waitFor(() => expect(endgames).toHaveBeenCalledTimes(2))
  })

  it('sends the user to the board when no opening has been recognised yet', async () => {
    overview.mockResolvedValue([])
    render(<TrainingScreen />)
    await waitFor(() => expect(list).toHaveBeenCalled())
    fireEvent.click(screen.getByRole('tab', { name: 'Aperture' }))

    expect(await screen.findByText('Nessuna apertura riconosciuta')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Gioca una partita' }))
    await waitFor(() => expect(useUiStore.getState().area).toBe('play'))
  })

  it('re-reads the exercises when the main process says they changed', async () => {
    render(<TrainingScreen />)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1))
    list.mockResolvedValueOnce([exercise({ id: 'og-g2-3', sourcePly: 3, status: 'solved' })])
    listeners.get('training:changed')?.({ kind: 'exercises' } as never)
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('own-exercises').textContent).toContain('semimossa 3'))
  })
})
