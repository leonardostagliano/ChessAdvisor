import { EMPTY_PROFILE, type Profile } from '@shared/types/profile'
import { readJson, writeJsonAtomic } from './atomicWrite'

/**
 * `profile.json` (spec §5), written atomically like every other store.
 *
 * M1 only stores the adaptive rating; the level estimate, the theme and opening statistics and
 * the history arrive in M3/M4, so `update` merges a patch instead of replacing the file: a newer
 * milestone can add its own keys without this class knowing about them.
 */
export class ProfileStore {
  private current: Profile = { ...EMPTY_PROFILE }

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

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function clone(profile: Profile): Profile {
  return profile.adaptive ? { ...profile, adaptive: { ...profile.adaptive } } : { ...profile }
}

/** A hand-edited or half-written profile must never crash the app: unknown shapes are dropped. */
export function sanitizeProfile(raw: unknown): Profile {
  if (!isRecord(raw)) return { ...EMPTY_PROFILE }
  const profile: Profile = {}
  const adaptive = raw.adaptive
  if (isRecord(adaptive) && typeof adaptive.elo === 'number' && Number.isFinite(adaptive.elo)) {
    profile.adaptive = {
      elo: Math.round(adaptive.elo),
      games: typeof adaptive.games === 'number' && adaptive.games >= 0 ? Math.round(adaptive.games) : 0,
      updatedAt: typeof adaptive.updatedAt === 'string' ? adaptive.updatedAt : new Date(0).toISOString()
    }
  }
  return profile
}
