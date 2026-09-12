import { describe, expect, it } from 'vitest'
import { applyMove, epdOf, gameStatus, legalMoves, normalizeMove } from './notation'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const CASTLING = 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'
const PROMOTION = '8/4P3/8/8/8/8/8/K6k w - - 0 1'

describe('legalMoves', () => {
  it('lists the 20 opening moves sorted by SAN', () => {
    const moves = legalMoves(START)
    expect(moves).toHaveLength(20)
    expect(moves.map((m) => m.san)).toEqual([...moves.map((m) => m.san)].sort())
    expect(moves).toContainEqual({ san: 'e4', uci: 'e2e4' })
    expect(moves).toContainEqual({ san: 'Nf3', uci: 'g1f3' })
  })

  it('returns an empty list for an unusable FEN', () => {
    expect(legalMoves('not a fen')).toEqual([])
  })
})

describe('normalizeMove', () => {
  it('accepts strict SAN', () => {
    expect(normalizeMove(START, 'Nf3')).toEqual({ san: 'Nf3', uci: 'g1f3' })
  })

  it('accepts UCI of 4 and 5 characters', () => {
    expect(normalizeMove(START, 'e2e4')).toEqual({ san: 'e4', uci: 'e2e4' })
    expect(normalizeMove(PROMOTION, 'e7e8q')).toEqual({ san: 'e8=Q', uci: 'e7e8q' })
    expect(normalizeMove(PROMOTION, 'e7e8Q')).toEqual({ san: 'e8=Q', uci: 'e7e8q' })
  })

  it('accepts a promotion written without the equals sign', () => {
    expect(normalizeMove(PROMOTION, 'e8Q')).toEqual({ san: 'e8=Q', uci: 'e7e8q' })
    expect(normalizeMove(PROMOTION, 'e8=N')).toEqual({ san: 'e8=N', uci: 'e7e8n' })
    expect(normalizeMove(PROMOTION, 'e8q')).toEqual({ san: 'e8=Q', uci: 'e7e8q' })
  })

  it('accepts castling written with zeros or lowercase', () => {
    expect(normalizeMove(CASTLING, '0-0')).toEqual({ san: 'O-O', uci: 'e1g1' })
    expect(normalizeMove(CASTLING, '0-0-0')).toEqual({ san: 'O-O-O', uci: 'e1c1' })
    expect(normalizeMove(CASTLING, 'o-o')).toEqual({ san: 'O-O', uci: 'e1g1' })
    expect(normalizeMove(CASTLING, 'O-O-O')).toEqual({ san: 'O-O-O', uci: 'e1c1' })
  })

  it('tolerates surrounding whitespace, quotes and check marks', () => {
    expect(normalizeMove(START, '  "e4"  ')).toEqual({ san: 'e4', uci: 'e2e4' })
    expect(normalizeMove(START, "'Nf3'")).toEqual({ san: 'Nf3', uci: 'g1f3' })
    expect(normalizeMove(START, 'e4+')).toEqual({ san: 'e4', uci: 'e2e4' })
    expect(normalizeMove(START, 'nf3')).toEqual({ san: 'Nf3', uci: 'g1f3' })
  })

  it('keeps the check and mate marks of the real SAN', () => {
    const beforeMate = 'rnbqkbnr/pppp1ppp/8/4p3/6P1/5P2/PPPPP2P/RNBQKBNR b KQkq - 0 2'
    expect(normalizeMove(beforeMate, 'Qh4')).toEqual({ san: 'Qh4#', uci: 'd8h4' })
  })

  it('does not confuse a bishop capture with a pawn capture', () => {
    const fen = 'r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'
    expect(normalizeMove(fen, 'Bxf7')).toEqual({ san: 'Bxf7+', uci: 'c4f7' })
  })

  it('returns null for an illegal or unparsable move', () => {
    expect(normalizeMove(START, 'e5')).toBeNull()
    expect(normalizeMove(START, 'Qd8')).toBeNull()
    expect(normalizeMove(START, 'hello')).toBeNull()
    expect(normalizeMove(START, '')).toBeNull()
    expect(normalizeMove('not a fen', 'e4')).toBeNull()
  })
})

describe('epdOf', () => {
  it('keeps the first four FEN fields', () => {
    expect(epdOf(START)).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -')
    expect(epdOf('8/8/8/8/8/8/8/K6k b - - 13 42')).toBe('8/8/8/8/8/8/8/K6k b - -')
  })
})

describe('applyMove', () => {
  it('returns the resulting FEN and SAN', () => {
    const result = applyMove(START, 'e2e4')
    expect(result?.san).toBe('e4')
    // chess.js emits the en-passant square only when a capture is actually available (X-FEN).
    expect(result?.fen).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')
  })

  it('returns null for an illegal move', () => {
    expect(applyMove(START, 'e2e5')).toBeNull()
  })
})

describe('gameStatus', () => {
  it('detects checkmate', () => {
    const fools = 'rnb1kbnr/pppp1ppp/8/4p3/6Pq/5P2/PPPPP2P/RNBQKBNR w KQkq - 1 3'
    expect(gameStatus(fools)).toEqual({ over: true, reason: 'checkmate', check: true })
  })

  it('detects stalemate', () => {
    expect(gameStatus('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1')).toEqual({ over: true, reason: 'stalemate', check: false })
  })

  it('detects insufficient material', () => {
    expect(gameStatus('8/8/8/4k3/8/8/4K3/7B w - - 0 1')).toEqual({ over: true, reason: 'insufficient', check: false })
  })

  it('detects the fifty-move rule from the halfmove clock', () => {
    expect(gameStatus('8/8/4k3/8/8/4K3/8/6R1 w - - 100 60')).toEqual({ over: true, reason: 'fifty', check: false })
  })

  it('detects threefold repetition from the position history', () => {
    const a = '4k3/8/8/8/8/8/8/R3K3 w - - 4 10'
    const b = '4k3/8/8/8/8/8/8/1R2K3 b - - 5 10'
    const history = [a, b, a, b]
    expect(gameStatus(a, history).reason).toBe('repetition')
    expect(gameStatus(a, [a, b]).over).toBe(false)
  })

  it('treats a history that already ends with the current position as inclusive', () => {
    const a = '4k3/8/8/8/8/8/8/R3K3 w - - 4 10'
    const b = '4k3/8/8/8/8/8/8/1R2K3 b - - 5 10'
    expect(gameStatus(a, [a, b, a, b, a]).reason).toBe('repetition')
  })

  it('reports an ongoing position with check', () => {
    expect(gameStatus('r1bqkbnr/pppp1Qpp/2n5/4p3/4P3/8/PPPP1PPP/RNB1KBNR b KQkq - 0 3')).toEqual({ over: false, check: true })
  })

  it('never reports a broken FEN as finished', () => {
    expect(gameStatus('not a fen')).toEqual({ over: false, check: false })
  })
})
