import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { join } from 'node:path'
import type { Game, GameFilter, GameSummary } from '@shared/types/game'
import { cleanupTmp, writeJsonAtomic } from './atomicWrite'

/** Everything `create` cannot invent: the rest of a Game is set by the store itself. */
export type GameInit = Omit<Game, 'id' | 'createdAt' | 'updatedAt' | 'moves' | 'takebacks' | 'coachLog' | 'status'>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** A file only enters the index when it has the shape the rest of the app relies on. */
function isGame(value: unknown): value is Game {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.moves) &&
    isRecord(value.opponent)
  )
}

function summaryOf(game: Game): GameSummary {
  return {
    id: game.id,
    createdAt: game.createdAt,
    updatedAt: game.updatedAt,
    kind: game.kind,
    status: game.status,
    userColor: game.userColor,
    opponent: { ...game.opponent },
    result: game.result ? { ...game.result } : undefined,
    opening: game.opening ? { ...game.opening } : undefined,
    plies: game.moves.length,
    accuracy: game.analysis ? { ...game.analysis.accuracy } : undefined
  }
}

/** Most recently touched first; createdAt and id only break ties deterministically. */
function newestFirst(a: GameSummary, b: GameSummary): number {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
}

/**
 * One JSON file per game under `dir`, written atomically, plus an in-memory index so the
 * archive list never has to read every game back.
 */
export class GameStore {
  private readonly index = new Map<string, GameSummary>()

  /** `now` is injectable so tests can pin createdAt/updatedAt; production uses the wall clock. */
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now
  ) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`)
  }

  private stamp(): string {
    return new Date(this.now()).toISOString()
  }

  /** Rebuilds the index from disk and clears tmp files left behind by an interrupted write. */
  async load(): Promise<void> {
    this.index.clear()
    await fsp.mkdir(this.dir, { recursive: true }).catch(() => undefined)
    await cleanupTmp(this.dir).catch(() => 0)
    const entries = await fsp.readdir(this.dir).catch(() => [] as string[])
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const path = join(this.dir, name)
      let parsed: unknown
      try {
        parsed = JSON.parse(await fsp.readFile(path, 'utf8'))
      } catch (error) {
        // Left on disk on purpose: a half-written game is still the user's game.
        console.warn(`[games] skipping unreadable file ${name}:`, error)
        continue
      }
      if (!isGame(parsed)) {
        console.warn(`[games] skipping ${name}: not a game file`)
        continue
      }
      this.index.set(parsed.id, summaryOf(parsed))
    }
  }

  /** Archive rows, newest first. Reads nothing from disk. */
  list(filter?: GameFilter): GameSummary[] {
    const rows = [...this.index.values()].filter(
      (summary) => (!filter?.status || summary.status === filter.status) && (!filter?.kind || summary.kind === filter.kind)
    )
    return rows.sort(newestFirst)
  }

  async get(id: string): Promise<Game | null> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await fsp.readFile(this.file(id), 'utf8'))
    } catch {
      return null
    }
    if (!isGame(parsed)) {
      console.warn(`[games] ${id}.json is not a game file`)
      return null
    }
    return parsed
  }

  /** Creates, persists and indexes a new game in `in_progress` with an empty history. */
  async create(init: GameInit): Promise<Game> {
    const stamp = this.stamp()
    const game: Game = {
      ...init,
      id: randomUUID(),
      createdAt: stamp,
      updatedAt: stamp,
      status: 'in_progress',
      moves: [],
      takebacks: 0,
      coachLog: []
    }
    await writeJsonAtomic(this.file(game.id), game)
    this.index.set(game.id, summaryOf(game))
    return game
  }

  /** Stamps `updatedAt` on the caller's object (the session keeps using it) and writes it. */
  async save(game: Game): Promise<void> {
    game.updatedAt = this.stamp()
    await writeJsonAtomic(this.file(game.id), game)
    this.index.set(game.id, summaryOf(game))
  }

  async delete(id: string): Promise<void> {
    await fsp.rm(this.file(id), { force: true }).catch(() => undefined)
    this.index.delete(id)
  }
}
