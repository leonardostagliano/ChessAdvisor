import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { CodexState } from '@shared/types/codex'
import type { Game, GameSummary, Move } from '@shared/types/game'
import type { SessionState } from '@shared/types/session'
import { EMPTY_SESSION, START_FEN, useGameStore } from '../../stores/gameStore'
import { useCodexStore } from '../../stores/codexStore'
import { useEngineStore } from '../../stores/engineStore'
import { capturedPieces } from './PlayScreen'

/**
 * Smoke test of the play screen against a mocked bridge: the board is the only part that needs a
 * stand-in (chessground reads layout APIs jsdom does not implement), everything else runs for
 * real, so this covers the wiring between the session state and what the user sees.
 */
vi.mock('@lichess-org/chessground', () => ({
  Chessground: (el: HTMLElement) => {
    el.innerHTML = '<cg-container></cg-container>'
    return { set: () => {}, destroy: () => {}, redrawAll: () => {} }
  }
}))

const { PlayScreen } = await import('./PlayScreen')

const FEN_1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
const FEN_2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'
const FEN_3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'

function move(ply: number, san: string, uci: string, fenAfter: string, by: Move['by'], patch: Partial<Move> = {}): Move {
  return { ply, san, uci, fenAfter, epdAfter: fenAfter.split(' ').slice(0, 4).join(' '), by, ...patch }
}

