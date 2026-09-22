import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { Chess } from 'chess.js'
import '../../i18n'
import type { Game, Move } from '@shared/types/game'
import type { SessionState } from '@shared/types/session'
import { EMPTY_SESSION, useGameStore } from '../../stores/gameStore'
import { useUiStore } from '../../stores/uiStore'
import { CommentsTab, uncommentedMoves } from './CommentsTab'
import { visibleCommentStream } from './CommentCard'

/**
 * The comments feed (spec §4.2): one card per commented ply, the card in flight streaming, and
 * the two controls that decide whether the coach speaks at all.
 */

const FEN_1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
const FEN_2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'

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

function game(moves: Move[]): Game {
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
    moves,
    takebacks: 0,
    coachLog: []
  }
}

function session(moves: Move[], coach: Partial<SessionState['coach']> = {}): SessionState {
  return {
    ...EMPTY_SESSION,
    game: game(moves),
    fen: FEN_2,
    status: 'playing',
    coach: { ...EMPTY_SESSION.coach, ...coach }
  }
}

const setCommentsVisible = vi.fn(async () => EMPTY_SESSION)
const commentSkipped = vi.fn(async () => EMPTY_SESSION)

beforeEach(() => {
  vi.clearAllMocks()
  useUiStore.setState({ language: 'it' })
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { game: { setCommentsVisible, commentSkipped }, on: () => () => {} }
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

describe('uncommentedMoves', () => {
  it('lists the plies the coach has not spoken about', () => {
    const moves = [
      move(0, 'e4', 'e2e4', FEN_1, 'user', { coachComment: 'Apri il centro.' }),
      move(1, 'e5', 'e7e5', FEN_2, 'ai')
    ]
    expect(uncommentedMoves(game(moves)).map((entry) => entry.san)).toEqual(['e5'])
    expect(uncommentedMoves(null)).toEqual([])
  })
})

describe('visibleCommentStream', () => {
  it('shows readable text from structured partial comments without leaking JSON', () => {
    expect(visibleCommentStream('{"headline":"Controlla il centro","explanation":"Il cavallo attacca')).toBe('Il cavallo attacca')
    expect(visibleCommentStream('{"headline":"Controlla il centro"')).toBe('Controlla il centro')
    expect(visibleCommentStream('{"headline":')).toBe('')
  })
})

describe('CommentsTab', () => {
  it('keeps earlier factual cards available after more moves are played', () => {
    const board = new Chess()
    const moves = ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'd3'].map((san, index) => {
      const played = board.move(san)!
      return move(index + 1, san, `${played.from}${played.to}`, board.fen(),
        index % 2 === 0 ? 'user' : 'ai')
    })
    render(<CommentsTab session={session(moves)} />)

    expect(screen.getAllByText('Lettura immediata')).toHaveLength(7)
    expect(screen.getByText(/Il pedone è avanzato da e2 a e4/)).toBeInTheDocument()
  })

  it('links a lesson to its move and previews only stored line steps', () => {
    const select = vi.fn()
    const preview = vi.fn()
    const clear = vi.fn()
    const line = {
      kind: 'reply' as const,
      startFen: FEN_2,
      moves: [{ san: 'Nf3', uci: 'g1f3', fenAfter: FEN_2 }]
    }
    const lessonMove = move(2, 'e5', 'e7e5', FEN_2, 'ai', {
      coachExplanation: {
        version: 1,
        headline: 'Contesta il centro',
        explanation: 'Il pedone mette pressione su e4.',
        priority: 'Difendi e4.',
        question: 'Come svilupperesti?',
        hints: ['Guarda il cavallo.', 'Trova una casa attiva.'],
        takeaway: 'Sviluppa con uno scopo.',
        annotations: [{ square: 'e4', label: 'Pedone sotto pressione', kind: 'threat' }],
        evidence: { source: 'live', perspective: 'white', lines: [line] }
      }
    })
    render(<CommentsTab session={session([lessonMove])} selectedPly={2} onSelectMove={select} onPreviewLine={preview} onClearPreview={clear} annotationsEnabled onAnnotationsEnabledChange={vi.fn()} />)

    expect(screen.getByText('Contesta il centro')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Commento a e5' })).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Commento a e5' }))
    expect(select).toHaveBeenCalledWith(lessonMove)
    expect(screen.queryByText('Nf3')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Dammi un indizio' }))
    expect(screen.getByText('Guarda il cavallo.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Un altro indizio' }))
    expect(screen.getByText('Trova una casa attiva.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Mostra la risposta' }))
    expect(screen.getAllByText('Nf3').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByText('Dettagli dell’analisi'))
    fireEvent.click(screen.getByRole('button', { name: 'Esplora Nf3 sulla scacchiera' }))
    expect(preview).toHaveBeenCalledWith(lessonMove, line, 0)
    fireEvent.click(screen.getByRole('button', { name: 'Torna alla posizione del commento' }))
    expect(clear).toHaveBeenCalledOnce()
  })

  it('offers a separate board explanation switch', () => {
    const change = vi.fn()
    render(<CommentsTab session={session([])} annotationsEnabled={false} onAnnotationsEnabledChange={change} />)
    fireEvent.click(screen.getByRole('switch', { name: 'Spiegazioni sulla scacchiera' }))
    expect(change).toHaveBeenCalledWith(true)
  })

  it('shows one card per commented ply, in the language it was written in', () => {
    const state = session([
      move(0, 'e4', 'e2e4', FEN_1, 'user', {
        coachComment: 'Apri il centro.',
        coachCommentLanguage: 'it'
      }),
      move(1, 'e5', 'e7e5', FEN_2, 'ai', {
        coachComment: 'A symmetrical answer.',
        coachCommentLanguage: 'en'
      })
    ])
    render(<CommentsTab session={state} />)

    expect(screen.getByText('Apri il centro.')).toBeInTheDocument()
    expect(screen.getByText('A symmetrical answer.')).toBeInTheDocument()
    // The UI is in Italian: only the English card carries the badge (spec §4.3).
    expect(screen.getByText('in Inglese')).toBeInTheDocument()
    expect(screen.queryByText('in Italiano')).not.toBeInTheDocument()
  })

  it('explains the silence instead of showing an empty feed when the comments are hidden', () => {
    const state = session(
      [move(0, 'e4', 'e2e4', FEN_1, 'user', { coachComment: 'Apri il centro.' })],
      {
        commentsVisible: false
      }
    )
    render(<CommentsTab session={state} />)

    expect(screen.getByText(/Commenti nascosti/)).toBeInTheDocument()
    expect(screen.queryByText('Apri il centro.')).not.toBeInTheDocument()
  })

  it('turns the comments back on from the primary action of the empty state', async () => {
    render(<CommentsTab session={session([], { commentsVisible: false })} />)

    expect(screen.getByText('Commenti nascosti')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Riattiva i commenti' }))
    await waitFor(() => expect(setCommentsVisible).toHaveBeenCalledWith(true))
  })

  it('offers the skipped moves beside an immediate factual card', async () => {
    render(<CommentsTab session={session([move(0, 'e4', 'e2e4', FEN_1, 'user')])} />)

    expect(screen.getByText('Lettura immediata')).toBeInTheDocument()
    expect(screen.getByText('Pedone al centro')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Commenta le mosse saltate' }))
    await waitFor(() => expect(commentSkipped).toHaveBeenCalled())
  })

  it('binds the switch to the main process, which owns the choice', async () => {
    render(<CommentsTab session={session([move(0, 'e4', 'e2e4', FEN_1, 'user')])} />)

    fireEvent.click(screen.getByRole('switch', { name: /Mostra commenti/ }))
    await waitFor(() => expect(setCommentsVisible).toHaveBeenCalledWith(false))
  })

  it('offers to comment the skipped moves only while there are any', async () => {
    const commented = session([
      move(0, 'e4', 'e2e4', FEN_1, 'user', { coachComment: 'Apri il centro.' })
    ])
    const { rerender } = render(<CommentsTab session={commented} />)
    expect(screen.queryByRole('button', { name: /mosse saltate/ })).not.toBeInTheDocument()

    rerender(
      <CommentsTab
        session={session([
          move(0, 'e4', 'e2e4', FEN_1, 'user', { coachComment: 'Apri il centro.' }),
          move(1, 'e5', 'e7e5', FEN_2, 'ai')
        ])}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /mosse saltate/ }))
    await waitFor(() => expect(commentSkipped).toHaveBeenCalled())
  })

  it('streams the comment in flight into a card of its own', () => {
    const state = session([move(0, 'e4', 'e2e4', FEN_1, 'user')], {
      busy: true,
      streamId: 's-coach'
    })
    useGameStore.setState({ session: state })
    render(<CommentsTab session={state} />)

    expect(screen.getByText('Il coach sta scrivendo…')).toBeInTheDocument()

    act(() => {
      const store = useGameStore.getState()
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
      // Deltas of another turn (the opponent's) never reach the feed.
      store.applyStream({
        streamId: 's-ai',
        threadId: 't',
        turnId: 'u',
        itemId: 'i',
        kind: 'text',
        chunk: '{"move"'
      })
    })

    expect(screen.getByText('Buona apertura.')).toBeInTheDocument()
  })

  it('does not reuse the last comment while the next stream waits for its first delta', () => {
    const state = session([move(0, 'e4', 'e2e4', FEN_1, 'user')], {
      busy: true,
      streamId: 's-next'
    })
    useGameStore.setState({
      session: state,
      coachStream: { streamId: 's-previous', text: 'Vecchio commento.' }
    })
    render(<CommentsTab session={state} />)

    expect(screen.getByText('Il coach sta scrivendo…')).toBeInTheDocument()
    expect(screen.queryByText('Vecchio commento.')).not.toBeInTheDocument()

    act(() => useGameStore.getState().applyStream({
      streamId: 's-next', threadId: 't', turnId: 'u', itemId: 'i',
      kind: 'text', chunk: 'Nuovo commento.'
    }))
    expect(screen.getByText('Nuovo commento.')).toBeInTheDocument()
  })

  it('upgrades the immediate move card in place as the coach writes and completes it', () => {
    const played = move(1, 'e4', 'e2e4', FEN_1, 'user')
    const pending = session([played], { busy: true, streamId: 's-coach', activeCommentPly: 1 })
    useGameStore.setState({ session: pending })
    const { rerender } = render(<CommentsTab session={pending} />)
    const card = screen.getByText('Pedone al centro').closest('article')
    expect(card).toHaveTextContent('Lettura immediata')
    expect(card).toHaveTextContent('Il coach sta aggiungendo dettagli…')
    expect(screen.getAllByRole('article')).toHaveLength(1)

    act(() => useGameStore.getState().applyStream({
      streamId: 's-coach', threadId: 't', turnId: 'u', itemId: 'i',
      kind: 'text', chunk: '{"headline":"Sviluppo del centro"'
    }))
    expect(card).toHaveTextContent('Pedone al centro')
    expect(card).toHaveTextContent('Sviluppo del centro')
    expect(screen.getAllByRole('article')).toHaveLength(1)

    const complete = session([{ ...played, coachExplanation: {
      version: 1, headline: 'Centro controllato', explanation: 'Il pedone occupa e4.',
      hints: [], annotations: []
    } }])
    rerender(<CommentsTab session={complete} />)
    expect(card).toHaveTextContent('Centro controllato')
    expect(card).not.toHaveTextContent('Lettura immediata')
    expect(screen.getAllByRole('article')).toHaveLength(1)
  })

  it('keeps the feed quiet while the coach is answering a question instead', () => {
    const state = session([move(0, 'e4', 'e2e4', FEN_1, 'user')], {
      busy: true,
      streamId: 's-coach'
    })
    useGameStore.setState({ session: state, coachRequest: 'answer' })
    render(<CommentsTab session={state} />)

    expect(screen.queryByText('Il coach sta scrivendo…')).not.toBeInTheDocument()
    expect(screen.getByText('Lettura immediata')).toBeInTheDocument()
  })
})
