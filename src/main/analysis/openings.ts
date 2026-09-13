import { readFileSync } from 'node:fs'
import { epdOf } from '@shared/chess/notation'
import type { GameOpening } from '@shared/types/game'

/**
 * Opening recognition by position (spec §3.1 and §6.6).
 *
 * `resources/data/openings.json` is built at development time by `scripts/build-datasets.mjs`
 * from the lichess `chess-openings` dataset (CC0): every row already carries the EPD — the first
 * four fields of the FEN — of the position it reaches, so recognition here is a map lookup per
 * ply and no PGN is ever replayed at runtime. Transpositions are therefore free: two different
 * move orders that reach the same position get the same name.
 */

/** One row of the dataset. `pgn` is kept for reference and is not needed to recognise anything. */
export interface OpeningEntry {
  eco: string
  name: string
  pgn?: string
  epd: string
}

export interface OpeningBook {
  byEpd: Map<string, { eco: string; name: string }>
}

/** Plies searched for a book position: an opening name past move 10 would be make-believe. */
export const MAX_BOOK_PLIES = 20

export const EMPTY_BOOK: OpeningBook = { byEpd: new Map() }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Builds the book from the JSON dataset. A missing or broken file is not fatal: no names, no crash. */
export function loadOpenings(resourcePath: string): OpeningBook {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resourcePath, 'utf8'))
  } catch (error) {
    console.error('[analysis] the openings dataset could not be read:', error)
    return { byEpd: new Map() }
  }
  if (!Array.isArray(parsed)) {
    console.error('[analysis] the openings dataset is not an array')
    return { byEpd: new Map() }
  }

  const byEpd = new Map<string, { eco: string; name: string }>()
  for (const row of parsed) {
    if (!isRecord(row)) continue
    const { eco, name, epd } = row
    if (
      typeof eco !== 'string' ||
      typeof name !== 'string' ||
      typeof epd !== 'string' ||
      epd.length === 0
    )
      continue
    // The dataset is already deduplicated by EPD; the first row still wins if it is not.
    if (!byEpd.has(epd)) byEpd.set(epd, { eco, name })
  }
  return { byEpd }
}

/**
 * Deepest book position of a game. `fens` is the whole sequence of positions — index 0 the
 * starting position, index *i* the position after ply *i* — and the answer names the last one
 * found in the book within the first {@link MAX_BOOK_PLIES} plies, so a line that leaves theory
 * and comes back is still recognised at its deepest point.
 *
 * `null` when nothing matched (an irregular first move, or an empty book).
 */
export function detectOpening(fens: string[], book: OpeningBook): GameOpening | null {
  if (!Array.isArray(fens) || fens.length < 2 || book.byEpd.size === 0) return null
  let found: GameOpening | null = null
  const last = Math.min(MAX_BOOK_PLIES, fens.length - 1)
  for (let ply = 1; ply <= last; ply += 1) {
    const entry = book.byEpd.get(epdOf(fens[ply] ?? ''))
    if (entry) found = { eco: entry.eco, name: entry.name, lastBookPly: ply }
  }
  return found
}
