import type { MoveClassification } from '@shared/types/game'

/**
 * Quality label of one move (spec §3.1, rule 5).
 *
 * The three high thresholds are lichess': inaccuracy ≥ 10, mistake ≥ 20, blunder ≥ 30 points of
 * win percentage given away. `book`, `best`, `excellent` and `good` are ChessAdvisor's own labels,
 * and a loss between 5 and 10 deliberately stays `good`: a tutor does not scold a reasonable move.
 */

export type Classification = MoveClassification

/** Boundaries of the four judged bands, in points of win percentage lost. */
export const CLASSIFICATION_THRESHOLDS = {
  excellent: 2,
  inaccuracy: 10,
  mistake: 20,
  blunder: 30
} as const

export function classify(p: {
  loss: number
  playedUci: string
  bestUci: string
  inBook: boolean
}): Classification {
  if (p.inBook) return 'book'
  // The engine's first choice is the best move even when the two evaluations disagree by a hair.
  if (p.playedUci.length > 0 && p.playedUci === p.bestUci) return 'best'

  const loss = Number.isFinite(p.loss) ? Math.max(0, p.loss) : 0
  if (loss >= CLASSIFICATION_THRESHOLDS.blunder) return 'blunder'
  if (loss >= CLASSIFICATION_THRESHOLDS.mistake) return 'mistake'
  if (loss >= CLASSIFICATION_THRESHOLDS.inaccuracy) return 'inaccuracy'
  if (loss < CLASSIFICATION_THRESHOLDS.excellent) return 'excellent'
  return 'good'
}
