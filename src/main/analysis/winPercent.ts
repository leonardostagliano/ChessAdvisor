import type { Eval } from '@shared/types/game'

/**
 * From an engine score to a winning probability (spec §3.1, AnalysisPipeline rules 1–4).
 *
 * SIGNS. Every `Eval` handled here is already **from White's point of view** — the convention of
 * `SessionState.liveEval` and of the coach prompts, and the one the pipeline converts the engine's
 * side-to-move scores into. Whose loss is being measured is said separately, by the `mover`
 * argument of {@link winPercentLoss}; nothing in this file guesses a perspective.
 */

/** Mate distance to the internal centipawn scale, so evaluations are totally ordered (rule 1). */
export function mateToCp(mate: number): number {
  const plies = Math.abs(mate)
  const sign = mate >= 0 ? 1 : -1
  return sign * (10_000 - plies)
}

/** The one number that stands for an evaluation: mate scores enter the same scale as centipawns. */
export function internalCp(e: Eval): number {
  if (typeof e?.mate === 'number') return mateToCp(e.mate)
  if (typeof e?.cp === 'number') return e.cp
  return 0
}

/** Rule 2: every probability is computed on a score clamped to ±1000 cp. */
export function clampCp(cp: number): number {
  if (!Number.isFinite(cp)) return 0
  return Math.min(1000, Math.max(-1000, cp))
}

/**
 * Rule 3, lichess' curve: the chance of winning for the side the score belongs to.
 * `cpForSideToMove` is a centipawn score from the point of view of whoever the answer is about.
 */
export function winPercent(cpForSideToMove: number): number {
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * clampCp(cpForSideToMove))) - 1)
}

/**
 * Rule 4: how much winning chance `mover` gave away with the move that led from `before` to
 * `after`. Both evaluations are White's; they are flipped once for a Black mover, and the result
 * is clamped at zero, because a move can never be rewarded for the opponent's mistakes.
 */
export function winPercentLoss(before: Eval, after: Eval, mover: 'w' | 'b'): number {
  const flip = mover === 'b' ? -1 : 1
  const win = (value: Eval): number => winPercent(flip * internalCp(value))
  return Math.max(0, win(before) - win(after))
}
