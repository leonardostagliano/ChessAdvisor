/**
 * The user's profile (spec §5).
 *
 * It is the only file of the app that describes the *player* instead of a game: the adaptive
 * rating of the opponent (M1), the estimated level and its confidence (spec §6.1), the qualitative
 * assessment written by the coach every three analysed games, the counters of the taxonomy themes
 * (spec §6.2/§6.3), the statistics per opening (spec §6.6), the history that feeds the accuracy
 * trend of the dashboard (spec §6.9) and the counter the study plan watches (spec §6.8).
 *
 * Everything is written by {@link ProfileStore} one patch at a time, and a file coming from an
 * older version simply misses keys: the sanitizer fills them with the empty shape below.
 */

/** Bands of spec §6.1, from the weakest to the strongest. */
export type LevelBand = 'beginner' | 'novice' | 'intermediate' | 'advanced' | 'expert'

export interface ProfileLevel {
  band: LevelBand
  /** Elo-like estimate, rounded (spec §6.1). `0` while no analysed match exists. */
  estimate: number
  /** 0…1: how much the estimate can be trusted, from the size and the variance of the window. */
  confidence: number
  updatedAt: string
}

/** Strengths and weaknesses written by the coach from the aggregated data (spec §6.1). */
export interface ProfileQualitative {
  strengths: string[]
  weaknesses: string[]
  updatedAt: string
}

/** One theme of the fixed taxonomy, counted over the labelled key moments (spec §6.3). */
export interface ThemeStat {
  occurrences: number
  lastSeen: string
}

/** One opening the user has played, keyed by ECO code in {@link Profile.openingStats}. */
export interface OpeningStat {
  eco: string
  name: string
  games: number
  wins: number
  draws: number
  losses: number
  /** Mean accuracy of the user's own moves inside the first ten plies, one decimal. */
  avgAccuracyFirst10: number
}

/** One analysed match, from the user's point of view; drills never enter it (spec §6.7). */
export interface ProfileHistoryEntry {
  gameId: string
  date: string
  accuracy: number
  acpl: number
}

export interface Profile {
  /** Version of the learning data policy that produced this profile. */
  learningPolicyVersion: number
  /** Games recorded before the current learning policy; retained but excluded from learning. */
  retiredGameIds: string[]
  /** Target Elo of the adaptive opponent and how many adaptive matches fed it (spec §4.1). */
  adaptive?: { elo: number; games: number; updatedAt: string }
  level: ProfileLevel
  qualitative?: ProfileQualitative
  themeStats: Record<string, ThemeStat>
  openingStats: Record<string, OpeningStat>
  history: ProfileHistoryEntry[]
  /** Matches analysed since the study plan was generated (spec §6.8). */
  gamesSincePlan: number
}

/** The profile of someone who has never played: every collection empty, no level yet. */
export const EMPTY_PROFILE: Profile = {
  learningPolicyVersion: 2,
  retiredGameIds: [],
  level: { band: 'beginner', estimate: 0, confidence: 0, updatedAt: new Date(0).toISOString() },
  themeStats: {},
  openingStats: {},
  history: [],
  gamesSincePlan: 0
}
