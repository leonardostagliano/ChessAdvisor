import type { Move, MoveEval } from '@shared/types/game'

/** Prefer the complete post-game result; the live assessment is an intentionally quick fallback. */
export function moveQuality(
  move: Pick<Move, 'eval' | 'liveEval'>
): { evaluation: MoveEval; quick: boolean } | null {
  if (move.eval) return { evaluation: move.eval, quick: false }
  if (move.liveEval) return { evaluation: move.liveEval, quick: true }
  return null
}
