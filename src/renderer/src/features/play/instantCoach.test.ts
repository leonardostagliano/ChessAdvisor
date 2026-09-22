import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import type { Move } from '@shared/types/game'
import { instantMoveExplanation, instantPositionExplanation } from './instantCoach'

function played(fenBefore: string, uci: string, by: Move['by'] = 'user'): Move {
  const board = new Chess(fenBefore)
  const move = board.move({
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    ...(uci[4] ? { promotion: uci[4] } : {})
  })
  return { ply: 1, san: move.san, uci, fenAfter: board.fen(), epdAfter: '', by }
}

describe('instant move explanation', () => {
  it('names the central pawn and anchors an occupied square before any engine data exists', () => {
    const before = new Chess().fen()
    const explanation = instantMoveExplanation(played(before, 'e2e4'), before, 'w', 'it')
    expect(explanation?.headline).toBe('Pedone al centro')
    expect(explanation?.explanation).toContain('e2 a e4')
    expect(explanation?.explanation).toContain('controlla d5 e f5')
    expect(explanation?.annotations).toEqual([
      { square: 'e4', label: 'Controlla d5 e f5', kind: 'focus' }
    ])
    expect(explanation?.evidence).toBeUndefined()
  })

  it('describes a capture and a legally available attack on a valuable piece', () => {
    const before = 'q5k1/n7/8/8/8/8/8/R5K1 w - - 0 1'
    const explanation = instantMoveExplanation(played(before, 'a1a7'), before, 'w', 'en')
    expect(explanation?.explanation).toMatch(/captured a knight on a7/)
    expect(explanation?.explanation).toMatch(/attacks the queen on a8/)
    expect(explanation?.annotations).toContainEqual({
      square: 'a8',
      from: 'a7',
      kind: 'threat',
      label: 'Attacked queen'
    })
    const italian = instantMoveExplanation(played(before, 'a1a7'), before, 'b', 'it')
    expect(italian?.priority).toContain('La tua donna su a8 è sotto attacco')
    expect(italian?.explanation).toContain('La torre da a1 ha catturato un cavallo')
  })

  it('attributes discovered check to the move and marks the checked king', () => {
    const before = '4k3/8/8/8/8/8/4B3/4R1K1 w - - 0 1'
    const explanation = instantMoveExplanation(played(before, 'e2f3'), before, 'w', 'en')
    expect(explanation?.headline).toBe('The king is in check')
    expect(explanation?.explanation).toMatch(/^The move gives check/)
    expect(explanation?.annotations).toContainEqual({
      square: 'e8',
      label: 'King in check',
      kind: 'focus'
    })
  })

  it('identifies castling and a quiet fallback without claiming move quality', () => {
    const castleFen = '4k3/8/8/8/8/8/7P/4K2R w K - 0 1'
    const castle = instantMoveExplanation(played(castleFen, 'e1g1'), castleFen, 'w', 'en')
    expect(castle?.explanation).toContain('castled kingside')
    expect(castle?.annotations[0]?.square).toBe('g1')

    const before = new Chess().fen()
    const quiet = instantMoveExplanation(played(before, 'a2a3'), before, 'w', 'en')
    expect(quiet?.explanation).toContain('a2 to a3')
    expect(quiet?.explanation).toContain('controls b4')
    expect(quiet?.explanation).not.toMatch(/best|good|mistake/i)
  })

  it('names the captured square for en passant and the new piece for promotion', () => {
    const epFen = '4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1'
    const ep = instantMoveExplanation(played(epFen, 'e5d6'), epFen, 'w', 'en')
    expect(ep?.headline).toBe('Capture on d5')
    expect(ep?.explanation).toContain('pawn on d5')
    expect(ep?.annotations[0]?.square).toBe('d6')

    const promotionFen = '8/P6k/8/8/8/8/8/4K3 w - - 0 1'
    const promotion = instantMoveExplanation(played(promotionFen, 'a7a8q'), promotionFen, 'w', 'en')
    expect(promotion?.explanation).toContain('promoted to a queen')
    expect(promotion?.annotations[0]?.label).toBe('queen on a8')
  })

  it('returns null for an illegal move or a mismatched resulting position', () => {
    const before = new Chess().fen()
    const move = played(before, 'e2e4')
    expect(instantMoveExplanation({ ...move, uci: 'e2e5' }, before, 'w', 'en')).toBeNull()
    expect(instantMoveExplanation({ ...move, fenAfter: before }, before, 'w', 'en')).toBeNull()
  })
})

describe('instant position explanation', () => {
  it('describes a current check and legal capture without presenting either as engine advice', () => {
    const checkFen = '4k3/8/8/8/8/5B2/8/4R1K1 b - - 1 1'
    const check = instantPositionExplanation(checkFen, 'b', 'it')
    expect(check?.headline).toBe('Rispondere allo scacco')
    expect(check?.annotations[0]?.square).toBe('e8')

    const before = 'q5k1/n7/8/8/8/8/8/R5K1 w - - 0 1'
    const after = played(before, 'a1a7').fenAfter
    const capture = instantPositionExplanation(after, 'b', 'en')
    expect(capture?.headline).toBe('Capture available')
    expect(capture?.explanation).toContain('does not say whether the capture is sound')
    expect(capture?.annotations[0]?.square).toBe('a7')
    expect(instantPositionExplanation(after, 'w', 'en')?.explanation).toContain(
      'The opponent can capture the rook on a7'
    )
  })

  it('finds castling or a factual quiet-position fallback', () => {
    const castleFen = '4k3/8/8/8/8/8/7P/4K2R w K - 0 1'
    expect(instantPositionExplanation(castleFen, 'w', 'en')?.headline).toBe('Castling available')
    const quiet = instantPositionExplanation(new Chess().fen(), 'w', 'en')
    expect(quiet?.headline).toBe('Available moves')
    expect(quiet?.explanation).toContain('20 legal moves')
  })

  it('returns null when the FEN cannot be read', () => {
    expect(instantPositionExplanation('bad-fen', 'w', 'en')).toBeNull()
  })
})
