import { Chess } from 'chess.js'
import { normalizeMove } from './notation'

export interface PgnOptions {
  /** Starting position; when set it is written as the `SetUp`/`FEN` header pair. */
  startFen?: string
  /** Extra tag pairs (Event, White, Black, Result, …) written before the movetext. */
  headers?: Record<string, string>
}

/**
 * Renders a game as PGN. The movetext comes from chess.js itself, so numbering,
 * black-to-move continuations (`1. ... e5`) and SetUp/FEN headers are standard and the
 * output loads back with `loadPgn`. Each SAN is normalised first, so the sloppy spellings
 * a model produces (`0-0`, `e8Q`) still end up as valid PGN.
 * A move that is not legal stops the movetext there: a truncated PGN is still usable,
 * a broken one is not.
 */
export function pgnOf(moves: { san: string }[], opts?: PgnOptions): string {
  const chess = opts?.startFen ? new Chess(opts.startFen) : new Chess()
  for (const [key, value] of Object.entries(opts?.headers ?? {})) {
    chess.setHeader(key, value)
  }
  for (const move of moves) {
    const normalized = normalizeMove(chess.fen(), move.san)
    if (!normalized) {
      console.warn(`[pgn] stopping at move ${move.san}: not legal in ${chess.fen()}`)
      break
    }
    chess.move(normalized.san)
  }
  return chess.pgn()
}
