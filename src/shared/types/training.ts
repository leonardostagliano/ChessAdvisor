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

// ─── Task 20: exercises, thematic sets, openings, endgames and study plan ─────
// Everything below describes *training material made for this user*: the exercises carved out of
// their own games, the sets the coach picks for them, the openings they actually play and the
// plan that ties the lot together. The datasets above are the raw material; these are the shapes
// the renderer reads through the `training` namespace.

/** Where an exercise comes from (spec §5, `Exercise.kind`). */
export type ExerciseKind = 'own_game' | 'thematic' | 'endgame'

/** Lifecycle of one exercise; a wrong move marks it `failed` until it is solved or reset. */
export type ExerciseStatus = 'new' | 'solved' | 'failed'

/**
 * One exercise the user can play (spec §5, §6.4–§6.7).
 *
 * `solution` alternates the user's moves (even indices) and the replies the app plays by itself
 * (odd indices), all in UCI — the very convention of the bundled puzzles, so a thematic exercise
 * is a {@link Puzzle} with a status on top. `alternatives` holds the equally good user moves
 * Stockfish found while the exercise was built: each entry is a line from the exercise position,
 * so its last move is the accepted alternative at that ply (spec §6.4).
 *
 * Endgame drills have no solution: they are played as a whole game (spec §6.7) and `sourceGameId`
 * points at the drill that was started from the position.
 */
export interface Exercise {
  id: string
  kind: ExerciseKind
  fen: string
  sideToMove: Side
  solution: string[]
  alternatives?: string[][]
  /** Theme of the fixed taxonomy (spec §6.2). */
  theme: string
  rating?: number
  sourceGameId?: string
  sourcePly?: number
  /** Coach explanation, written on demand and kept for the next time (spec §6.4). */
  explanation?: string
  status: ExerciseStatus
  attempts: number
  solvedAt?: string
  createdAt: string
}

/** Answer to one move played inside an exercise (spec §6.4). */
export interface AttemptResult {
  correct: boolean
  /** True when the exercise is over — the solution ran out, or an alternative ended it. */
  done: boolean
  /** Reply played automatically after a correct move, UCI; absent when there is none. */
  reply?: string
  /** Position the board must show after the attempt. */
  fen: string
  /** True when the move was not the main line but an equally good alternative. */
  alternativesAccepted: boolean
}

/** One set of ten puzzles chosen by the coach for a theme (spec §6.5). */
export interface ThematicSet {
  theme: string
  ratingMin: number
  ratingMax: number
  /** One sentence from the coach; the rotation writes its own when there is no coach answer. */
  motivation: string
  exercises: Exercise[]
  /** True when the theme came from the rotation of spec §6.5 instead of the coach. */
  fallback: boolean
}

/** One recurring deviation from theory inside an opening (spec §6.6). */
export interface OpeningDeviation {
  /** Position the user went wrong from, as EPD: the grouping key across games. */
  epd: string
  /** Move actually played, in SAN. */
  san: string
  count: number
  /** What the engine preferred there, in SAN; empty when the analysis never said. */
  bestSan: string
}

/** One row of the openings table of the training section (spec §6.6). */
export interface OpeningOverviewEntry {
  eco: string
  name: string
  games: number
  /** Points won out of the games played, as a percentage (a draw is half a point). */
  score: number
  avgAccuracyFirst10: number
  deviations: OpeningDeviation[]
}

/** One curated endgame with the state of the user's attempts at it (spec §6.7). */
export interface EndgameListEntry extends EndgamePosition {
  status: ExerciseStatus
  attempts: number
  /** Last drill started from the position, so the UI can link to its review. */
  gameId: string | null
}

/** Kinds of activity a study-plan item can point at (spec §6.8). */
export type StudyActivityType = 'thematic' | 'own_game' | 'opening' | 'endgame' | 'play'

export interface StudyPlanItem {
  id: string
  title: string
  why: string
  /** `ref` is one id of the catalogue the plan was generated from; `play` carries none. */
  activity: { type: StudyActivityType; ref: string | null }
  done: boolean
  /** Computed when the plan is read: the referenced material does not exist any more. */
  invalidRef?: boolean
}

export interface StudyPlan {
  generatedAt: string
  items: StudyPlanItem[]
}

/** What `training.plan.get()` answers: the plan plus the two reasons to regenerate it (spec §6.8). */
export interface StudyPlanView {
  plan: StudyPlan | null
  /** True when the plan is stale: too many analysed games since, or too many dangling refs. */
  suggestRegenerate: boolean
  invalidRefs: number
  gamesSincePlan: number
}

/** The explicit catalogue the plan prompt is built from; `play` needs no id (spec §6.8). */
export interface StudyCatalogue {
  themes: string[]
  exercises: string[]
  openings: string[]
  endgames: string[]
}

/** A coach turn of the training section, announced so the renderer can follow its stream. */
export interface TrainingActivity {
  kind: 'explain' | 'lesson' | 'thematic'
  /** Exercise id, ECO code, or `null` when the turn is about nothing in particular. */
  ref: string | null
  /** Correlates the `stream` deltas while the turn runs; `null` once it is over. */
  streamId: string | null
  busy: boolean
}

/**
 * The single event of the `training` namespace: something the screens show has changed.
 * `activity` is set only for `kind:'activity'`, which is how a streaming turn is announced.
 */
export interface TrainingChanged {
  kind: 'exercises' | 'plan' | 'activity'
  activity?: TrainingActivity
}
