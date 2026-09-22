import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { Game, Move, MoveClassification } from '@shared/types/game'
import type { Profile } from '@shared/types/profile'
import { encodeIpcErrorMessage } from '@shared/ipcError'
import { emptyDistribution, useProfileStore } from '../../stores/profileStore'
import { useUiStore } from '../../stores/uiStore'
import { ProgressScreen } from './ProgressScreen'

/**
 * The dashboard against a mocked bridge: the profile comes from the main process and the games of
 * the trend window are read through `games.get`, which is the only extra the classification bars
 * need (spec §6.9). Everything else on screen is a pure function of those two.
 */

const FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'

function move(ply: number, by: Move['by'], classification?: MoveClassification): Move {
  return {
    ply,
    san: 'e4',
    uci: 'e2e4',
    fenAfter: FEN,
    epdAfter: FEN.split(' ').slice(0, 4).join(' '),
    by,
    ...(classification
      ? {
          eval: {
            before: { cp: 10 },
            after: { cp: 5 },
            cpLoss: 5,
            winPercentLoss: 0.8,
            classification,
            bestMove: 'e2e4',
            bestLine: ['e2e4']
          }
        }
      : {})
  }
}

function game(id: string, classifications: MoveClassification[]): Game {
  return {
    id,
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:30:00.000Z',
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
      ...classifications.map((classification, index) =>
        move(index * 2 + 1, 'user', classification)
      ),
      move(2, 'ai', 'best')
    ],
    takebacks: 0,
    coachLog: [],
    result: { outcome: '1-0', reason: 'resign' },
    analysis: {
      accuracy: { w: 74, b: 60 },
      acpl: { w: 42, b: 80 },
      keyMoments: [],
      analyzedAt: '2026-09-10T10:31:00.000Z'
    }
  }
}

function profile(patch: Partial<Profile> = {}): Profile {
  return {
    learningPolicyVersion: 2,
    retiredGameIds: [],
    level: {
      band: 'intermediate',
      estimate: 1345,
      confidence: 0.62,
      updatedAt: '2026-09-12T09:00:00.000Z'
    },
    qualitative: {
      strengths: ['Apri con criterio', 'Difendi bene i pedoni'],
      weaknesses: ['Perdi pezzi in presa', 'Calcoli poco nei finali'],
      updatedAt: '2026-09-12T09:00:00.000Z'
    },
    themeStats: {
      hanging_piece: { occurrences: 7, lastSeen: '2026-09-12T09:00:00.000Z' },
      fork: { occurrences: 4, lastSeen: '2026-09-11T09:00:00.000Z' },
      pin: { occurrences: 2, lastSeen: '2026-09-10T09:00:00.000Z' },
      back_rank: { occurrences: 1, lastSeen: '2026-09-09T09:00:00.000Z' },
      development: { occurrences: 1, lastSeen: '2026-09-08T09:00:00.000Z' },
      king_safety: { occurrences: 1, lastSeen: '2026-09-07T09:00:00.000Z' }
    },
    openingStats: {
      C40: {
        eco: 'C40',
        name: "King's Knight Opening",
        games: 2,
        wins: 1,
        draws: 0,
        losses: 1,
        avgAccuracyFirst10: 71.5
      },
      B20: {
        eco: 'B20',
        name: 'Sicilian Defense',
        games: 5,
        wins: 1,
        draws: 1,
        losses: 3,
        avgAccuracyFirst10: 64.2
      }
    },
    history: [
      { gameId: 'g1', date: '2026-09-11T10:00:00.000Z', accuracy: 66.5, acpl: 55 },
      { gameId: 'g2', date: '2026-09-12T10:00:00.000Z', accuracy: 78.25, acpl: 33 }
    ],
    gamesSincePlan: 2,
    ...patch
  }
}

const get = vi.fn(async () => profile())
const refreshQualitative = vi.fn(async () => profile())
const getGame = vi.fn(async (id: string) =>
  id === 'g1'
    ? game('g1', ['best', 'good', 'blunder', 'good'])
    : game('g2', ['best', 'best', 'inaccuracy', 'good'])
)
const listeners = new Map<string, (payload: never) => void>()
const off = vi.fn()

