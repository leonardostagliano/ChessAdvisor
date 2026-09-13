import { Chess } from 'chess.js'
import { epdOf } from '@shared/chess/notation'
import type { Game, Move, MoveClassification } from '@shared/types/game'
import type { Profile } from '@shared/types/profile'
import { EMPTY_PROFILE } from '@shared/types/profile'
import { describe, expect, it } from 'vitest'
import { buildOpeningsOverview, firstDeviation } from './openingsStudy'

/** A game whose plies carry the classifications the test wants, from the real opening moves. */
function gameWith(p: {
  id: string
  sans: string[]
  classifications: (MoveClassification | undefined)[]
  eco?: string
  result?: Game['result']
}): Game {
  const chess = new Chess()
  const moves: Move[] = p.sans.map((san, index) => {
    const played = chess.move(san)
    const classification = p.classifications[index]
    const move: Move = {
      ply: index + 1,
      san: played.san,
      uci: played.lan,
      fenAfter: chess.fen(),
      epdAfter: epdOf(chess.fen()),
      by: index % 2 === 0 ? 'user' : 'ai'
    }
    if (classification) {
      move.eval = {
        before: { cp: 20 },
        after: { cp: -80 },
        cpLoss: 100,
        winPercentLoss: 12,
        classification,
        bestMove: 'g1f3',
        bestLine: ['g1f3']
      }
    }
    return move
  })
  return {
    id: p.id,
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:30:00.000Z',
    kind: 'match',
    status: 'finished',
    userColor: 'w',
    opponent: {
      model: 'gpt-6-astra',
      effort: 'medium',
      difficulty: { mode: 'fixed', level: 3, targetElo: 1200 }
    },
    coach: { model: 'gpt-6-astra', effort: 'medium' },
    clock: null,
    language: 'it',
    moves,
    takebacks: 0,
    coachLog: [],
    ...(p.result ? { result: p.result } : {}),
    analysis: {
      accuracy: { w: 80, b: 70 },
      acpl: { w: 40, b: 60 },
      keyMoments: [],
      analyzedAt: '2026-03-01T10:40:00.000Z'
    },
    ...(p.eco ? { opening: { eco: p.eco, name: 'Partita spagnola', lastBookPly: 6 } } : {})
  }
}

const profileWith = (openingStats: Profile['openingStats']): Profile => ({
  ...EMPTY_PROFILE,
  openingStats
})

describe('firstDeviation', () => {
  it('finds the first inaccuracy or worse the user played inside the opening', () => {
    const game = gameWith({
      id: 'g1',
      sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'],
      classifications: [undefined, undefined, 'inaccuracy', undefined, 'blunder']
    })
    const deviation = firstDeviation(game)
    expect(deviation?.ply).toBe(3)
    expect(deviation?.san).toBe('Nf3')
    expect(deviation?.bestSan).toBe('Nf3')
    expect(deviation?.epd).toBe(
      epdOf('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2')
    )
  })

  it('ignores the opponent and the moves the engine never judged', () => {
    const game = gameWith({
      id: 'g1',
      sans: ['e4', 'e5', 'Nf3'],
      classifications: [undefined, 'blunder', undefined]
    })
    expect(firstDeviation(game)).toBeNull()
  })

  it('ignores a mistake played past the twentieth ply', () => {
    const sans = [
      'e4',
      'e5',
      'Nf3',
      'Nc6',
      'Bb5',
      'a6',
      'Ba4',
      'Nf6',
      'O-O',
      'Be7',
      'Re1',
      'b5',
      'Bb3',
      'd6',
      'c3',
      'O-O',
      'h3',
      'Nb8',
      'd4',
      'Nbd7',
      'c4',
      'c6'
    ]
    const classifications = sans.map((_, index) =>
      index === 20 ? ('blunder' as MoveClassification) : undefined
    )
    expect(firstDeviation(gameWith({ id: 'g1', sans, classifications }))).toBeNull()
  })
})

describe('buildOpeningsOverview', () => {
  const stats = {
    C60: {
      eco: 'C60',
      name: 'Partita spagnola',
      games: 4,
      wins: 2,
      draws: 1,
      losses: 1,
      avgAccuracyFirst10: 82.5
    },
    B20: {
      eco: 'B20',
      name: 'Siciliana',
      games: 1,
      wins: 0,
      draws: 0,
      losses: 1,
      avgAccuracyFirst10: 60
    }
  }

  it('orders the openings by how often they were played and scores them', () => {
    const rows = buildOpeningsOverview(profileWith(stats), [])
    expect(rows.map((row) => row.eco)).toEqual(['C60', 'B20'])
    expect(rows[0]?.score).toBe(62.5)
    expect(rows[1]?.score).toBe(0)
    expect(rows[0]?.deviations).toEqual([])
  })

  it('groups the same deviation across games into one line with a count', () => {
    const games = [1, 2, 3].map((n) =>
      gameWith({
        id: `g${n}`,
        sans: ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'],
        classifications: [undefined, undefined, 'mistake'],
        eco: 'C60'
      })
    )
    const rows = buildOpeningsOverview(profileWith(stats), games)
    const spanish = rows.find((row) => row.eco === 'C60')!
    expect(spanish.deviations).toHaveLength(1)
    expect(spanish.deviations[0]?.count).toBe(3)
    expect(spanish.deviations[0]?.san).toBe('Nf3')
  })

  it('keeps a game without an opening out of the deviations', () => {
    const games = [
      gameWith({
        id: 'g1',
        sans: ['e4', 'e5', 'Nf3'],
        classifications: [undefined, undefined, 'blunder']
      })
    ]
    expect(
      buildOpeningsOverview(profileWith(stats), games).every((row) => row.deviations.length === 0)
    ).toBe(true)
  })
})
