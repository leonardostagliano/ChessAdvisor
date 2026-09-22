import type { EngineLine } from '@shared/types/engine'
import type { OpponentDifficulty } from '@shared/types/session'
import { describe, expect, it } from 'vitest'
import {
  contextLines,
  difficultyPolicy,
  sampledCandidate,
  shouldAdjustModelMove
} from './difficultyPolicy'

const fixed = (level: 1 | 2 | 3 | 4 | 5 | 6): OpponentDifficulty => ({
  mode: 'fixed',
  level,
  targetElo: level === 6 ? null : [600, 900, 1200, 1500, 1800][level - 1]!
})

const lines: EngineLine[] = [
  { move: 'best', pv: ['best'], scoreCp: 1000, depth: 18 },
  { move: 'good', pv: ['good'], scoreCp: 700, depth: 18 },
  { move: 'usable', pv: ['usable'], scoreCp: 350, depth: 18 },
  { move: 'risky', pv: ['risky'], scoreCp: 0, depth: 18 },
  { move: 'bad', pv: ['bad'], scoreCp: -500, depth: 18 }
]

describe('difficultyPolicy', () => {
  it('samples monotonically more accurate candidates as the fixed tier rises', () => {
    const losses = ([1, 2, 3, 4, 5, 6] as const).map((level) => {
      const chosen = sampledCandidate(lines, difficultyPolicy(fixed(level)), 'fixture')!
      return 1000 - (chosen.scoreCp ?? 0)
    })
    for (let index = 1; index < losses.length; index += 1)
      expect(losses[index - 1]).toBeGreaterThanOrEqual(losses[index]!)
    expect(losses[0]).toBeGreaterThan(0)
    expect(losses[5]).toBe(0)
  })

  it('interpolates adaptive tiers instead of snapping policy behaviour to the nearest level', () => {
    const low = difficultyPolicy({ mode: 'adaptive', level: 1, targetElo: 750 })
    const high = difficultyPolicy({ mode: 'adaptive', level: 5, targetElo: 1650 })
    expect(low.targetLossCp).toBeGreaterThan(high.targetLossCp)
    expect(low.adjustmentRate).toBeGreaterThan(high.adjustmentRate)
    expect(low.contextCandidates).toBeLessThan(high.contextCandidates)
    expect(difficultyPolicy({ mode: 'adaptive', level: 5, targetElo: 1800 }).strength).toBeCloseTo(
      difficultyPolicy(fixed(5)).strength
    )
  })

  it('keeps the best PV out of lower-tier prompts while preserving it at strong tiers', () => {
    expect(contextLines(lines, difficultyPolicy(fixed(1))).map((line) => line.move)).toEqual([
      'good'
    ])
    expect(contextLines(lines, difficultyPolicy(fixed(5))).map((line) => line.move)).toContain(
      'best'
    )
  })

  it('keeps a forced mate inside the mating candidates at every tier', () => {
    const mating: EngineLine[] = [
      { move: 'mate-now', pv: ['mate-now'], scoreMate: 1, depth: 20 },
      { move: 'mate-later', pv: ['mate-later'], scoreMate: 3, depth: 20 },
      { move: 'draw', pv: ['draw'], scoreCp: 0, depth: 20 }
    ]
    for (const level of [1, 2, 3, 4, 5, 6] as const)
      expect(sampledCandidate(mating, difficultyPolicy(fixed(level)), 'mate')?.move).toMatch(
        /^mate/
      )
  })

  it('has deterministic adjustment decisions and leaves Maximum untouched', () => {
    const policy = difficultyPolicy(fixed(1))
    expect(shouldAdjustModelMove(policy, 'same-seed')).toBe(
      shouldAdjustModelMove(policy, 'same-seed')
    )
    expect(shouldAdjustModelMove(difficultyPolicy(fixed(6)), 'any')).toBe(false)
  })
})
