import type { Exercise, Puzzle } from '@shared/types/training'
import { DEFAULT_RATING_WINDOW } from '@shared/types/training'
import { normalizeTheme, THEMES, type Theme } from '../profile/themes'

/**
 * Thematic sets (spec §6.5).
 *
 * The coach chooses a theme and a rating window from the profile; the library draws ten puzzles
 * that are inside that window and not solved yet. Everything the coach says is squeezed back into
 * what the library can actually serve — a theme outside the taxonomy, a window upside down or a
 * rating nobody has puzzles for would all end in an empty set — and when there is no coach answer
 * at all (no data yet, a failed turn) the themes simply rotate over the taxonomy in the default
 * window, which is what spec §6.5 asks for.
 *
 * Nothing here needs Stockfish: a thematic set works on a machine with no engine at all.
 */

/** Bounds of the bundled puzzle dataset; a window outside them can only draw nothing. */
export const RATING_FLOOR = 400
export const RATING_CEILING = 2200
/** Narrowest window that still has puzzles in practice; a narrower one is widened upwards. */
export const MIN_RATING_SPAN = 100
/** Width a broken window falls back to, around the value the coach did give. */
export const DEFAULT_RATING_SPAN = 400

/** Deterministic id: the same puzzle is always the same exercise, drawn twice or not. */
export const thematicExerciseId = (puzzleId: string): string => `tac-${puzzleId}`

/** What the coach answered, once it has been made usable. */
export interface ThemePick {
  theme: Theme
  ratingMin: number
  ratingMax: number
  motivation: string
  /** True when the answer could not be used and the rotation of spec §6.5 decided instead. */
  fallback: boolean
}

const clampRating = (value: number): number => Math.min(RATING_CEILING, Math.max(RATING_FLOOR, Math.round(value)))

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

/**
 * The theme of the next set when the coach cannot be asked (spec §6.5): the taxonomy in its own
 * order, rotated by how many sets have been drawn so far, restricted to what the library holds.
 */
export function rotationTheme(rotation: number, available: readonly string[]): Theme {
  const usable = THEMES.filter((theme) => available.includes(theme))
  const pool: readonly Theme[] = usable.length > 0 ? usable : THEMES
  const index = ((Math.trunc(rotation) % pool.length) + pool.length) % pool.length
  return pool[index]!
}

/** The rotation's own pick, in the default window of spec §6.5. */
export function rotationPick(rotation: number, available: readonly string[]): ThemePick {
  return {
    theme: rotationTheme(rotation, available),
    ratingMin: DEFAULT_RATING_WINDOW.min,
    ratingMax: DEFAULT_RATING_WINDOW.max,
    motivation: '',
    fallback: true
  }
}

/**
 * The coach's answer, made usable (spec §6.5).
 *
 * An unknown theme becomes {@link normalizeTheme}'s fallback, a window upside down is turned
 * around, a window outside the dataset is clamped into it and one too narrow to draw from is
 * widened; a missing window falls back to the default one. `null` is answered only when the
 * object carries nothing usable at all, and then the caller rotates instead.
 */
export function sanitizeThemePick(raw: Record<string, unknown> | null): ThemePick | null {
  if (!raw) return null
  const theme = typeof raw.theme === 'string' && raw.theme.trim().length > 0 ? normalizeTheme(raw.theme) : null
  if (!theme) return null

  let min = finite(raw.ratingMin)
  let max = finite(raw.ratingMax)
  if (min === null && max === null) {
    min = DEFAULT_RATING_WINDOW.min
    max = DEFAULT_RATING_WINDOW.max
  } else if (min === null) min = (max as number) - DEFAULT_RATING_SPAN
  else if (max === null) max = min + DEFAULT_RATING_SPAN

  if ((min as number) > (max as number)) {
    const swap = min as number
    min = max as number
    max = swap
  }
  let ratingMin = clampRating(min as number)
  let ratingMax = clampRating(max as number)
  if (ratingMax - ratingMin < MIN_RATING_SPAN) {
    ratingMax = clampRating(ratingMin + DEFAULT_RATING_SPAN)
    // A window pinned against the ceiling grows downwards instead.
    if (ratingMax - ratingMin < MIN_RATING_SPAN) ratingMin = clampRating(ratingMax - DEFAULT_RATING_SPAN)
  }

  const motivation = typeof raw.motivation === 'string' ? raw.motivation.trim() : ''
  return { theme, ratingMin, ratingMax, motivation, fallback: false }
}

/**
 * One bundled puzzle as a playable exercise (spec §6.5).
 *
 * The record is already the position *after* the lichess premove and its solution already starts
 * with the user's move, so nothing is replayed here: the puzzle is copied over with the theme of
 * the set — the one the user is training — as its own.
 */
export function puzzleToExercise(puzzle: Puzzle, theme: string, createdAt: string): Exercise {
  return {
    id: thematicExerciseId(puzzle.id),
    kind: 'thematic',
    fen: puzzle.fen,
    sideToMove: puzzle.sideToMove,
    solution: [...puzzle.solution],
    theme: puzzle.themes.includes(theme) ? theme : (puzzle.themes[0] ?? theme),
    rating: puzzle.rating,
    status: 'new',
    attempts: 0,
    createdAt
  }
}
