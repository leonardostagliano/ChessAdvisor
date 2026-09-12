/**
 * The user's profile (spec §5).
 *
 * M1 only needs the adaptive-difficulty rating: level estimate, theme statistics, opening
 * statistics and history arrive with the analysis pipeline and the training milestones, so every
 * field stays optional and the file is written by {@link ProfileStore} one patch at a time.
 */
export interface Profile {
  /** Target Elo of the adaptive opponent and how many adaptive matches fed it (spec §4.1). */
  adaptive?: { elo: number; games: number; updatedAt: string }
}

export const EMPTY_PROFILE: Profile = {}
