import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { CoachLogEntry, Game } from '@shared/types/game'
import type { SessionState } from '@shared/types/session'
import { EMPTY_SESSION, useGameStore } from '../../stores/gameStore'
import { useUiStore } from '../../stores/uiStore'
import { CoachTab, coachDialogue } from './CoachTab'

/**
 * The Coach tab (spec §4.2): questions and answers, the hint, and the oracle-less badge. The
 * history is the persisted `coachLog`, so what the tab shows survives a resume.
 */

const FEN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'

function entry(
  patch: Partial<CoachLogEntry> & Pick<CoachLogEntry, 'id' | 'kind' | 'text'>
): CoachLogEntry {
  return { ply: 2, language: 'it', createdAt: '2026-09-13T10:00:00.000Z', ...patch }
}

function game(log: CoachLogEntry[]): Game {
  return {
    id: 'g1',
    createdAt: '2026-09-13T10:00:00.000Z',
    updatedAt: '2026-09-13T10:05:00.000Z',
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
    moves: [],
    takebacks: 0,
    coachLog: log
  }
}

function session(
  log: CoachLogEntry[] = [],
  coach: Partial<SessionState['coach']> = {}
): SessionState {
  return {
    ...EMPTY_SESSION,
    game: game(log),
    fen: FEN,
    status: 'playing',
    coach: { ...EMPTY_SESSION.coach, ...coach }
  }
}

const askCoach = vi.fn(async () => EMPTY_SESSION)
const requestHint = vi.fn(async () => EMPTY_SESSION)
const clearHint = vi.fn(async () => EMPTY_SESSION)

beforeEach(() => {
  vi.clearAllMocks()
  useUiStore.setState({ language: 'it' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { game: { askCoach, requestHint, clearHint }, on: () => () => {} }
  })
  useGameStore.setState({
    session: EMPTY_SESSION,
    browsePly: null,
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

describe('coachDialogue', () => {
  it('keeps questions, answers and hints, and leaves the comments to the other tab', () => {
    const log = [
      entry({ id: '1', kind: 'comment', text: 'Sul centro.' }),
      entry({ id: '2', kind: 'question', text: 'Che piano seguo?' }),
      entry({ id: '3', kind: 'answer', text: 'Sviluppa i pezzi.' })
    ]
    expect(coachDialogue(game(log)).map((item) => item.id)).toEqual(['2', '3'])
    expect(coachDialogue(null)).toEqual([])
  })

  it('leaves out the hint that is still on the board, which has its own card', () => {
    const log = [
      entry({ id: '1', kind: 'hint', text: 'Un vecchio suggerimento.', move: 'e4' }),
      entry({ id: '2', kind: 'hint', text: 'Sviluppa e controlla e5.', move: 'Nf3' })
    ]
    const live = { move: 'Nf3', reason: 'Sviluppa e controlla e5.' }
    expect(coachDialogue(game(log), live).map((item) => item.id)).toEqual(['1'])
    expect(
      coachDialogue(game(log), { move: 'Bc4', reason: 'Altro.' }).map((item) => item.id)
    ).toEqual(['1', '2'])
  })
})

describe('CoachTab', () => {
  it('sends a question and clears the field', async () => {
    render(<CoachTab session={session()} engineAvailable />)

    const field = screen.getByLabelText('Domanda al coach')
    fireEvent.change(field, { target: { value: '  Che piano seguo?  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Invia' }))

    await waitFor(() => expect(askCoach).toHaveBeenCalledWith('Che piano seguo?'))
    expect(field).toHaveValue('')
  })

  it('will not send an empty question', () => {
    render(<CoachTab session={session()} engineAvailable />)
    expect(screen.getByRole('button', { name: 'Invia' })).toBeDisabled()
    expect(askCoach).not.toHaveBeenCalled()
  })

  it('shows the history the main process persisted', () => {
    render(
      <CoachTab
        session={session([
          entry({ id: '1', kind: 'question', text: 'Che piano seguo?' }),
          entry({ id: '2', kind: 'answer', text: 'Sviluppa i pezzi.' }),
          entry({ id: '3', kind: 'hint', text: 'Porta il cavallo al centro.', move: 'Nf3' }),
          entry({ id: '4', kind: 'comment', text: 'Questo va nella scheda Commenti.' })
        ])}
        engineAvailable
      />
    )

    expect(screen.getByText('Che piano seguo?')).toBeInTheDocument()
    expect(screen.getByText('Sviluppa i pezzi.')).toBeInTheDocument()
    expect(screen.getByText('Suggerimento: Nf3')).toBeInTheDocument()
    expect(screen.queryByText('Questo va nella scheda Commenti.')).not.toBeInTheDocument()
  })

  it('points at the question field from the empty state', () => {
    render(<CoachTab session={session()} engineAvailable />)

    expect(screen.getByText('Il coach è a disposizione')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Scrivi una domanda' }))
    expect(screen.getByLabelText('Domanda al coach')).toHaveFocus()
  })

  it('asks for a hint and puts it away again', async () => {
    const { rerender } = render(<CoachTab session={session()} engineAvailable />)
    fireEvent.click(screen.getByRole('button', { name: 'Suggerimento' }))
    await waitFor(() => expect(requestHint).toHaveBeenCalled())

    rerender(
      <CoachTab
        session={session([], {
          hint: { move: 'Nf3', uci: 'g1f3', reason: 'Sviluppa e controlla e5.' }
        })}
        engineAvailable
      />
    )
    expect(screen.getByText('Sviluppa e controlla e5.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Nascondi il suggerimento' }))
    await waitFor(() => expect(clearHint).toHaveBeenCalled())
  })

  it('streams the answer while it arrives and locks the field meanwhile', () => {
    const state = session([], { busy: true, streamId: 's-coach' })
    useGameStore.setState({ session: state, coachRequest: 'answer' })
    render(<CoachTab session={state} engineAvailable />)

    expect(screen.getByLabelText('Domanda al coach')).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Suggerimento' })).toBeDisabled()

    act(() => {
      useGameStore.getState().applyStream({
        streamId: 's-coach',
        threadId: 't',
        turnId: 'u',
        itemId: 'i',
        kind: 'text',
        chunk: 'Sviluppa i pezzi.'
      })
    })
    expect(screen.getByText('Sviluppa i pezzi.')).toBeInTheDocument()
  })

  it('says it is reasoning without the engine when Stockfish is missing', () => {
    render(<CoachTab session={session()} engineAvailable={false} />)
    expect(screen.getByText('Analisi motore non disponibile')).toBeInTheDocument()
  })
})
