import type { EngineLine } from '@shared/types/engine'
import {
  DIFFICULTY_LEVELS,
  type DifficultyLevel,
  type OpponentDifficulty
} from '@shared/types/session'

/**
 * The opponent model is useful for natural play and comments, but it cannot by itself make the
 * six levels reliably distinct. This policy turns the requested tier into a repeatable amount of
 * engine-guided imprecision. It is deliberately not an Elo calibration.
 */
export interface DifficultyPolicy {
  /** 0 at Beginner, 1 at Maximum; adaptive ratings interpolate instead of snapping to a tier. */
  strength: number
  /** Centipawn loss the sampled engine fallback tends towards, subject to a tactical ceiling. */
  targetLossCp: number
  /** Never deliberately choose a candidate beyond this tactical ceiling. */
  maximumLossCp: number
  /** Candidate PVs exposed to the language model; the legal move list is always complete. */
  contextCandidates: number
  /** Low tiers learn from alternatives, rather than receiving the engine's top move as an answer. */
  hideBestContext: boolean
  /** Chance that a materially stronger model choice is softened to the sampled policy candidate. */
  adjustmentRate: number
}

const FIXED_STRENGTH: Record<DifficultyLevel, number> = {
  1: 0,
  2: 0.25,
  3: 0.5,
  4: 0.7,
  5: 0.88,
  6: 1
}

const LOSS_CEILINGS = [1200, 700, 350, 200, 100, 50]
const TARGET_LOSSES = [650, 390, 180, 80, 25, 0]
const ADJUSTMENT_RATES = [0.8, 0.6, 0.35, 0.15, 0.04, 0]
const MATE_SCORE = 100_000

const clamp = (value: number, low: number, high: number): number =>
  Math.min(high, Math.max(low, value))

function interpolate(values: readonly number[], strength: number): number {
  const clamped = clamp(strength, 0, 1)
  for (let index = 1; index < values.length; index += 1) {
    const highStrength = FIXED_STRENGTH[(index + 1) as DifficultyLevel]
    if (clamped > highStrength) continue
    const previous = index - 1
    const previousStrength = FIXED_STRENGTH[index as DifficultyLevel]
    const portion = (clamped - previousStrength) / (highStrength - previousStrength)
    return values[previous]! + (values[index]! - values[previous]!) * portion
  }
  return values[values.length - 1]!
}

function adaptiveStrength(targetElo: number | null): number {
  const elo = targetElo ?? DIFFICULTY_LEVELS[3].elo ?? 1200
  // Match the fixed 600/900/1200/1500/1800 anchors exactly, then leave room above 1800 for a
  // smooth approach to Maximum instead of making an adaptive 1800 player perfect overnight.
  const anchors: [number, number][] = [
    [600, FIXED_STRENGTH[1]],
    [900, FIXED_STRENGTH[2]],
    [1200, FIXED_STRENGTH[3]],
    [1500, FIXED_STRENGTH[4]],
    [1800, FIXED_STRENGTH[5]],
    [2400, FIXED_STRENGTH[6]]
  ]
  if (elo <= anchors[0]![0]) return anchors[0]![1]
  for (let index = 1; index < anchors.length; index += 1) {
    const [highElo, highStrength] = anchors[index]!
    if (elo > highElo) continue
    const [lowElo, lowStrength] = anchors[index - 1]!
    return lowStrength + ((elo - lowElo) / (highElo - lowElo)) * (highStrength - lowStrength)
  }
  return 1
}

export function difficultyPolicy(difficulty: OpponentDifficulty): DifficultyPolicy {
  const strength =
    difficulty.mode === 'adaptive'
      ? adaptiveStrength(difficulty.targetElo)
      : FIXED_STRENGTH[difficulty.level]
  return {
    strength,
    targetLossCp: Math.round(interpolate(TARGET_LOSSES, strength)),
    maximumLossCp: Math.round(interpolate(LOSS_CEILINGS, strength)),
    contextCandidates: Math.round(1 + strength * 5),
    hideBestContext: strength < 0.65,
    adjustmentRate: interpolate(ADJUSTMENT_RATES, strength)
  }
}

/** Stable pseudo-randomness keeps a saved/reopened game reproducible without making every game alike. */
export function seededUnit(seed: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0) / 0x1_0000_0000
}

export function lineUtility(line: EngineLine | undefined): number | null {
  if (!line) return null
  if (typeof line.scoreMate === 'number') {
    if (line.scoreMate === 0) return -MATE_SCORE
    return Math.sign(line.scoreMate) * (MATE_SCORE - Math.min(999, Math.abs(line.scoreMate)))
  }
  return typeof line.scoreCp === 'number' ? line.scoreCp : null
}

function sortedScored(lines: readonly EngineLine[]): { line: EngineLine; score: number }[] {
  return lines
    .map((line) => ({ line, score: lineUtility(line) }))
    .filter((entry): entry is { line: EngineLine; score: number } => entry.score !== null)
    .sort(
      (left, right) => right.score - left.score || left.line.move.localeCompare(right.line.move)
    )
}

/** The lower-tier prompt intentionally omits the best calculated line where another exists. */
export function contextLines(lines: readonly EngineLine[], policy: DifficultyPolicy): EngineLine[] {
  const sorted = sortedScored(lines).map((entry) => entry.line)
  if (sorted.length === 0) return []
  const start = policy.hideBestContext && sorted.length > 1 ? 1 : 0
  return sorted.slice(start, start + policy.contextCandidates)
}

/**
 * Chooses a legal-root candidate close to the tier's intended error. Winning mating lines remain
 * protected: a level may miss a positional idea, but it never voluntarily throws away a forced
 * mate merely to look weaker.
 */
export function sampledCandidate(
  lines: readonly EngineLine[],
  policy: DifficultyPolicy,
  seed: string
): EngineLine | null {
  const scored = sortedScored(lines)
  if (scored.length === 0) return null
  const best = scored[0]!
  if (policy.targetLossCp === 0) return best.line

  // Preserve an immediate mate; the loss ceiling also keeps proven winning mating lines.
  const forcedWin = best.line.scoreMate === 1
  const candidates = scored.filter((entry) => {
    if (forcedWin && entry.score <= MATE_SCORE - 1_000) return false
    return best.score - entry.score <= policy.maximumLossCp
  })
  if (candidates.length === 0) return best.line

  const desiredLoss = policy.targetLossCp * (0.45 + seededUnit(seed + ':loss') * 0.9)
  return candidates.slice().sort((left, right) => {
    const leftDistance = Math.abs(best.score - left.score - desiredLoss)
    const rightDistance = Math.abs(best.score - right.score - desiredLoss)
    if (leftDistance !== rightDistance) return leftDistance - rightDistance
    return seededUnit(seed + ':' + left.line.move) - seededUnit(seed + ':' + right.line.move)
  })[0]!.line
}

export function shouldAdjustModelMove(policy: DifficultyPolicy, seed: string): boolean {
  return policy.adjustmentRate > 0 && seededUnit(seed + ':adjust') < policy.adjustmentRate
}
