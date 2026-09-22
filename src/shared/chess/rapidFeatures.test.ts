import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import { phaseOf, positionContext } from './rapidFeatures'

describe('rapid position features', () => {
  it('uses material before ply and detects captures', () => {
    const start = new Chess()
    expect(positionContext(start.fen())).toEqual({
      phase: 'opening',
      inCheck: false,
      hasCapture: false,
      legalMoves: 20
    })
    start.move('e4')
    start.move('d5')
    expect(positionContext(start.fen()).hasCapture).toBe(true)
    const stripped = '8/8/8/8/8/8/4k3/4K3 w - - 0 1'
    // Adjacent kings are illegal; use a valid sparse position instead.
    expect(phaseOf(stripped.replace('4K3', 'K7'))).toBe('endgame')
  })

  it('moves out of the opening after ply 20 and sees check', () => {
    const board = new Chess()
    for (let i = 0; i < 6; i++) {
      board.move('Nf3')
      board.move('Nf6')
      board.move('Ng1')
      board.move('Ng8')
    }
    expect(phaseOf(board.fen())).toBe('middlegame')
    expect(positionContext('4k3/8/8/8/8/8/4R3/K7 b - - 0 1').inCheck).toBe(true)
  })
})
