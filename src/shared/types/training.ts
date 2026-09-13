/**
 * Training data shared by the main process, the preload bridge and the renderer (spec §6.4–§6.8).
 *
 * This file starts with the two bundled datasets — the puzzles carved out of the lichess database
 * and the curated endgames — because they are the only training material that exists before a
 * single game has been played. Exercises, thematic sets and the study plan build on them.
 */

/** Colour to move in a position, as chess.js spells it. */
export type Side = 'w' | 'b'

/**
 * One tactical puzzle of `resources/data/puzzles.json`.
 *
 * The record is already "playable": `scripts/build-datasets.mjs` applied the opponent premove of
 * the lichess record to the original FEN, so `fen` is the position the user actually sees and
 * `solution` starts with the user's own move. Even indices of `solution` are the user's moves,
 * odd indices the replies played automatically (spec §6.5). Everything is UCI.
 */
export interface Puzzle {
  id: string
  fen: string
  sideToMove: Side
  solution: string[]
  /** Lichess puzzle rating, 400–2200 in the bundled subset. */
  rating: number
  /** Themes of the fixed taxonomy (spec §6.2); the lichess vocabulary never leaks out of the build. */
  themes: string[]
  source: 'lichess'
}

/** What the user has to achieve in an endgame drill (spec §6.7). */
export type EndgameGoal = 'win' | 'draw'

/** One curated endgame of `resources/data/endgames.json`; the name ships in both languages. */
export interface EndgamePosition {
  id: string
  name: { it: string; en: string }
  fen: string
  sideToMove: Side
  goal: EndgameGoal
  /** 1 easy, 2 medium, 3 hard — shown as a chip, never used as an Elo. */
  difficulty: 1 | 2 | 3
  /** Theme of the fixed taxonomy (spec §6.2). */
  theme: string
}

/** How many puzzles a thematic set holds (spec §6.5). */
export const THEMATIC_SET_SIZE = 10

/** Rating window used while the profile has no data yet (spec §6.5). */
export const DEFAULT_RATING_WINDOW = { min: 800, max: 1200 } as const
