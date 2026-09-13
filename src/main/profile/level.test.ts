import type { Game } from '@shared/types/game'
import { describe, expect, it } from 'vitest'
import {
  accuracyToElo,
  acplToElo,
  bandOf,
  estimateLevel,
  isAiTimeout,
  levelSample,
  TAKEBACK_WEIGHT
} from './level'

/** A finished, analysed match of the user with White. */
function game(patch: Partial<Game> = {}): Game {
  return {
    id: 'g1',
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
    moves: [],
    takebacks: 0,
    coachLog: [],
    result: { outcome: '1-0', reason: 'resign' },
    analysis: {
      accuracy: { w: 88, b: 70 },
      acpl: { w: 30, b: 80 },
      keyMoments: [],
      analyzedAt: '2026-03-01T10:35:00.000Z'
    },
    ...patch
  }
}

describe('the ACPL and accuracy maps of spec §6.1', () => {
  it('returns the anchors themselves', () => {
    expect(acplToElo(0)).toBe(2400)
    expect(acplToElo(30)).toBe(2000)
    expect(acplToElo(45)).toBe(1600)
    expect(acplToElo(70)).toBe(1200)
    expect(acplToElo(100)).toBe(800)
    expect(acplToElo(150)).toBe(500)
    expect(accuracyToElo(95)).toBe(2400)
    expect(accuracyToElo(88)).toBe(2000)
    expect(accuracyToElo(80)).toBe(1600)
    expect(accuracyToElo(70)).toBe(1200)
    expect(accuracyToElo(60)).toBe(800)
    expect(accuracyToElo(45)).toBe(500)
  })

  it('interpolates linearly between two anchors', () => {
    // Halfway between 45 → 1600 and 70 → 1200.
    expect(acplToElo(57.5)).toBe(1400)
    expect(acplToElo(15)).toBe(2200)
    // Halfway between 80 → 1600 and 88 → 2000.
    expect(accuracyToElo(84)).toBe(1800)
  })

  it('stays flat outside the anchors instead of running off the scale', () => {
    expect(acplToElo(-10)).toBe(2400)
    expect(acplToElo(900)).toBe(500)
    expect(accuracyToElo(100)).toBe(2400)
    expect(accuracyToElo(0)).toBe(500)
  })
})

describe('bandOf', () => {
  it('uses the thresholds of spec §6.1, boundaries included', () => {
    expect(bandOf(2000)).toBe('expert')
    expect(bandOf(1999)).toBe('advanced')
    expect(bandOf(1600)).toBe('advanced')
    expect(bandOf(1599)).toBe('intermediate')
    expect(bandOf(1200)).toBe('intermediate')
    expect(bandOf(1199)).toBe('novice')
    expect(bandOf(800)).toBe('novice')
    expect(bandOf(799)).toBe('beginner')
  })
})

describe('estimateLevel', () => {
  it('has no level at all without samples', () => {
    expect(estimateLevel([])).toEqual({ estimate: 0, band: 'beginner', confidence: 0 })
  })

  it('mixes the two maps 60/40', () => {
    // ACPL 45 → 1600, accuracy 70 → 1200: 0.6 × 1600 + 0.4 × 1200 = 1440.
    const level = estimateLevel([{ acpl: 45, accuracy: 70, weight: 1 }])
    expect(level.estimate).toBe(1440)
    expect(level.band).toBe('intermediate')
  })

  it('weighs a game with takebacks half as much', () => {
    const clean = { acpl: 30, accuracy: 88, weight: 1 }
    const halved = { acpl: 150, accuracy: 45, weight: 0.5 }
    // Weighted ACPL = (30 + 75) / 1.5 = 70 → 1200; weighted accuracy = (88 + 22.5) / 1.5 = 73.67.
    const level = estimateLevel([clean, halved])
    expect(level.estimate).toBe(Math.round(0.6 * 1200 + 0.4 * accuracyToElo((88 + 45 * 0.5) / 1.5)))
    // The same two games at full weight land lower: the takeback game would count twice as much.
    expect(estimateLevel([clean, { ...halved, weight: 1 }]).estimate).toBeLessThan(level.estimate)
  })

  it('looks at the last ten samples only', () => {
    const old = Array.from({ length: 10 }, () => ({ acpl: 150, accuracy: 45, weight: 1 }))
    const recent = Array.from({ length: 10 }, () => ({ acpl: 30, accuracy: 88, weight: 1 }))
    expect(estimateLevel([...old, ...recent]).estimate).toBe(2000)
  })

  it('grows the confidence with the window and shrinks it with the variance', () => {
    const steady = Array.from({ length: 10 }, () => ({ acpl: 40, accuracy: 80, weight: 1 }))
    expect(estimateLevel(steady).confidence).toBe(1)
    // Half a window of identical games: min(1, 5/10) × (1 − 0) = 0.5.
    expect(estimateLevel(steady.slice(0, 5)).confidence).toBe(0.5)
    // Same window, wildly different games: the dispersion is capped at 0.5, so 1 × (1 − 0.5).
    const noisy = Array.from({ length: 10 }, (_, index) => ({
      acpl: index % 2 === 0 ? 5 : 140,
      accuracy: 70,
      weight: 1
    }))
    expect(estimateLevel(noisy).confidence).toBe(0.5)
  })
})

describe('levelSample', () => {
  it('reads the user’s own numbers and a full weight', () => {
    expect(levelSample(game())).toEqual({ acpl: 30, accuracy: 88, weight: 1 })
    expect(levelSample(game({ userColor: 'b' }))).toEqual({ acpl: 80, accuracy: 70, weight: 1 })
  })

  it('halves the weight of a game played with takebacks', () => {
    expect(levelSample(game({ takebacks: 2 }))?.weight).toBe(TAKEBACK_WEIGHT)
  })

  it('excludes drills, unfinished games and games that were never analysed', () => {
    expect(levelSample(game({ kind: 'endgame_drill' }))).toBeNull()
    expect(levelSample(game({ status: 'in_progress' }))).toBeNull()
    expect(levelSample(game({ analysis: undefined }))).toBeNull()
  })

  it('excludes a game the AI lost on time, and keeps one the user lost on time', () => {
    expect(levelSample(game({ result: { outcome: '1-0', reason: 'timeout' } }))).toBeNull()
    expect(levelSample(game({ result: { outcome: '0-1', reason: 'timeout' } }))).not.toBeNull()
    expect(isAiTimeout({ userColor: 'b', result: { outcome: '0-1', reason: 'timeout' } })).toBe(
      true
    )
    expect(isAiTimeout({ userColor: 'w', result: { outcome: '1-0', reason: 'checkmate' } })).toBe(
      false
    )
  })
})
