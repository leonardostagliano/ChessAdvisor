import type { Game } from '@shared/types/game'
import type { LevelBand } from '@shared/types/profile'

/**
 * Level estimation (spec §6.1).
 *
 * The window is the last ten analysed matches: each of them contributes the user's own ACPL and
 * accuracy, halved in weight when the game was played with takebacks, and a game the AI lost on
 * time says nothing about the user's strength, so it is left out entirely (spec §6.1, recorded by
 * the clocks of M2). Both numbers are mapped onto an Elo-like scale by the piecewise-linear
 * anchors of the spec and mixed 60/40; the confidence says how much of a window there was and how
 * steady it looked.
 *
 * Endgame drills never reach this file: they are not matches, and spec §6.7 keeps them out of the
 * level estimate and of the history alike.
 */

/** One analysed match as the estimator sees it. */
export interface LevelSample {
  /** Average centipawn loss of the user in that game. */
  acpl: number
  /** Accuracy of the user in that game, 0…100. */
  accuracy: number
  /** 1 for a clean game, 0.5 when the user took a move back (spec §6.1). */
  weight: number
}

export interface LevelEstimate {
  estimate: number
  band: LevelBand
  confidence: number
}

/** Matches the estimate looks at, most recent last. */
export const LEVEL_WINDOW = 10

/** Weight of a game played with takebacks (spec §6.1). */
export const TAKEBACK_WEIGHT = 0.5

/** ACPL → Elo, ascending in x (spec §6.1). Lower ACPL is stronger, so y falls as x rises. */
const ACPL_ANCHORS: readonly (readonly [number, number])[] = [
  [0, 2400],
  [30, 2000],
  [45, 1600],
  [70, 1200],
  [100, 800],
  [150, 500]
]

/** Accuracy → Elo, ascending in x (spec §6.1). */
const ACCURACY_ANCHORS: readonly (readonly [number, number])[] = [
  [45, 500],
  [60, 800],
  [70, 1200],
  [80, 1600],
  [88, 2000],
  [95, 2400]
]

/** How much of the estimate each map is worth (spec §6.1). */
const ACPL_SHARE = 0.6
const ACCURACY_SHARE = 0.4

/** Linear interpolation between the anchors, flat outside them. */
function interpolate(anchors: readonly (readonly [number, number])[], x: number): number {
  const first = anchors[0]!
  const last = anchors[anchors.length - 1]!
  if (!Number.isFinite(x) || x <= first[0]) return first[1]
  if (x >= last[0]) return last[1]
  for (let i = 1; i < anchors.length; i += 1) {
    const [x1, y1] = anchors[i]!
    if (x > x1) continue
    const [x0, y0] = anchors[i - 1]!
    const span = x1 - x0
    if (span === 0) return y1
    return y0 + ((y1 - y0) * (x - x0)) / span
  }
  return last[1]
}

/** `E_acpl` of spec §6.1. */
export function acplToElo(acpl: number): number {
  return interpolate(ACPL_ANCHORS, Math.max(0, acpl))
}

/** `E_acc` of spec §6.1. */
export function accuracyToElo(accuracy: number): number {
  return interpolate(ACCURACY_ANCHORS, Math.max(0, Math.min(100, accuracy)))
}

/** Bands of spec §6.1. */
export function bandOf(estimate: number): LevelBand {
  if (estimate >= 2000) return 'expert'
  if (estimate >= 1600) return 'advanced'
  if (estimate >= 1200) return 'intermediate'
  if (estimate >= 800) return 'novice'
  return 'beginner'
}

function weightedMean(samples: LevelSample[], pick: (s: LevelSample) => number): number {
  const total = samples.reduce((sum, sample) => sum + sample.weight, 0)
  if (total <= 0) return 0
  return samples.reduce((sum, sample) => sum + pick(sample) * sample.weight, 0) / total
}

/** Population standard deviation: the window is the whole population of what we know. */
function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/**
 * The estimate of spec §6.1 over the most recent {@link LEVEL_WINDOW} samples of `history`
 * (oldest first). An empty history has no level at all: `estimate 0`, `confidence 0`.
 */
export function estimateLevel(history: { acpl: number; accuracy: number; weight: number }[]): LevelEstimate {
  const samples = history
    .filter((sample) => Number.isFinite(sample.acpl) && Number.isFinite(sample.accuracy) && sample.weight > 0)
    .slice(-LEVEL_WINDOW)
  if (samples.length === 0) return { estimate: 0, band: 'beginner', confidence: 0 }

  const acpl = weightedMean(samples, (sample) => Math.max(0, sample.acpl))
  const accuracy = weightedMean(samples, (sample) => Math.max(0, Math.min(100, sample.accuracy)))
  const estimate = Math.round(ACPL_SHARE * acplToElo(acpl) + ACCURACY_SHARE * accuracyToElo(accuracy))

  const acpls = samples.map((sample) => Math.max(0, sample.acpl))
  const mean = acpls.reduce((sum, value) => sum + value, 0) / acpls.length
  // A perfectly flat (or perfect) window has no dispersion to punish.
  const dispersion = mean > 0 ? Math.min(0.5, standardDeviation(acpls) / mean) : 0
  const confidence = Math.round(Math.min(1, samples.length / LEVEL_WINDOW) * (1 - dispersion) * 100) / 100

  return { estimate, band: bandOf(estimate), confidence }
}

/**
 * The sample a finished game contributes, or `null` when spec §6.1 excludes it: anything that is
 * not an analysed match, and a match the AI lost on time.
 */
export function levelSample(game: Game): LevelSample | null {
  if (game.kind !== 'match' || game.status !== 'finished' || !game.analysis) return null
  if (isAiTimeout(game)) return null
  return {
    acpl: game.analysis.acpl[game.userColor],
    accuracy: game.analysis.accuracy[game.userColor],
    weight: game.takebacks > 0 ? TAKEBACK_WEIGHT : 1
  }
}

/** True when the game ended because the *opponent's* flag fell (spec §6.1, clocks of spec §4.3). */
export function isAiTimeout(game: Pick<Game, 'result' | 'userColor'>): boolean {
  if (!game.result || game.result.reason !== 'timeout') return false
  if (game.result.outcome === '1/2-1/2') return false
  const loser: 'w' | 'b' = game.result.outcome === '1-0' ? 'b' : 'w'
  return loser !== game.userColor
}
