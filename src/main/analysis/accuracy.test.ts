import { describe, expect, it } from 'vitest'
import { acpl, gameAccuracy, moveAccuracy } from './accuracy'

describe('moveAccuracy', () => {
  it('matches the lichess curve at the values quoted in the spec', () => {
    expect(moveAccuracy(0)).toBeCloseTo(100, 3)
    expect(moveAccuracy(30)).toBeCloseTo(24.78, 2)
    expect(moveAccuracy(10)).toBeCloseTo(63.58, 2)
  })

  it('decays and never leaves 0–100', () => {
    expect(moveAccuracy(5)).toBeGreaterThan(moveAccuracy(15))
    expect(moveAccuracy(1000)).toBe(0)
    expect(moveAccuracy(-10)).toBeCloseTo(100, 3)
  })
})

describe('gameAccuracy', () => {
  /** Twelve quiet moves: White gives away two points a move, Black plays perfectly. */
  const steady = Array.from({ length: 12 }, (_, index) => ({ loss: index % 2 === 0 ? 2 : 0, winBefore: 50 }))

  it('separates the two colours by ply parity', () => {
    const white = gameAccuracy(steady, 'w')
    const black = gameAccuracy(steady, 'b')
    expect(black).toBeCloseTo(100, 1)
    expect(white).toBeGreaterThan(85)
    expect(white).toBeLessThan(black)
  })

  it('punishes one catastrophic move more than the plain mean would', () => {
    const withBlunder = steady.map((entry, index) => (index === 4 ? { loss: 60, winBefore: 50 } : entry))
    const plainMean = withBlunder.filter((_, index) => index % 2 === 0).reduce((sum, entry) => sum + (entry.loss === 60 ? 0 : 89.6), 0) / 6
    expect(gameAccuracy(withBlunder, 'w')).toBeLessThan(gameAccuracy(steady, 'w'))
    expect(gameAccuracy(withBlunder, 'w')).toBeLessThan(plainMean + 20)
  })

  it('weighs a mistake made in a swinging position more than one made in a quiet one', () => {
    // First half of the game dead level, second half swinging from 20% to 80% and back.
    const winBefore = (index: number): number => (index < 10 ? 50 : index % 2 === 0 ? 20 : 80)
    const game = (blunderAt: number): { loss: number; winBefore: number }[] =>
      Array.from({ length: 20 }, (_, index) => ({ loss: index === blunderAt ? 25 : 0, winBefore: winBefore(index) }))
    const inQuiet = gameAccuracy(game(4), 'w')
    const inSwing = gameAccuracy(game(14), 'w')
    expect(inSwing).toBeLessThan(inQuiet)
  })

  it('gives a colour that never moved nothing to answer for', () => {
    expect(gameAccuracy([], 'w')).toBe(100)
    expect(gameAccuracy([{ loss: 40, winBefore: 50 }], 'b')).toBe(100)
  })
})

describe('acpl', () => {
  it('averages the losses in centipawns', () => {
    expect(acpl([{ cpLossInternal: 10, evalBeforeCp: 0 }, { cpLossInternal: 30, evalBeforeCp: 50 }])).toBe(20)
  })

  it('clamps a single loss at 1000', () => {
    expect(acpl([{ cpLossInternal: 9999, evalBeforeCp: 0 }])).toBe(1000)
  })

  it('ignores the moves played from an already decided position', () => {
    const moves = [
      { cpLossInternal: 20, evalBeforeCp: 100 },
      { cpLossInternal: 900, evalBeforeCp: 1500 },
      { cpLossInternal: 900, evalBeforeCp: -1500 }
    ]
    expect(acpl(moves)).toBe(20)
    expect(acpl([{ cpLossInternal: 900, evalBeforeCp: 801 }])).toBe(0)
    // Exactly ±800 is still counted.
    expect(acpl([{ cpLossInternal: 40, evalBeforeCp: 800 }])).toBe(40)
  })

  it('answers zero when nothing is left to average', () => {
    expect(acpl([])).toBe(0)
  })
})
