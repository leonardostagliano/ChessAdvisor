/**
 * Accuracy and ACPL of a game (spec §3.1, rules 6 and 7).
 *
 * Per move the formula is lichess': an exponential decay of the winning chance given away, so the
 * first points cost much more than the last ones. Per game it is again lichess': the mean of the
 * harmonic mean (which punishes one catastrophic move) and of a weighted mean whose weights are
 * the local volatility of the evaluation — a mistake in a quiet position weighs more than one in a
 * position that was already swinging.
 */

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/** Bounds of the volatility weights, as in lichess. */
const MIN_WEIGHT = 0.5
const MAX_WEIGHT = 12
/** Sliding window used to measure that volatility, in plies. */
const MIN_WINDOW = 2
const MAX_WINDOW = 8
/** A zero accuracy would make the harmonic mean collapse to zero for the whole game. */
const HARMONIC_FLOOR = 0.5

/** Rule 6, per move: 100 for a perfect move, ~25 for 30 points of win percentage thrown away. */
export function moveAccuracy(loss: number): number {
  const lost = Number.isFinite(loss) ? Math.max(0, loss) : 0
  return clamp(103.1668 * Math.exp(-0.04354 * lost) - 3.1669, 0, 100)
}

function standardDeviation(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/**
 * Rule 6, per game. `perMove` is the whole game in ply order — index 0 is the first move of the
 * game, so White owns the even indices and Black the odd ones — and `winBefore` is the winning
 * chance (White's, consistently) of the position each move was played from: the series whose local
 * standard deviation gives the weights.
 *
 * A colour that never moved gets 100: there is nothing to judge, and nothing was lost.
 */
export function gameAccuracy(perMove: { loss: number; winBefore: number; mover?: 'w' | 'b' }[], color: 'w' | 'b'): number {
  const series = perMove.map((entry) => (Number.isFinite(entry.winBefore) ? entry.winBefore : 50))
  const total = series.length
  if (total === 0) return 100

  const windowSize = clamp(Math.floor(total / 10), MIN_WINDOW, MAX_WINDOW)
  const weightAt = (index: number): number => {
    const end = Math.min(total, Math.max(index + 1, windowSize))
    const start = Math.max(0, end - windowSize)
    return clamp(standardDeviation(series.slice(start, end)), MIN_WEIGHT, MAX_WEIGHT)
  }

  const mine = perMove
    .map((entry, index) => ({ accuracy: moveAccuracy(entry.loss), weight: weightAt(index), index }))
    // The mover is authoritative (games from a custom position may start with Black to move);
    // index parity is only the fallback for callers that pass bare loss/win% pairs.
    .filter((entry) => {
      const mover = perMove[entry.index]?.mover
      if (mover) return mover === color
      return color === 'w' ? entry.index % 2 === 0 : entry.index % 2 === 1
    })
  if (mine.length === 0) return 100

  const weightSum = mine.reduce((sum, entry) => sum + entry.weight, 0)
  const weighted = weightSum > 0 ? mine.reduce((sum, entry) => sum + entry.accuracy * entry.weight, 0) / weightSum : mine.reduce((sum, entry) => sum + entry.accuracy, 0) / mine.length
  const harmonic = mine.length / mine.reduce((sum, entry) => sum + 1 / Math.max(HARMONIC_FLOOR, entry.accuracy), 0)

  return clamp((weighted + harmonic) / 2, 0, 100)
}

/**
 * Rule 7: average centipawn loss, with each loss capped at 1000 and every move played from an
 * already decided position (beyond ±800) left out — losing a rook when you are three queens up
 * says nothing about how well you play.
 */
export function acpl(moves: { cpLossInternal: number; evalBeforeCp: number }[]): number {
  const counted = moves.filter((move) => Number.isFinite(move.evalBeforeCp) && Math.abs(move.evalBeforeCp) <= 800)
  if (counted.length === 0) return 0
  const sum = counted.reduce((total, move) => total + clamp(Number.isFinite(move.cpLossInternal) ? move.cpLossInternal : 0, 0, 1000), 0)
  return sum / counted.length
}
