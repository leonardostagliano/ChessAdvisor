import { applyMove, epdOf, type LegalMove } from '@shared/chess/notation'
import { MAX_BOOK_PLIES, type OpeningBook } from '../analysis/openings'

export interface OpponentBookEntry {
  eco: string
  name: string
}

export interface OpponentBookContinuation extends OpponentBookEntry {
  san: string
  uci: string
}

export interface OpponentBookContext {
  /** Exact database match for the position the opponent is looking at. */
  current: OpponentBookEntry | null
  /** Every legal move whose resulting position has an exact database match. */
  continuations: OpponentBookContinuation[]
}

function plyOf(fen: string): number | null {
  const fields = String(fen ?? '')
    .trim()
    .split(/\s+/)
  const fullmove = Number(fields[5])
  if (!Number.isInteger(fullmove) || fullmove < 1 || (fields[1] !== 'w' && fields[1] !== 'b'))
    return null
  return (fullmove - 1) * 2 + (fields[1] === 'b' ? 1 : 0)
}

/**
 * Opening reference for an opponent turn.
 *
 * Matching is position-based, so transpositions work without replaying an opening line. Only the
 * first twenty plies are considered. The returned continuations are context; callers must keep
 * the original legal-move list intact and must not limit the model to these moves.
 */
export function opponentBookContext(
  fen: string,
  legal: readonly LegalMove[],
  book: OpeningBook
): OpponentBookContext | null {
  const ply = plyOf(fen)
  if (ply === null || ply > MAX_BOOK_PLIES || book.byEpd.size === 0) return null

  const current = book.byEpd.get(epdOf(fen)) ?? null
  const continuations: OpponentBookContinuation[] = []
  if (ply < MAX_BOOK_PLIES) {
    for (const move of legal) {
      const result = applyMove(fen, move.uci)
      if (!result) continue
      const entry = book.byEpd.get(epdOf(result.fen))
      if (entry) continuations.push({ san: move.san, uci: move.uci, ...entry })
    }
  }

  if (!current && continuations.length === 0) return null
  return { current: current ? { ...current } : null, continuations }
}
