import type { EngineLine } from '@shared/types/engine'
import type { OpponentDifficulty } from '@shared/types/session'
import { describe, expect, it } from 'vitest'
import {
  contextLines,
  difficultyPolicy,
  lineUtility,
  sampledCandidate,
  seededUnit
} from './difficultyPolicy'

const fixed = (level: 1 | 2 | 3 | 4 | 5 | 6): OpponentDifficulty => ({
  mode: 'fixed',
  level,
  targetElo: level === 6 ? null : [600, 900, 1200, 1500, 1800][level - 1]!
})
const lines: EngineLine[] = [0, 20, 60, 150, 300, 600, 1200].map((loss) => ({
  move: `loss-${loss}`,
  pv: [`loss-${loss}`],
  scoreCp: -loss,
  depth: 18
}))

describe('difficultyPolicy', () => {
  it('preserves good calculated moves in the context of every fixed tier', () => {
    for (const level of [1, 2, 3, 4, 5, 6] as const) {
      const policy = difficultyPolicy(fixed(level))
      expect(contextLines(lines, policy)[0]?.move).toBe('loss-0')
      expect(policy.hideBestContext).toBe(false)
    }
  })
  it('interpolates adaptive safety limits across persona boundaries', () => {
    for (const boundary of [750, 1050, 1350, 1650]) {
      const policy = (targetElo: number) =>
        difficultyPolicy({ mode: 'adaptive', level: 1, targetElo })
      expect(
        Math.abs(policy(boundary - 1).maximumLossCp - policy(boundary + 1).maximumLossCp)
      ).toBeLessThan(5)
    }
    expect(difficultyPolicy({ mode: 'adaptive', level: 1, targetElo: 500 }).strength).toBe(0)
    expect(difficultyPolicy({ mode: 'adaptive', level: 5, targetElo: 2400 }).strength).toBe(1)
  })
  it('samples many sound moves and occasional errors instead of a constant loss', () => {
    // Synthetic distribution fixture, independent of the real corpus.
    const policy = {
      ...difficultyPolicy(fixed(1)),
      lossQuantilesCp: [0, 0, 20, 60, 150, 600, 1200]
    }
    const losses = Array.from(
      { length: 2000 },
      (_, i) => -sampledCandidate(lines, policy, `game-${i}`)!.scoreCp!
    )
    expect(losses.filter((loss) => loss <= 20).length / losses.length).toBeGreaterThan(0.7)
    expect(losses.filter((loss) => loss >= 300).length / losses.length).toBeLessThan(0.05)
    expect(losses.some((loss) => loss >= 300)).toBe(true)
    expect(new Set(losses).size).toBeGreaterThan(3)
  })
  it('uses the best line with no supported sample or at Maximum', () => {
    const missing = { ...difficultyPolicy(fixed(1)), lossQuantilesCp: null }
    for (const policy of [missing, difficultyPolicy(fixed(6))])
      for (let i = 0; i < 50; i++)
        expect(sampledCandidate(lines, policy, String(i))?.move).toBe('loss-0')
  })
  it('never samples outside the tactical ceiling', () => {
    const policy = {
      ...difficultyPolicy(fixed(5)),
      maximumLossCp: 100,
      lossQuantilesCp: [0, 900, 1200, 1500, 2000, 2500, 3000]
    }
    for (let i = 0; i < 100; i++)
      expect(-sampledCandidate(lines, policy, `tail-${i}`)!.scoreCp!).toBeLessThanOrEqual(100)
  })
  it('keeps winning mating lines separate from centipawn losses', () => {
    const mating: EngineLine[] = [
      { move: 'mate-now', pv: [], scoreMate: 1, depth: 20 },
      { move: 'mate-later', pv: [], scoreMate: 3, depth: 20 },
      { move: 'draw', pv: [], scoreCp: 0, depth: 20 }
    ]
    for (const level of [1, 2, 3, 4, 5, 6] as const)
      expect(sampledCandidate(mating, difficultyPolicy(fixed(level)), 'mate')?.move).toMatch(
        /^mate/
      )
  })
  it('ignores invalid scores and produces stable seeds', () => {
    expect(lineUtility({ move: 'bad', pv: [], depth: 1, scoreCp: NaN })).toBeNull()
    expect(
      sampledCandidate([{ move: 'none', pv: [], depth: 1 }], difficultyPolicy(fixed(1)), '')
    ).toBeNull()
    expect(seededUnit('game-1')).toBe(seededUnit('game-1'))
    expect(seededUnit('game-1')).not.toBe(seededUnit('game-2'))
  })
})
