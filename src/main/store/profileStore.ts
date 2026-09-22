import {
  EMPTY_PROFILE,
  type OpeningStat,
  type Profile,
  type ProfileHistoryEntry,
  type ThemeStat
} from '@shared/types/profile'
import { readJson, writeJsonAtomic } from './atomicWrite'

/**
 * `profile.json` (spec §5), written atomically like every other store.
 *
 * `update` merges a patch instead of replacing the file, so the adaptive rating (M1), the level
 * estimate and the statistics (M4) and whatever a later milestone adds can be written one at a
 * time without any of them knowing about the others. Everything that comes back from disk goes
 * through {@link sanitizeProfile}: a hand-edited or half-written file must never crash the app,
 * and the renderer can rely on the collections always being there.
 */
export class ProfileStore {
  private current: Profile = clone(EMPTY_PROFILE)

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    const raw = await readJson<unknown>(this.file, null)
    this.current = sanitizeProfile(raw)
  }

  get(): Profile {
    return clone(this.current)
  }

  /** Shallow merge, persisted before it is returned: the caller never sees an unsaved profile. */
  async update(patch: Partial<Profile>): Promise<Profile> {
    const merged = sanitizeProfile({ ...this.current, ...patch })
    await writeJsonAtomic(this.file, merged)
    this.current = merged
    return clone(merged)
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const finiteNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const isoString = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.length > 0 ? value : fallback

function clone(profile: Profile): Profile {
  return {
    ...profile,
    retiredGameIds: [...profile.retiredGameIds],
    ...(profile.adaptive ? { adaptive: { ...profile.adaptive } } : {}),
    level: { ...profile.level },
    ...(profile.qualitative
      ? {
          qualitative: {
            ...profile.qualitative,
            strengths: [...profile.qualitative.strengths],
            weaknesses: [...profile.qualitative.weaknesses]
          }
        }
      : {}),
    themeStats: Object.fromEntries(
      Object.entries(profile.themeStats).map(([key, stat]) => [key, { ...stat }])
    ),
    openingStats: Object.fromEntries(
      Object.entries(profile.openingStats).map(([key, stat]) => [key, { ...stat }])
    ),
    ...(profile.results ? { results: { ...profile.results } } : {}),
    history: profile.history.map((entry) => ({ ...entry }))
  }
}

const BANDS = new Set(['beginner', 'novice', 'intermediate', 'advanced', 'expert'])

function sanitizeStrings(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
}

/** A hand-edited or half-written profile must never crash the app: unknown shapes are dropped. */
export function sanitizeProfile(raw: unknown): Profile {
  const profile: Profile = clone(EMPTY_PROFILE)
  if (!isRecord(raw)) return profile

  if (typeof raw.learningPolicyVersion === 'number' && Number.isFinite(raw.learningPolicyVersion))
    profile.learningPolicyVersion = Math.max(0, Math.round(raw.learningPolicyVersion))
  if (Array.isArray(raw.retiredGameIds)) {
    profile.retiredGameIds = [
      ...new Set(
        raw.retiredGameIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      )
    ]
  }

  const adaptive = raw.adaptive
  if (isRecord(adaptive) && typeof adaptive.elo === 'number' && Number.isFinite(adaptive.elo)) {
    profile.adaptive = {
      elo: Math.round(adaptive.elo),
      games:
        typeof adaptive.games === 'number' && adaptive.games >= 0 ? Math.round(adaptive.games) : 0,
      updatedAt: isoString(adaptive.updatedAt, new Date(0).toISOString())
    }
  }

  const level = raw.level
  if (isRecord(level)) {
    const band =
      typeof level.band === 'string' && BANDS.has(level.band)
        ? (level.band as Profile['level']['band'])
        : EMPTY_PROFILE.level.band
    profile.level = {
      band,
      estimate: Math.round(Math.max(0, finiteNumber(level.estimate, 0))),
      confidence: Math.min(1, Math.max(0, finiteNumber(level.confidence, 0))),
      updatedAt: isoString(level.updatedAt, EMPTY_PROFILE.level.updatedAt)
    }
  }

  const qualitative = raw.qualitative
  if (isRecord(qualitative)) {
    const strengths = sanitizeStrings(qualitative.strengths)
    const weaknesses = sanitizeStrings(qualitative.weaknesses)
    if (strengths.length > 0 || weaknesses.length > 0) {
      profile.qualitative = {
        strengths,
        weaknesses,
        updatedAt: isoString(qualitative.updatedAt, new Date(0).toISOString())
      }
    }
  }

  const themeStats = raw.themeStats
  if (isRecord(themeStats)) {
    for (const [key, value] of Object.entries(themeStats)) {
      if (!isRecord(value)) continue
      const occurrences = Math.round(Math.max(0, finiteNumber(value.occurrences, 0)))
      if (occurrences === 0) continue
      const stat: ThemeStat = {
        occurrences,
        lastSeen: isoString(value.lastSeen, new Date(0).toISOString())
      }
      profile.themeStats[key] = stat
    }
  }

  const openingStats = raw.openingStats
  if (isRecord(openingStats)) {
    for (const [key, value] of Object.entries(openingStats)) {
      if (!isRecord(value)) continue
      const stat: OpeningStat = {
        eco: typeof value.eco === 'string' ? value.eco : key,
        name: typeof value.name === 'string' ? value.name : key,
        games: Math.round(Math.max(0, finiteNumber(value.games, 0))),
        wins: Math.round(Math.max(0, finiteNumber(value.wins, 0))),
        draws: Math.round(Math.max(0, finiteNumber(value.draws, 0))),
        losses: Math.round(Math.max(0, finiteNumber(value.losses, 0))),
        avgAccuracyFirst10: Math.min(100, Math.max(0, finiteNumber(value.avgAccuracyFirst10, 0)))
      }
      if (stat.games === 0) continue
      profile.openingStats[key] = stat
    }
  }

  const results = raw.results
  if (isRecord(results)) {
    profile.results = {
      games: Math.round(Math.max(0, finiteNumber(results.games, 0))),
      wins: Math.round(Math.max(0, finiteNumber(results.wins, 0))),
      draws: Math.round(Math.max(0, finiteNumber(results.draws, 0))),
      losses: Math.round(Math.max(0, finiteNumber(results.losses, 0)))
    }
  }

  if (Array.isArray(raw.history)) {
    for (const value of raw.history) {
      if (!isRecord(value) || typeof value.gameId !== 'string' || value.gameId.length === 0)
        continue
      const entry: ProfileHistoryEntry = {
        gameId: value.gameId,
        date: isoString(value.date, new Date(0).toISOString()),
        accuracy: Math.min(100, Math.max(0, finiteNumber(value.accuracy, 0))),
        acpl: Math.max(0, finiteNumber(value.acpl, 0))
      }
      profile.history.push(entry)
    }
  }

  profile.gamesSincePlan = Math.round(Math.max(0, finiteNumber(raw.gamesSincePlan, 0)))
  return profile
}
