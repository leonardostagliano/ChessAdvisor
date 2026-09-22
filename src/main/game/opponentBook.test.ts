import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { applyMove, epdOf, legalMoves } from '@shared/chess/notation'
import type { OpeningBook } from '../analysis/openings'
import { opponentBookContext } from './opponentBook'

const START = new Chess().fen()

function position(sans: string[]): string {
  const chess = new Chess()
  for (const san of sans) chess.move(san)
  return chess.fen()
}

describe('opponentBookContext', () => {
  it('returns every legal continuation that reaches the database without changing legal choices', () => {
    const legal = legalMoves(START)
    const original = structuredClone(legal)
    const afterE4 = applyMove(START, 'e2e4')!.fen
    const afterD4 = applyMove(START, 'd2d4')!.fen
    const book: OpeningBook = {
      byEpd: new Map([
        [epdOf(afterE4), { eco: 'B00', name: "King's Pawn Game" }],
        [epdOf(afterD4), { eco: 'A40', name: "Queen's Pawn Game" }]
      ])
    }

    const context = opponentBookContext(START, legal, book)
    expect(context?.continuations).toEqual([
      { san: 'd4', uci: 'd2d4', eco: 'A40', name: "Queen's Pawn Game" },
      { san: 'e4', uci: 'e2e4', eco: 'B00', name: "King's Pawn Game" }
    ])
    expect(legal).toEqual(original)
    expect(legal).toHaveLength(20)
  })

  it('recognises the exact current opening after a transposition', () => {
    const direct = position(['d4', 'Nf6', 'c4', 'e6', 'Nf3'])
    const transposed = position(['Nf3', 'Nf6', 'd4', 'e6', 'c4'])
    expect(epdOf(transposed)).toBe(epdOf(direct))
    const book: OpeningBook = {
      byEpd: new Map([[epdOf(direct), { eco: 'E20', name: 'Nimzo-Indian setup' }]])
    }

    expect(opponentBookContext(direct, legalMoves(direct), book)?.current).toEqual({
      eco: 'E20',
      name: 'Nimzo-Indian setup'
    })
    expect(opponentBookContext(transposed, legalMoves(transposed), book)?.current).toEqual({
      eco: 'E20',
      name: 'Nimzo-Indian setup'
    })
  })

  it('returns no context for misses, empty books, or positions beyond twenty plies', () => {
    const book: OpeningBook = {
      byEpd: new Map([['unrelated', { eco: 'A00', name: 'Unrelated' }]])
    }
    expect(opponentBookContext(START, legalMoves(START), book)).toBeNull()
    expect(opponentBookContext(START, legalMoves(START), { byEpd: new Map() })).toBeNull()
    const late = START.replace(/ 0 1$/, ' 0 12')
    const lateBook: OpeningBook = {
      byEpd: new Map([[epdOf(late), { eco: 'A00', name: 'Repeated too late' }]])
    }
    expect(opponentBookContext(late, legalMoves(late), lateBook)).toBeNull()
  })
})
