import { describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import type { CoachExplanation, CoachEvidenceLine } from '@shared/types/game'
import { commentLinePosition, positionAnnotations } from './commentBoard'

const START = new Chess().fen()
const E4 = new Chess()
E4.move('e4')
const explanation = (annotations: CoachExplanation['annotations']): CoachExplanation => ({
  version: 1,
  headline: 'Centro',
  explanation: 'Controlla il centro.',
  hints: [],
  annotations
})

describe('comment board evidence', () => {
  it('keeps only occupied mentioned squares for old comments without inferring threats', () => {
    expect(
      positionAnnotations(E4.fen(), undefined, 'La casa e4 e la donna in d1; e2 è vuota.', 'Citata')
    ).toEqual([
      { square: 'e4', label: 'Citata', kind: 'focus' },
      { square: 'd1', label: 'Citata', kind: 'focus' }
    ])
  })
  it('rejects arrows that are not attacks by the specified piece and deduplicates anchors', () => {
    expect(
      positionAnnotations(
        START,
        explanation([
          { square: 'e7', from: 'a1', kind: 'threat', label: 'Inventata' },
          { square: 'e2', kind: 'focus', label: 'Pedone' },
          { square: 'e2', kind: 'focus', label: 'Duplicata' },
          { square: 'z9', kind: 'focus', label: 'Fuori' },
          { square: 'e4', kind: 'focus', label: 'Vuota' }
        ]),
        '',
        ''
      )
    ).toEqual([{ square: 'e2', kind: 'focus', label: 'Pedone' }])
  })
  it('reconstructs a legal preview from UCI, never trusting an injected cached FEN or SAN', () => {
    const line: CoachEvidenceLine = {
      kind: 'reply',
      startFen: START,
      moves: [{ uci: 'e2e4', san: 'fake', fenAfter: START }]
    }
    expect(commentLinePosition(line, START, 0)).toEqual({
      fen: E4.fen(),
      lastMove: ['e2', 'e4'],
      san: 'e4'
    })
    expect(commentLinePosition(line, START, -1)?.fen).toBe(START)
    expect(commentLinePosition(line, E4.fen(), 0)).toBeNull()
    expect(
      commentLinePosition(
        { ...line, moves: [{ uci: 'e2e5', san: 'e5', fenAfter: START }] },
        START,
        0
      )
    ).toBeNull()
    expect(commentLinePosition(line, START, 1)).toBeNull()
  })
})
