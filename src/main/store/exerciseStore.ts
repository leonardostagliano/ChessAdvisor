import type { Exercise, ExerciseKind, ExerciseStatus, Side } from '@shared/types/training'
import { readJson, writeJsonAtomic } from './atomicWrite'

/**
 * `exercises.json` (spec §5, `Exercise`), written atomically like every other store.
 *
 * One flat file holds every exercise of every kind: the ones carved out of the user's own games,
 * the puzzles of the thematic sets and one record per endgame drill that has been started. They
 * are few by nature — a handful per analysed game, ten per set — so keeping them in memory and
 * rewriting the file on every change is both simpler and safer than a directory of small files.
 *
 * Ids are deterministic (`og-<gameId>-<ply>`, `tac-<puzzleId>`, `end-<endgameId>`): re-analysing a
 * game or asking for a theme twice updates the same records instead of piling duplicates up.
 */
export class ExerciseStore {
  private readonly byId = new Map<string, Exercise>()
  /** A failed write must not poison later saves. */
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly write: typeof writeJsonAtomic = writeJsonAtomic
  ) {}

  async load(): Promise<void> {
    const raw = await readJson<unknown>(this.file, null)
    this.byId.clear()
    if (!Array.isArray(raw)) return
    for (const row of raw) {
      const exercise = sanitizeExercise(row)
      if (exercise && !this.byId.has(exercise.id)) this.byId.set(exercise.id, exercise)
    }
  }

  /** Newest first, optionally of one kind only. */
  list(kind?: ExerciseKind): Exercise[] {
    const all = [...this.byId.values()].filter((exercise) => !kind || exercise.kind === kind)
    return all
      .sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.id.localeCompare(b.id)
      )
      .map(clone)
  }

  get(id: string): Exercise | null {
    const exercise = this.byId.get(id)
    return exercise ? clone(exercise) : null
  }

  has(id: string): boolean {
    return this.byId.has(id)
  }

  /** Ids of the exercises in a given state — what the thematic draw excludes (spec §6.5). */
  idsWithStatus(status: ExerciseStatus, kind?: ExerciseKind): Set<string> {
    const ids = new Set<string>()
    for (const exercise of this.byId.values()) {
      if (exercise.status === status && (!kind || exercise.kind === kind)) ids.add(exercise.id)
    }
    return ids
  }

  /** Writes one exercise; an id already known is replaced, not duplicated. */
  async put(exercise: Exercise): Promise<Exercise> {
    const stored = clone(exercise)
    this.byId.set(stored.id, stored)
    await this.flush()
    return clone(stored)
  }

  /** Writes several exercises in one go: one file write for a whole thematic set. */
  async putMany(exercises: Exercise[]): Promise<Exercise[]> {
    const stored = exercises.map(clone)
    for (const exercise of stored) this.byId.set(exercise.id, exercise)
    await this.flush()
    return stored.map(clone)
  }

  /**
   * Merges a patch into an existing exercise; answers `null` when the id is unknown.
   * A key set to `undefined` is *removed* — that is how `reset()` forgets a `solvedAt`.
   */
  async update(id: string, patch: Partial<Exercise>): Promise<Exercise | null> {
    const current = this.byId.get(id)
    if (!current) return null
    const merged: Exercise = { ...current, ...patch, id: current.id }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete (merged as unknown as Record<string, unknown>)[key]
    }
    this.byId.set(id, merged)
    await this.flush()
    return clone(merged)
  }

  async delete(id: string): Promise<void> {
    if (!this.byId.delete(id)) return
    await this.flush()
  }

  private flush(): Promise<void> {
    // Mutations update memory synchronously, but disk snapshots must commit in order. Build the
    // snapshot only when this write reaches the head of the queue, so it includes every mutation
    // that happened while an earlier atomic rename was still pending.
    const write = this.writeQueue.then(() => this.write(this.file, [...this.byId.values()]))
    this.writeQueue = write.catch(() => undefined)
    return write
  }
}

function clone(exercise: Exercise): Exercise {
  return {
    ...exercise,
    solution: [...exercise.solution],
    ...(exercise.alternatives
      ? { alternatives: exercise.alternatives.map((line) => [...line]) }
      : {})
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const KINDS = new Set<ExerciseKind>(['own_game', 'thematic', 'endgame'])
const STATUSES = new Set<ExerciseStatus>(['new', 'solved', 'failed'])

function uciList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((move): move is string => typeof move === 'string' && move.length >= 4)
}

/** A hand-edited or half-written file must never crash the app: unknown shapes are dropped. */
export function sanitizeExercise(raw: unknown): Exercise | null {
  if (!isRecord(raw)) return null
  const { id, kind, fen, sideToMove, theme } = raw
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof kind !== 'string' || !KINDS.has(kind as ExerciseKind)) return null
  if (typeof fen !== 'string' || fen.length === 0) return null
  if (sideToMove !== 'w' && sideToMove !== 'b') return null
  if (typeof theme !== 'string' || theme.length === 0) return null

  const alternatives = Array.isArray(raw.alternatives)
    ? raw.alternatives.map(uciList).filter((line) => line.length > 0)
    : []
  const status =
    typeof raw.status === 'string' && STATUSES.has(raw.status as ExerciseStatus)
      ? (raw.status as ExerciseStatus)
      : 'new'
  return {
    id,
    kind: kind as ExerciseKind,
    fen,
    sideToMove: sideToMove as Side,
    solution: uciList(raw.solution),
    ...(alternatives.length > 0 ? { alternatives } : {}),
    theme,
    ...(typeof raw.rating === 'number' && Number.isFinite(raw.rating)
      ? { rating: Math.round(raw.rating) }
      : {}),
    ...(typeof raw.sourceGameId === 'string' && raw.sourceGameId
      ? { sourceGameId: raw.sourceGameId }
      : {}),
    ...(typeof raw.sourcePly === 'number' && Number.isFinite(raw.sourcePly)
      ? { sourcePly: Math.round(raw.sourcePly) }
      : {}),
    ...(typeof raw.explanation === 'string' && raw.explanation.trim()
      ? { explanation: raw.explanation }
      : {}),
    status,
    attempts: typeof raw.attempts === 'number' && raw.attempts > 0 ? Math.round(raw.attempts) : 0,
    ...(typeof raw.solvedAt === 'string' && raw.solvedAt ? { solvedAt: raw.solvedAt } : {}),
    createdAt:
      typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : new Date(0).toISOString()
  }
}
