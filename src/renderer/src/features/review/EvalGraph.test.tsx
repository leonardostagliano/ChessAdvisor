import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { Game, Move } from '@shared/types/game'
import { EvalGraph, evalPoints, toWhite } from './EvalGraph'

/**
 * The graph is the only place where an evaluation stored from the mover's point of view becomes a
 * single curve: every assertion here is about that conversion and about the points being all there
 * (one per position, the starting one included).
 */

const FEN_1 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'
const FEN_2 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'
const FEN_3 = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'

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

/** Three plies: the last one is a blunder of the user and the only key moment. */
export function analysedGame(): Game {
  return {
    id: 'g1',
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:05:00.000Z',
    kind: 'match',
    status: 'finished',
    userColor: 'w',
    opponent: {
      model: 'gpt-6-astra',
      effort: 'low',
      difficulty: { mode: 'fixed', level: 3, targetElo: 1200 }
    },
    coach: { model: 'gpt-6-astra', effort: 'low' },
    clock: null,
    language: 'it',
    moves: [
      move(1, 'e4', 'e2e4', FEN_1, 'user', {
        eval: {
          before: { cp: 20 },
          after: { cp: 15 },
          cpLoss: 5,
          winPercentLoss: 0.9,
          classification: 'best',
          bestMove: 'e2e4',
          bestLine: ['e2e4', 'e7e5']
        }
      }),
      move(2, 'e5', 'e7e5', FEN_2, 'ai', {
        eval: {
          before: { cp: -15 },
          after: { cp: -20 },
          cpLoss: 5,
          winPercentLoss: 0.9,
          classification: 'excellent',
          bestMove: 'e7e5',
          bestLine: ['e7e5']
        }
      }),
      move(3, 'Nf3', 'g1f3', FEN_3, 'user', {
        eval: {
          before: { cp: 20 },
          after: { cp: -300 },
          cpLoss: 320,
          winPercentLoss: 45.2,
          classification: 'blunder',
          bestMove: 'd2d4',
          bestLine: ['d2d4', 'd7d5']
        }
      })
    ],
    takebacks: 0,
    coachLog: [],
    result: { outcome: '0-1', reason: 'resign' },
    analysis: {
      accuracy: { w: 62.4, b: 88.2 },
      acpl: { w: 108, b: 12 },
      keyMoments: [3],
      analyzedAt: '2026-09-12T10:06:00.000Z'
    }
  }
}

afterEach(cleanup)

describe('toWhite', () => {
  it('leaves White alone and flips Black, mates included', () => {
    expect(toWhite({ cp: 30 }, 'w')).toEqual({ cp: 30 })
    expect(toWhite({ cp: 30 }, 'b')).toEqual({ cp: -30 })
    expect(toWhite({ mate: 3 }, 'b')).toEqual({ mate: -3 })
    expect(toWhite(undefined, 'w')).toBeUndefined()
  })
})

describe('evalPoints', () => {
  it('gives one point per position, the starting one included', () => {
    const points = evalPoints(analysedGame())
    expect(points).toHaveLength(4)
    expect(points.map((point) => point.ply)).toEqual([0, 1, 2, 3])
  })

  it('reads every point as White, whoever played the move', () => {
    const points = evalPoints(analysedGame())
    // Black answered e5 and stood at −20 from its own side: White is therefore slightly better.
    expect(points[2]!.white).toBeGreaterThan(50)
    // The user's blunder leaves White at −300: the curve falls well under the middle.
    expect(points[3]!.white).toBeLessThan(30)
  })

  it('marks the key moments and keeps the classification of every ply', () => {
    const points = evalPoints(analysedGame())
    expect(points[3]).toMatchObject({ classification: 'blunder', key: true })
    expect(points[1]!.key).toBeUndefined()
  })

  it('carries the last known value through a ply the analysis has not filled', () => {
    const game = analysedGame()
    delete game.moves[2]!.eval
    const points = evalPoints(game)
    expect(points).toHaveLength(4)
    expect(points[3]!.white).toBeCloseTo(points[2]!.white, 5)
  })

  it('draws nothing for a game without moves', () => {
    expect(evalPoints({ ...analysedGame(), moves: [] })).toEqual([])
  })
})

describe('EvalGraph', () => {
  it('renders one clickable band per position and reports the ply that was clicked', () => {
    const onSelect = vi.fn()
    const { container } = render(<EvalGraph game={analysedGame()} cursor={2} onSelect={onSelect} />)
    const bands = container.querySelectorAll('[data-ply]')
    expect(bands).toHaveLength(4)
    fireEvent.click(bands[1]!)
    // The second band is the position after ply 1, whose cursor is the index 0.
    expect(onSelect).toHaveBeenCalledWith(0)
    fireEvent.click(bands[0]!)
    expect(onSelect).toHaveBeenCalledWith(-1)
  })

  it('labels itself and every point in words, not by colour alone', () => {
    const { container } = render(
      <EvalGraph game={analysedGame()} cursor={-1} onSelect={() => {}} />
    )
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', expect.stringContaining('3'))
    expect(container.querySelector('[data-ply="3"] title')?.textContent).toContain('Errore grave')
    expect(container.querySelector('[data-ply="0"] title')?.textContent).toContain(
      'Posizione iniziale'
    )
  })

  it('draws a dot on the key moments only', () => {
    const { container } = render(<EvalGraph game={analysedGame()} cursor={0} onSelect={() => {}} />)
    // One dot for the blunder plus the marker of the current ply.
    expect(container.querySelectorAll('circle')).toHaveLength(2)
  })

  it('renders nothing at all when the game has no moves', () => {
    const { container } = render(
      <EvalGraph game={{ ...analysedGame(), moves: [] }} cursor={-1} onSelect={() => {}} />
    )
    expect(container.querySelector('svg')).toBeNull()
  })
})
