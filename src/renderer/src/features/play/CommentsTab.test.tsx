import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { Game, Move } from '@shared/types/game'
import type { SessionState } from '@shared/types/session'
import { EMPTY_SESSION, useGameStore } from '../../stores/gameStore'
import { useUiStore } from '../../stores/uiStore'
import { CommentsTab, uncommentedMoves } from './CommentsTab'

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

describe('CommentsTab', () => {
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

  it('offers the skipped moves from the empty state of a feed with nothing in it', async () => {
    render(<CommentsTab session={session([move(0, 'e4', 'e2e4', FEN_1, 'user')])} />)

    expect(screen.getByText('Ancora nessun commento')).toBeInTheDocument()
    fireEvent.click(screen.getAllByRole('button', { name: 'Commenta le mosse saltate' })[0]!)
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

  it('keeps the feed quiet while the coach is answering a question instead', () => {
    const state = session([move(0, 'e4', 'e2e4', FEN_1, 'user')], {
      busy: true,
      streamId: 's-coach'
    })
    useGameStore.setState({ session: state, coachRequest: 'answer' })
    render(<CommentsTab session={state} />)

    expect(screen.queryByText('Il coach sta scrivendo…')).not.toBeInTheDocument()
    expect(screen.getByText(/Nessun commento per ora/)).toBeInTheDocument()
  })
})
