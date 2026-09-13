import { describe, expect, it } from 'vitest'
import { clampCp, internalCp, mateToCp, winPercent, winPercentLoss } from './winPercent'

describe('mateToCp', () => {
  it('orders a faster mate above a slower one, on both sides', () => {
    expect(mateToCp(1)).toBe(9999)
    expect(mateToCp(3)).toBe(9997)
    expect(mateToCp(-1)).toBe(-9999)
    expect(mateToCp(1)).toBeGreaterThan(mateToCp(5))
    expect(mateToCp(-1)).toBeLessThan(mateToCp(-5))
  })
})

describe('internalCp', () => {
  it('reads a centipawn score as it is and converts a mate', () => {
    expect(internalCp({ cp: 35 })).toBe(35)
    expect(internalCp({ mate: 2 })).toBe(9998)
    // A mate always beats any material advantage on the internal scale.
    expect(internalCp({ mate: 9 })).toBeGreaterThan(internalCp({ cp: 2000 }))
  })

  it('reads an empty evaluation as a dead draw', () => {
    expect(internalCp({})).toBe(0)
  })
})

describe('clampCp', () => {
  it('clamps to ±1000 before any probability', () => {
    expect(clampCp(9997)).toBe(1000)
    expect(clampCp(-9997)).toBe(-1000)
    expect(clampCp(250)).toBe(250)
    expect(clampCp(Number.NaN)).toBe(0)
  })
})

describe('winPercent', () => {
  it('matches the values of the lichess curve', () => {
    expect(winPercent(0)).toBeCloseTo(50, 6)
    expect(winPercent(100)).toBeCloseTo(59.1, 1)
    expect(winPercent(-100)).toBeCloseTo(40.9, 1)
    // Rule 2: a mate in 3 becomes 9997 cp and is clamped to 1000 before the curve.
    expect(winPercent(internalCp({ mate: 3 }))).toBeCloseTo(97.5, 1)
    expect(winPercent(internalCp({ mate: -3 }))).toBeCloseTo(2.5, 1)
  })

  it('is monotonic and symmetric around zero', () => {
    expect(winPercent(300)).toBeGreaterThan(winPercent(200))
    expect(winPercent(200) + winPercent(-200)).toBeCloseTo(100, 6)
  })
})

describe('winPercentLoss', () => {
  it('measures the loss of the mover, evaluations being White’s', () => {
    // White goes from +100 to 0: the loss is White's.
    expect(winPercentLoss({ cp: 100 }, { cp: 0 }, 'w')).toBeCloseTo(9.1, 1)
    expect(winPercentLoss({ cp: 100 }, { cp: 0 }, 'b')).toBe(0)
    // The same two evaluations, seen from Black, are a gain for Black and a loss for White.
    expect(winPercentLoss({ cp: 0 }, { cp: 100 }, 'b')).toBeCloseTo(9.1, 1)
  })

  it('never returns a negative loss', () => {
    expect(winPercentLoss({ cp: 0 }, { cp: 400 }, 'w')).toBe(0)
    expect(winPercentLoss({ mate: 1 }, { mate: 1 }, 'w')).toBe(0)
  })

  it('counts a missed mate as a real loss', () => {
    expect(winPercentLoss({ mate: 2 }, { cp: 0 }, 'w')).toBeCloseTo(47.5, 1)
  })
})
