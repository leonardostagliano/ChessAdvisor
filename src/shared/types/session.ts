import type { Game } from './game'
import type { LegalMove } from '../chess/notation'

/**
 * Difficulty of the opponent and live state of the single active game (spec §4.1, §4.3).
 *
 * Difficulty replaces the old "style": six fixed levels plus an adaptive mode whose target Elo
 * follows the user's results. It never changes the model or the effort the user picked — the persona, calculated search budget and tactical tolerance change instead.
 */

export type DifficultyLevel = 1 | 2 | 3 | 4 | 5 | 6

/** What the new-game dialog stores; `level` is kept even in adaptive mode as the last selection. */
export interface DifficultyChoice {
  mode: 'fixed' | 'adaptive'
  level: DifficultyLevel
}

/** Difficulty resolved when the game starts. Level 6 (Massimo) has no target Elo. */
export interface OpponentDifficulty {
  mode: 'fixed' | 'adaptive'
  level: DifficultyLevel
  targetElo: number | null
}

/** Key of the i18n label of each level, and the indicative requested Elo (not a calibrated strength). */
export const DIFFICULTY_LEVELS: Record<
  DifficultyLevel,
  { key: 'beginner' | 'easy' | 'medium' | 'challenging' | 'strong' | 'max'; elo: number | null }
> = {
  1: { key: 'beginner', elo: 600 },
  2: { key: 'easy', elo: 900 },
  3: { key: 'medium', elo: 1200 },
  4: { key: 'challenging', elo: 1500 },
  5: { key: 'strong', elo: 1800 },
  6: { key: 'max', elo: null }
}

/** Levels that carry a target Elo, ascending; level 6 is never a candidate. */
const RATED_LEVELS: DifficultyLevel[] = [1, 2, 3, 4, 5]

/**
 * Level whose Elo is closest to `elo`, ties going to the higher level (750 → 2, 1050 → 3).
 * Only used by the adaptive mode, which never plays the unrated level 6 persona.
 */
export function nearestLevel(elo: number): DifficultyLevel {
  let best: DifficultyLevel = 1
  let bestDistance = Number.POSITIVE_INFINITY
  for (const level of RATED_LEVELS) {
    const target = DIFFICULTY_LEVELS[level].elo
    if (target === null) continue
    const distance = Math.abs(target - elo)
    // `<=` while walking upwards is what makes a tie resolve to the higher level.
    if (distance <= bestDistance) {
      bestDistance = distance
      best = level
    }
  }
  return best
}

/**
 * Clocks of a game (spec §4.3), all in milliseconds. `aiClock:false` is the default mode
 * ("Solo il mio tempo"): the AI simply has no clock.
 */
export interface ClockConfig {
  initialMs: number
  incrementMs: number
  aiClock: boolean
  /**
   * Colour the opponent plays. The dialog cannot know it — the colour may be random — so the
   * session fills it in when it builds the clock of the game.
   */
  aiColor?: 'w' | 'b'
}

/** Clocks as the renderer sees them: the values at `updatedAt`, interpolated for display only. */
export interface ClockState {
  remainingMs: { w: number; b: number }
  running: 'w' | 'b' | null
  updatedAt: number
}

/** Everything the new-game dialog collects; the session resolves colour and difficulty from it. */
export interface NewGameOptions {
  userColor: 'w' | 'b' | 'random'
  model: string
  effort: string
  difficulty: DifficultyChoice
  coach: { model: string; effort: string }
  language: 'it' | 'en'
  showReasoning: boolean
  commentsVisible: boolean
  /** Absent or `null` for a game with no clock (spec §4.3). */
  clock?: ClockConfig | null
  startFen?: string
  kind?: 'match' | 'endgame_drill'
}

/** Whole state of the play screen, pushed on `game:state` after every transition. */
export interface SessionState {
  game: Game | null
  fen: string
  legal: LegalMove[]
  turn: 'w' | 'b'
  userToMove: boolean
  ai: {
    thinking: boolean
    startedAt: number | null
    reasoning: string
    retries: number
    streamId: string | null
  }
  /** Live engine score of `fen`, always from White's perspective. */
  liveEval: { cp?: number; mate?: number; depth: number } | null
  status: 'idle' | 'playing' | 'finished' | 'error'
  error: string | null
  /** Clocks of the running game, owned by the main process; `null` when the game has none. */
  clock: ClockState | null
  /** Everything the Commenti and Coach tabs need (spec §4.2), pushed with the rest of the state. */
  coach: CoachState
}

/** Live state of the coach thread of the running game. */
export interface CoachState {
  /** Whether new moves are commented; turning it on never comments backwards (spec §4.2). */
  commentsVisible: boolean
  /** True while a coach turn (comment, answer or hint) is running. */
  busy: boolean
  /** Correlates the `stream` deltas of the running coach turn; `null` when idle. */
  streamId: string | null
  /** Last hint, drawn as an arrow on the board; cleared by the next user move. */
  hint: { move: string; uci: string; reason: string } | null
  /** Last answer of the Coach tab; `question` is `null` for an answer with no question. */
  lastAnswer: { question: string | null; text: string; ply: number } | null
}