function game(): Game {
  return {
    id: 'g1',
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:05:00.000Z',
    kind: 'match',
    status: 'in_progress',
    userColor: 'w',
    opponent: { model: 'gpt-6-astra', effort: 'low', difficulty: { mode: 'fixed', level: 3, targetElo: 1200 } },
    coach: { model: 'gpt-6-astra', effort: 'low' },
    clock: null,
    language: 'it',
    moves: [
      move(0, 'e4', 'e2e4', FEN_1, 'user'),
      move(1, 'e5', 'e7e5', FEN_2, 'ai', { aiShortComment: 'Rispondo al centro.' }),
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
    liveEval: { cp: 24, depth: 14 },
    ...patch
  }
}

const READY: CodexState = {
  status: 'ready',
  account: { email: 'user@example.com', planType: 'pro' },
  cliVersion: '0.154.0',
  versionMismatch: false,
  models: [
    {
      id: 'gpt-6-astra',
      displayName: 'GPT-6 Astra',
      description: 'default',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [
        { id: 'low', description: 'fast' },
        { id: 'medium', description: 'balanced' }
      ]
    }
  ],
  quota: null
}

const archive: GameSummary[] = [
  {
    id: 'g0',
    createdAt: '2026-09-11T10:00:00.000Z',
    updatedAt: '2026-09-11T11:00:00.000Z',
    kind: 'match',
    status: 'in_progress',
    userColor: 'b',
    opponent: { model: 'gpt-5.5', effort: 'low', difficulty: { mode: 'fixed', level: 2, targetElo: 900 } },
    plies: 8
  }
]

const deleteGame = vi.fn(async () => undefined)
const navigateEval = vi.fn(async () => undefined)
const resumeGame = vi.fn(async () => session())
const requestHint = vi.fn(async () => session())
const setCommentsVisible = vi.fn(async () => session())

function mockApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      app: { versionInfo: async () => ({ version: '0.1.0', isPackaged: false }) },
      settings: { get: async () => null, save: async () => null },
      games: { list: async () => archive, get: async () => null, delete: deleteGame },
      game: {
        state: async () => session(),
        resume: resumeGame,
        navigateEval,
        adaptiveElo: async () => null,
        requestHint,
        setCommentsVisible,
        askCoach: async () => session(),
        clearHint: async () => session(),
        commentSkipped: async () => session()
      },
      on: () => () => {}
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi()
  useCodexStore.getState().apply(READY)
  useEngineStore.getState().apply({ available: true, binary: 'avx2', version: 'Stockfish 17', message: null })
  useGameStore.setState({
    session: session(),
    browsePly: null,
    aiThinking: false,
    coachStream: null,
    coachRequest: null,
    busy: false,
    error: null
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

describe('capturedPieces', () => {
  it('lists what each side has taken, strongest first, with the material balance', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    const captured = capturedPieces(start, 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPP1/RNBQKBN1 w KQkq - 0 1')
    expect(captured.w).toEqual([])
    expect(captured.b).toEqual(['r', 'p'])
    expect(captured.balance).toBe(-6)
  })

  it('does not read a promotion as a captured pawn', () => {
    const start = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
    // The same material as the start, except that one white pawn has become a queen: nothing was
    // ever taken, so both lists stay empty and the balance is level.
    const promoted = capturedPieces(start, 'rnbqkbnr/pppppppp/8/8/8/Q7/PPPPPPP1/RNBQKBNR b - - 0 1')
    expect(promoted.w).toEqual([])
    expect(promoted.b).toEqual([])
    expect(promoted.balance).toBe(0)

    // A real capture next to the promotion is still counted, and only once.
    const both = capturedPieces(start, 'rnbqkbnr/ppppppp1/8/8/8/Q7/PPPPPPP1/RNBQKBNR b - - 0 1')
    expect(both.w).toEqual(['p'])
    expect(both.b).toEqual([])
    expect(both.balance).toBe(1)
  })
})

describe('PlayScreen', () => {
  it('renders opponent, board, moves and controls for a live game', async () => {
    render(<PlayScreen />)

    expect(screen.getByRole('heading', { name: 'GPT-6 Astra' })).toBeInTheDocument()
    expect(screen.getByText('Medio · ~1200')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Scacchiera' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /Valutazione del motore/ })).toBeInTheDocument()

    // Commenti, Mosse and Coach (spec §4.3), with the move list open.
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Commenti', 'Mosse', 'Coach'])
    for (const san of ['e4', 'e5', 'Nf3']) {
      expect(screen.getByRole('button', { name: san })).toBeInTheDocument()
    }

    for (const label of ['Nuova partita', 'Annulla mossa', 'Suggerimento', 'Abbandona', 'Proponi patta', 'Salva ed esci']) {
      expect(screen.getAllByRole('button', { name: label }).length).toBeGreaterThan(0)
    }
  })

  it('browses a past ply and offers the way back to the current position', async () => {
    render(<PlayScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'e4' }))
    await waitFor(() => expect(useGameStore.getState().browsePly).toBe(0))
    expect(screen.getByText('Stai rivedendo una posizione precedente.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Torna alla posizione corrente' }))
    await waitFor(() => expect(useGameStore.getState().browsePly).toBeNull())
  })

  it('asks the engine for a score only while browsing, not for the live position', async () => {
    render(<PlayScreen />)

    // The main process already pushes a fresh liveEval after every move: asking again from here
    // would only queue the same analysis twice.
    expect(navigateEval).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'e4' }))
    await waitFor(() => expect(navigateEval).toHaveBeenCalledWith(FEN_1))

    // Coming back has to refresh the bar, which is still showing the browsed ply's score.
    fireEvent.click(screen.getByRole('button', { name: 'Torna alla posizione corrente' }))
    await waitFor(() => expect(navigateEval).toHaveBeenCalledWith(FEN_3))
    expect(navigateEval).toHaveBeenCalledTimes(2)
  })

  it('enables exactly the controls that make sense during a live game', () => {
    render(<PlayScreen />)

    expect(screen.getByRole('button', { name: 'Annulla mossa' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Abbandona' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Proponi patta' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Salva ed esci' })).toBeEnabled()
  })

  it('has nothing to take back before the user has moved', () => {
    const fresh = game()
    fresh.moves = []
    useGameStore.setState({ session: session({ game: fresh, fen: START_FEN, turn: 'w', userToMove: true }), browsePly: null })

    render(<PlayScreen />)
    expect(screen.getByRole('button', { name: 'Annulla mossa' })).toBeDisabled()
    // Resigning a game that has started is still legitimate, even on move one.
    expect(screen.getByRole('button', { name: 'Abbandona' })).toBeEnabled()
  })

  it('will not offer a draw while the opponent is producing a move', () => {
    useGameStore.setState({
      session: session({ ai: { thinking: true, startedAt: Date.now() - 65_000, reasoning: '', retries: 0, streamId: 's1' } }),
      browsePly: null,
      aiThinking: true
    })

    render(<PlayScreen />)
    expect(screen.getByRole('button', { name: 'Proponi patta' })).toBeDisabled()
    expect(screen.getByText('01:05')).toBeInTheDocument()
    expect(screen.getByText(/sta pensando/)).toBeInTheDocument()
  })

  it('closes the irreversible controls once the game is over', () => {
    const finished = game()
    finished.status = 'finished'
    finished.result = { outcome: '1-0', reason: 'checkmate' }
    useGameStore.setState({ session: session({ game: finished, status: 'finished' }), browsePly: null })

    render(<PlayScreen />)
    expect(screen.getByRole('button', { name: 'Abbandona' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Proponi patta' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Annulla mossa' })).toBeDisabled()
    // A finished game is still the one on screen, so saving and leaving it stays available.
    expect(screen.getByRole('button', { name: 'Salva ed esci' })).toBeEnabled()
  })

  it('asks for a confirmation before resigning', async () => {
    render(<PlayScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Abbandona' }))
    expect(await screen.findByRole('dialog')).toHaveTextContent('Abbandonare la partita?')
  })

  it('lists the archive and resumes an interrupted game', async () => {
    render(<PlayScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Partite' }))
    expect(await screen.findByText('contro gpt-5.5')).toBeInTheDocument()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Riprendi' }))
    })
    expect(resumeGame).toHaveBeenCalledWith('g0', undefined)
  })

  it('offers a substitution when the saved model is gone', async () => {
    resumeGame.mockRejectedValueOnce(
      Object.assign(
        new Error("Error invoking remote method 'game:resume': IpcError: MODEL_UNAVAILABLE: gone [[ipcdata]]{\"suggested\":\"gpt-6-astra\"}"),
        {}
      )
    )
    render(<PlayScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Partite' }))
    await screen.findByText('contro gpt-5.5')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Riprendi' }))
    })

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Modello non più disponibile')
    expect(dialog).toHaveTextContent('GPT-6 Astra')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Riprendi con questo modello' }))
    })
    expect(resumeGame).toHaveBeenLastCalledWith('g0', { substituteModel: 'gpt-6-astra' })
  })

  it('switches the right panel between the three tabs', async () => {
    render(<PlayScreen />)

    fireEvent.click(screen.getByRole('tab', { name: 'Commenti' }))
    expect(screen.getByRole('switch', { name: /Mostra commenti/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'e4' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Coach' }))
    expect(screen.getByLabelText('Domanda al coach')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: 'Mosse' }))
    expect(screen.getByRole('button', { name: 'e4' })).toBeInTheDocument()
  })

  it('asks the coach for a hint from the game controls', async () => {
    render(<PlayScreen />)

    fireEvent.click(screen.getByRole('button', { name: 'Suggerimento' }))
    await waitFor(() => expect(requestHint).toHaveBeenCalled())
  })

  it('shows the user clock, and the opponent one only when the AI has a clock', () => {
    const withClock = game()
    withClock.clock = { initialMs: 300_000, incrementMs: 0, aiClock: false, remainingMs: { w: 297_500, b: 300_000 } }
    const clock = { remainingMs: { w: 297_500, b: 300_000 }, running: 'w' as const, updatedAt: Date.now() }
    useGameStore.setState({ session: session({ game: withClock, clock }), browsePly: null })

    const { rerender } = render(<PlayScreen />)
    expect(screen.getByRole('timer', { name: 'Il tuo orologio' })).toHaveTextContent('04:57')
    expect(screen.queryByRole('timer', { name: /avversario/ })).not.toBeInTheDocument()

    const both = game()
    both.clock = { initialMs: 300_000, incrementMs: 0, aiClock: true, remainingMs: { w: 297_500, b: 300_000 } }
    useGameStore.setState({ session: session({ game: both, clock }), browsePly: null })
    rerender(<PlayScreen />)
    expect(screen.getByRole('timer', { name: /avversario/ })).toHaveTextContent('05:00')
  })

  it('shows the result banner once the game is over', () => {
    const finished = game()
    finished.status = 'finished'
    finished.result = { outcome: '0-1', reason: 'resign' }
    useGameStore.setState({ session: session({ game: finished, status: 'finished' }), browsePly: null })

    render(<PlayScreen />)
    expect(screen.getByText('Hai perso per abbandono')).toBeInTheDocument()
  })
})