function mockApi(): void {
  listeners.clear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      profile: { get, refreshQualitative },
      games: { get: getGame },
      on: (channel: string, cb: (payload: never) => void) => {
        listeners.set(channel, cb)
        return off
      }
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi()
  useProfileStore.setState({
    profile: null,
    loading: false,
    refreshing: false,
    error: null,
    distribution: emptyDistribution(),
    distributionFor: ''
  })
  useUiStore.setState({ area: 'progress' })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

describe('ProgressScreen', () => {
  it('shows exact losses before any analysis has completed', async () => {
    get.mockResolvedValueOnce(
      profile({
        history: [],
        qualitative: undefined,
        results: { games: 2, wins: 0, draws: 0, losses: 2 }
      })
    )
    render(<ProgressScreen />)
    const card = await screen.findByRole('region', { name: 'Risultati delle partite' })
    expect(within(card).getByText('Perse').nextElementSibling).toHaveTextContent('2')
    expect(within(card).getByText('Patte').nextElementSibling).toHaveTextContent('0')
    expect(
      within(card).getByText('Le statistiche di precisione si aggiornano al termine dell’analisi.')
    ).toBeInTheDocument()
  })

  it('guides the user to the board while no match has been analysed', async () => {
    get.mockResolvedValueOnce(profile({ history: [], qualitative: undefined }))
    render(<ProgressScreen />)
    await waitFor(() => expect(get).toHaveBeenCalled())
    expect(screen.queryByTestId('accuracy-trend')).toBeNull()
    expect(screen.queryByTestId('openings-table')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Gioca una partita' }))
    expect(useUiStore.getState().area).toBe('play')
  })

  it('shows the band, the estimate and the confidence of the level', async () => {
    render(<ProgressScreen />)
    const card = await screen.findByRole('region', { name: 'Livello stimato' })
    expect(within(card).getByText('Intermedio')).toBeInTheDocument()
    expect(within(card).getByText('1345 punti Elo stimati')).toBeInTheDocument()
    const ring = within(card).getByTestId('confidence-ring')
    expect(ring).toHaveAttribute('data-confidence', '62')
    expect(ring).toHaveAttribute('aria-label', expect.stringContaining('62'))
  })

  it('lists the strengths and the weaknesses and asks the coach for new ones', async () => {
    render(<ProgressScreen />)
    const card = await screen.findByRole('region', { name: 'Livello stimato' })
    expect(within(card).getByText('Perdi pezzi in presa')).toBeInTheDocument()
    fireEvent.click(within(card).getByRole('button', { name: 'Aggiorna' }))
    await waitFor(() => expect(refreshQualitative).toHaveBeenCalledTimes(1))
  })

  it('draws the trend of the analysed matches', async () => {
    const { container } = render(<ProgressScreen />)
    await waitFor(() => expect(container.querySelectorAll('[data-point]')).toHaveLength(2))
    expect(container.querySelector('[data-point="1"]')).toHaveAttribute('data-accuracy', '78.25')
  })

  it('averages the classifications of the user over the games of the window', async () => {
    render(<ProgressScreen />)
    const bars = await screen.findByTestId('classification-bars')
    await waitFor(() => expect(getGame).toHaveBeenCalledTimes(2))
    // Eight user moves: 3 best, 3 good, 1 blunder, 1 inaccuracy — and never the AI's own move.
    const best = bars.querySelector('[data-classification="best"]')
    await waitFor(() => expect(best?.textContent).toContain('37.5%'))
    expect(best?.textContent).toContain('1.5 a partita')
    const blunder = bars.querySelector('[data-classification="blunder"]')
    expect(blunder?.textContent).toContain('12.5%')
    expect(blunder?.textContent).toContain('0.5 a partita')
  })

  it('lists the five most frequent themes, translated, and no more', async () => {
    render(<ProgressScreen />)
    const themes = await screen.findByTestId('weak-themes')
    const rows = themes.querySelectorAll('[data-theme]')
    expect(rows).toHaveLength(5)
    expect(rows[0]).toHaveAttribute('data-theme', 'hanging_piece')
    expect(rows[0]!.textContent).toContain('Pezzo in presa')
    expect(rows[0]!.textContent).toContain('7 volte')
  })

  it('sorts the openings table on the column that was clicked', async () => {
    render(<ProgressScreen />)
    const table = await screen.findByTestId('openings-table')
    const codes = (): string[] =>
      Array.from(table.querySelectorAll('tbody tr')).map(
        (row) => row.getAttribute('data-eco') ?? ''
      )
    // Most played first by default.
    expect(codes()).toEqual(['B20', 'C40'])
    fireEvent.click(screen.getByRole('button', { name: /ECO/ }))
    expect(codes()).toEqual(['B20', 'C40'])
    fireEvent.click(screen.getByRole('button', { name: /ECO/ }))
    expect(codes()).toEqual(['C40', 'B20'])
    fireEvent.click(screen.getByRole('button', { name: /Accuratezza/ }))
    expect(codes()).toEqual(['C40', 'B20'])
    expect(screen.getByRole('columnheader', { name: /Accuratezza/ })).toHaveAttribute(
      'aria-sort',
      'descending'
    )
  })

  it('ends on the study plan, offering to write the first one (spec §6.8)', async () => {
    render(<ProgressScreen />)
    await screen.findByTestId('openings-table')
    const plan = screen.getByTestId('study-plan-summary')
    expect(
      within(plan).getByText('Il coach non ha ancora scritto un piano di studio.')
    ).toBeInTheDocument()
    expect(within(plan).getByRole('button', { name: 'Genera il piano' })).toBeInTheDocument()
  })

  it('reports a failing read without losing the screen', async () => {
    get.mockRejectedValueOnce(
      new Error(encodeIpcErrorMessage('PROFILE_UNAVAILABLE', 'Profilo non leggibile'))
    )
    render(<ProgressScreen />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Profilo non leggibile')
  })

  it('follows profile:changed while it is on screen', async () => {
    render(<ProgressScreen />)
    await screen.findByRole('region', { name: 'Livello stimato' })
    const changed = listeners.get('profile:changed')
    expect(changed).toBeTypeOf('function')
    changed?.(
      profile({
        level: {
          band: 'advanced',
          estimate: 1720,
          confidence: 0.8,
          updatedAt: '2026-09-13T09:00:00.000Z'
        }
      }) as never
    )
    expect(await screen.findByText('Avanzato')).toBeInTheDocument()
  })
})
