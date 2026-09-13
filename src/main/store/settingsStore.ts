import type { DifficultyChoice, DifficultyLevel } from '@shared/types/session'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types/settings'
import { readJson, writeJsonAtomic } from './atomicWrite'

type Listener = (settings: Settings) => void

const LANGUAGES = ['it', 'en'] as const
const THEMES = ['night', 'editorial', 'system'] as const
const ENGINE_BINARIES = ['avx2', 'popcnt', 'none'] as const

const MIN_TURN_TIMEOUT_SEC = 10
const MAX_TURN_TIMEOUT_SEC = 3600

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function nullableString(value: unknown, fallback: string | null): string | null {
  if (value === null) return null
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

function engineBinary(value: unknown, fallback: Settings['engineBinary']): Settings['engineBinary'] {
  if (value === null) return null
  if (typeof value === 'string' && (ENGINE_BINARIES as readonly string[]).includes(value)) return value as 'avx2' | 'popcnt' | 'none'
  return fallback
}

/** Task 9: the new-game dialog remembers the last difficulty; an unknown shape falls back. */
function difficulty(value: unknown, fallback: DifficultyChoice): DifficultyChoice {
  if (!isRecord(value)) return { ...fallback }
  const mode = value.mode === 'adaptive' ? 'adaptive' : value.mode === 'fixed' ? 'fixed' : fallback.mode
  const raw = value.level
  const level: DifficultyLevel =
    typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 && raw <= 6 ? (raw as DifficultyLevel) : fallback.level
  return { mode, level }
}

function seconds(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded < MIN_TURN_TIMEOUT_SEC || rounded > MAX_TURN_TIMEOUT_SEC) return fallback
  return rounded
}

/**
 * Builds a complete, valid Settings object: every known key falls back to `base`
 * (the defaults, or the current value) and unknown keys are dropped.
 */
export function sanitizeSettings(raw: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  const input = isRecord(raw) ? raw : {}
  const updates = isRecord(input.updates) ? input.updates : {}
  return {
    language: oneOf(input.language, LANGUAGES, base.language),
    theme: oneOf(input.theme, THEMES, base.theme),
    defaultModel: nullableString(input.defaultModel, base.defaultModel),
    defaultEffort: nullableString(input.defaultEffort, base.defaultEffort),
    separateCoach: bool(input.separateCoach, base.separateCoach),
    coachModel: nullableString(input.coachModel, base.coachModel),
    coachEffort: nullableString(input.coachEffort, base.coachEffort),
    turnTimeoutSec: seconds(input.turnTimeoutSec, base.turnTimeoutSec),
    showReasoning: bool(input.showReasoning, base.showReasoning),
    pieceSet: oneOf(input.pieceSet, ['cburnett'] as const, base.pieceSet),
    engineBinary: engineBinary(input.engineBinary, base.engineBinary),
    lastDifficulty: difficulty(input.lastDifficulty, base.lastDifficulty),
    updates: { autoCheck: bool(updates.autoCheck, base.updates.autoCheck) }
  }
}

/** Settings persisted as one atomic JSON file; listeners see every accepted change. */
export class SettingsStore {
  private current: Settings = {
    ...DEFAULT_SETTINGS,
    lastDifficulty: { ...DEFAULT_SETTINGS.lastDifficulty },
    updates: { ...DEFAULT_SETTINGS.updates }
  }
  private readonly listeners = new Set<Listener>()

  constructor(private readonly file: string) {}

  async load(): Promise<Settings> {
    const raw = await readJson<unknown>(this.file, null)
    this.current = sanitizeSettings(raw, DEFAULT_SETTINGS)
    return this.get()
  }

  get(): Settings {
    return { ...this.current, lastDifficulty: { ...this.current.lastDifficulty }, updates: { ...this.current.updates } }
  }

  async save(patch: Partial<Settings>): Promise<Settings> {
    const merged = sanitizeSettings(
      {
        ...this.current,
        ...patch,
        lastDifficulty: { ...this.current.lastDifficulty, ...(patch.lastDifficulty ?? {}) },
        updates: { ...this.current.updates, ...(patch.updates ?? {}) }
      },
      this.current
    )
    this.current = merged
    await writeJsonAtomic(this.file, merged)
    const snapshot = this.get()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (error) {
        console.error('[settings] listener failed:', error)
      }
    }
    return snapshot
  }

  onChange(cb: Listener): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }
}
