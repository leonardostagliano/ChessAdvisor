import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import { EMPTY_PROFILE } from '@shared/types/profile'
import { writeJsonAtomic } from './atomicWrite'

export const LEARNING_POLICY_VERSION = 2
const MARKER_FILE = 'learning-policy.json'
const BACKUP_PREFIX = 'learning-v1-'
const RESET_FILES = ['profile.json', 'exercises.json', 'study-plan.json'] as const

export interface LearningMigrationResult {
  migrated: boolean
  learningPolicyVersion: number
  retiredGameIds: string[]
  backupDir?: string
}

interface LearningPolicyMarker {
  version: number
  migratedAt: string
  retiredGameIds: string[]
  backupDir: string
}

const nonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0

async function gameIds(dataDir: string): Promise<string[]> {
  const dir = join(dataDir, 'games')
  const names = await fsp.readdir(dir).catch(() => [] as string[])
  const ids = new Set<string>()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed: unknown = JSON.parse(await fsp.readFile(join(dir, name), 'utf8'))
      if (typeof parsed === 'object' && parsed !== null && 'id' in parsed) {
        const id = (parsed as { id?: unknown }).id
        if (nonEmptyString(id)) ids.add(id)
      }
    } catch {
      // GameStore skips malformed records too; they cannot be reintroduced into learning.
    }
  }
  return [...ids].sort()
}

async function existingBackup(dataDir: string): Promise<string | null> {
  const entries = await fsp
    .readdir(join(dataDir, 'backups'), { withFileTypes: true })
    .catch(() => [])
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(BACKUP_PREFIX))
    .map((entry) => entry.name)
    .sort()
  return dirs.length > 0 ? join(dataDir, 'backups', dirs[dirs.length - 1]!) : null
}

async function backupOriginals(dataDir: string, now: () => number): Promise<string> {
  const prior = await existingBackup(dataDir)
  const timestamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  const dir = prior ?? join(dataDir, 'backups', BACKUP_PREFIX + timestamp)
  await fsp.mkdir(dir, { recursive: true })
  for (const name of RESET_FILES) {
    const source = join(dataDir, name)
    const target = join(dir, name)
    if (
      await fsp.stat(source).then(
        () => true,
        () => false
      )
    ) {
      if (
        !(await fsp.stat(target).then(
          () => true,
          () => false
        ))
      )
        await fsp.copyFile(source, target)
    }
  }
  return dir
}

async function readMarker(path: string): Promise<LearningPolicyMarker | null> {
  try {
    const value: unknown = JSON.parse(await fsp.readFile(path, 'utf8'))
    if (typeof value !== 'object' || value === null) return null
    const marker = value as Partial<LearningPolicyMarker>
    if (typeof marker.version !== 'number' || !Number.isFinite(marker.version)) return null
    if (!nonEmptyString(marker.backupDir) || !Array.isArray(marker.retiredGameIds)) return null
    return {
      version: Math.round(marker.version),
      migratedAt: nonEmptyString(marker.migratedAt) ? marker.migratedAt : new Date(0).toISOString(),
      backupDir: marker.backupDir,
      retiredGameIds: marker.retiredGameIds.filter(nonEmptyString)
    }
  } catch {
    return null
  }
}

/**
 * Performs the one-time v1 -> v2 learning reset. Raw game files are never removed or rewritten.
 * Backups are made before any reset and the marker is written last, so an interrupted migration
 * can safely be retried against the same backup directory.
 */
export async function migrateLearningData(
  dataDir: string,
  now: () => number = Date.now
): Promise<LearningMigrationResult> {
  await fsp.mkdir(dataDir, { recursive: true })
  const markerPath = join(dataDir, MARKER_FILE)
  const marker = await readMarker(markerPath)
  if (marker && marker.version >= LEARNING_POLICY_VERSION) {
    return {
      migrated: false,
      learningPolicyVersion: marker.version,
      retiredGameIds: [...marker.retiredGameIds],
      backupDir: marker.backupDir
    }
  }

  const retiredGameIds = await gameIds(dataDir)
  const backupDir = await backupOriginals(dataDir, now)
  const resetProfile = {
    ...EMPTY_PROFILE,
    learningPolicyVersion: LEARNING_POLICY_VERSION,
    retiredGameIds
  }
  await writeJsonAtomic(join(dataDir, 'profile.json'), resetProfile)

  const exercisesPath = join(dataDir, 'exercises.json')
  let exercises: unknown = []
  try {
    exercises = JSON.parse(await fsp.readFile(exercisesPath, 'utf8'))
  } catch {
    // Invalid or absent derived data is reset to an empty catalogue.
  }
  const retainedExercises = Array.isArray(exercises)
    ? exercises.filter(
        (row) =>
          typeof row !== 'object' || row === null || (row as { kind?: unknown }).kind !== 'own_game'
      )
    : []
  await writeJsonAtomic(exercisesPath, retainedExercises)
  await fsp.rm(join(dataDir, 'study-plan.json'), { force: true })

  const nextMarker: LearningPolicyMarker = {
    version: LEARNING_POLICY_VERSION,
    migratedAt: new Date(now()).toISOString(),
    retiredGameIds,
    backupDir
  }
  await writeJsonAtomic(markerPath, nextMarker)
  return { migrated: true, learningPolicyVersion: nextMarker.version, ...nextMarker }
}
