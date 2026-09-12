import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { pgnOf } from './pgn'

const sans = (input: string[]): { san: string }[] => input.map((san) => ({ san }))

describe('pgnOf', () => {
  it('renders the movetext with move numbers', () => {
    const pgn = pgnOf(sans(['e4', 'e5', 'Nf3', 'Nc6']))
    expect(pgn).toContain('1. e4 e5 2. Nf3 Nc6')
  })

  it('round-trips through chess.js loadPgn', () => {
    const moves = ['d4', 'd5', 'c4', 'e6', 'Nc3', 'Nf6', 'Bg5', 'Be7']
    const chess = new Chess()
    chess.loadPgn(pgnOf(sans(moves)))
    expect(chess.history()).toEqual(moves)
  })

  it('emits an empty movetext for a game with no moves', () => {
    const pgn = pgnOf([])
    expect(pgn).toContain('[Result "*"]')
    expect(pgn).not.toContain('1.')
  })

  it('keeps the starting position in SetUp/FEN headers and numbers from it', () => {
    const startFen = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
    const pgn = pgnOf(sans(['e5', 'Nf3']), { startFen })
    expect(pgn).toContain('[SetUp "1"]')
    expect(pgn).toContain(`[FEN "${startFen}"]`)
    expect(pgn).toContain('1. ... e5 2. Nf3')
    const chess = new Chess()
    chess.loadPgn(pgn)
    expect(chess.history()).toEqual(['e5', 'Nf3'])
  })

  it('writes the headers it is given', () => {
    const pgn = pgnOf(sans(['e4']), { headers: { Event: 'ChessAdvisor', White: 'Leonardo', Black: 'gpt-6-astra', Result: '*' } })
    expect(pgn).toContain('[Event "ChessAdvisor"]')
    expect(pgn).toContain('[White "Leonardo"]')
    expect(pgn).toContain('[Black "gpt-6-astra"]')
  })

  it('stops at the first move that is not legal instead of throwing', () => {
    const pgn = pgnOf(sans(['e4', 'e5', 'Qd8', 'Nf3']))
    expect(pgn).toContain('1. e4 e5')
    expect(pgn).not.toContain('Nf3')
  })

  it('accepts sloppy SAN coming from the model (zeros, missing equals sign)', () => {
    const startFen = '4k3/4P3/8/8/8/8/8/R3K2R w KQ - 0 1'
    const pgn = pgnOf(sans(['0-0']), { startFen })
    expect(pgn).toContain('O-O')
  })
})
