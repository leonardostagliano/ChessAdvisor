import { readFile } from 'node:fs/promises'
import type { EndgamePosition, Puzzle, Side } from '@shared/types/training'
import { THEMES, type Theme } from '../profile/themes'

/**
 * The bundled training datasets (spec §3.1, PuzzleLibrary).
 *
 * `resources/data/puzzles.json` and `resources/data/endgames.json` are produced at development
 * time by `scripts/build-datasets.mjs` and committed, so a build never needs the network and the
 * app works offline. Everything expensive — decompressing the lichess database, applying the
 * opponent premove of each record, translating the lichess theme vocabulary into our fixed
 * taxonomy, balancing the selection over rating buckets — happens in that script. What is left
 * here is a read of two JSON files, an index by theme and a deterministic draw.
 *
 * Nothing in this file is fatal: a missing or broken dataset leaves an empty library and the
 * training section shows its empty state instead of crashing the app.
 */

/**
 * Lichess puzzle themes → the fixed taxonomy of spec §6.2.
 *
 * The same table lives in `scripts/build-datasets.mjs` (a `.mjs` script cannot import this module)
 * and a test keeps the two copies equal. Lichess themes that say nothing about *what the player
 * had to see* — `crushing`, `advantage`, `equality`, `short`, `long`, `master`, `middlegame`… —
 * are deliberately absent: they map to nothing and are dropped.
 */
export const THEME_MAP: Record<string, Theme> = {
  // Tactical motifs with a direct counterpart in the taxonomy.
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  xRayAttack: 'skewer',
  hangingPiece: 'hanging_piece',
  trappedPiece: 'hanging_piece',
  backRankMate: 'back_rank',
  discoveredAttack: 'discovered_attack',
  doubleCheck: 'discovered_attack',
  // Motifs that all come down to a defender doing too much.
  deflection: 'overloaded_piece',
  attraction: 'overloaded_piece',
  capturingDefender: 'overloaded_piece',
  interference: 'overloaded_piece',
  // Attacks against the king, wherever they start from.
  exposedKing: 'king_safety',
  kingsideAttack: 'king_safety',
  queensideAttack: 'king_safety',
  attackingF2F7: 'king_safety',
  castling: 'king_safety',
  // Everything that is about pawns and promotion.
  advancedPawn: 'pawn_structure',
  promotion: 'pawn_structure',
  underPromotion: 'pawn_structure',
  enPassant: 'pawn_structure',
  // Phases.
  opening: 'opening_principles',
  endgame: 'endgame_technique',
  pawnEndgame: 'endgame_technique',
  rookEndgame: 'endgame_technique',
  queenEndgame: 'endgame_technique',
  bishopEndgame: 'endgame_technique',
  knightEndgame: 'endgame_technique',
  queenRookEndgame: 'endgame_technique',
  zugzwang: 'endgame_technique',
  // Moves whose point is the activity of a piece.
  sacrifice: 'piece_activity',
  clearance: 'piece_activity',
  // Moves that are missed because the calculation stopped too early.
  quietMove: 'calculation_error',
  intermezzo: 'calculation_error',
  defensiveMove: 'calculation_error',
  // Forced mates: the taxonomy has no "mate" key, they are the archetypal missed tactic.
  mate: 'missed_tactic',
  mateIn1: 'missed_tactic',
  mateIn2: 'missed_tactic',
  mateIn3: 'missed_tactic',
  mateIn4: 'missed_tactic',
  mateIn5: 'missed_tactic',
  smotheredMate: 'missed_tactic',
  anastasiaMate: 'missed_tactic',
  arabianMate: 'missed_tactic',
  bodenMate: 'missed_tactic',
  doubleBishopMate: 'missed_tactic',
  dovetailMate: 'missed_tactic',
  hookMate: 'missed_tactic'
}

export interface PickRequest {
  theme: string
  ratingMin: number
  ratingMax: number
  exclude: Set<string>
  count: number
  /** Fixes the draw: same seed, same puzzles. Left out in production, where variety is the point. */
  seed?: number
}

const THEME_ORDER = new Map<string, number>(THEMES.map((theme, index) => [theme, index]))
const KNOWN_THEME = new Set<string>(THEMES)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isSide = (value: unknown): value is Side => value === 'w' || value === 'b'

/** Deterministic, tiny PRNG (mulberry32): the draw must be reproducible from a seed in tests. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates on a copy, driven by `next` so the caller owns the determinism. */
function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1))
    const a = out[i] as T
    out[i] = out[j] as T
    out[j] = a
  }
  return out
}

/** One row of `puzzles.json`, or `null` when it cannot be trusted. */
function sanitizePuzzle(value: unknown): Puzzle | null {
  if (!isRecord(value)) return null
  const { id, fen, sideToMove, solution, rating, themes } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (typeof fen !== 'string' || fen.length === 0) return null
  if (!isSide(sideToMove)) return null
  if (
    !Array.isArray(solution) ||
    solution.length === 0 ||
    solution.some((m) => typeof m !== 'string' || m.length < 4)
  )
    return null
  if (typeof rating !== 'number' || !Number.isFinite(rating)) return null
  if (!Array.isArray(themes)) return null
  const known = themes.filter(
    (theme): theme is string => typeof theme === 'string' && KNOWN_THEME.has(theme)
  )
  if (known.length === 0) return null
  return {
    id,
    fen,
    sideToMove,
    solution: solution as string[],
    rating: Math.round(rating),
    themes: known,
    // Lichess is the only source today; a row claiming another one is still read as lichess.
    source: 'lichess'
  }
}

/** One row of `endgames.json`, or `null` when it cannot be trusted. */
function sanitizeEndgame(value: unknown): EndgamePosition | null {
  if (!isRecord(value)) return null
  const { id, name, fen, sideToMove, goal, difficulty, theme } = value
  if (typeof id !== 'string' || id.length === 0) return null
  if (!isRecord(name) || typeof name.it !== 'string' || typeof name.en !== 'string') return null
  if (typeof fen !== 'string' || fen.length === 0) return null
  if (!isSide(sideToMove)) return null
  if (goal !== 'win' && goal !== 'draw') return null
  if (difficulty !== 1 && difficulty !== 2 && difficulty !== 3) return null
  if (typeof theme !== 'string' || !KNOWN_THEME.has(theme)) return null
  return { id, name: { it: name.it, en: name.en }, fen, sideToMove, goal, difficulty, theme }
}

async function readJson(path: string, what: string): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    if (!Array.isArray(parsed)) {
      console.error(`[data] the ${what} dataset is not an array`)
      return []
    }
    return parsed
  } catch (error) {
    console.error(`[data] the ${what} dataset could not be read:`, error)
    return []
  }
}

export class PuzzleLibrary {
  private puzzles: Puzzle[] = []
  private byId = new Map<string, Puzzle>()
  private byTheme = new Map<string, Puzzle[]>()
  private endgameList: EndgamePosition[] = []

  /**
   * `resourcePath` is `paths.ts`'s resolver, so the same library works from the repo in
   * development and from `process.resourcesPath` in the packaged app.
   */
  constructor(private readonly resourcePath: (...segs: string[]) => string) {}

  /** Reads both datasets. Calling it twice simply rebuilds the indexes. */
  async load(): Promise<void> {
    const puzzles: Puzzle[] = []
    const byId = new Map<string, Puzzle>()
    const byTheme = new Map<string, Puzzle[]>()

    for (const row of await readJson(this.resourcePath('data', 'puzzles.json'), 'puzzles')) {
      const puzzle = sanitizePuzzle(row)
      if (!puzzle || byId.has(puzzle.id)) continue
      puzzles.push(puzzle)
      byId.set(puzzle.id, puzzle)
      for (const theme of puzzle.themes) {
        const bucket = byTheme.get(theme)
        if (bucket) bucket.push(puzzle)
        else byTheme.set(theme, [puzzle])
      }
    }
    // Cheapest way to keep every answer ordered from the easiest puzzle up.
    for (const bucket of byTheme.values())
      bucket.sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id))

    const endgames: EndgamePosition[] = []
    const seen = new Set<string>()
    for (const row of await readJson(this.resourcePath('data', 'endgames.json'), 'endgames')) {
      const endgame = sanitizeEndgame(row)
      if (!endgame || seen.has(endgame.id)) continue
      seen.add(endgame.id)
      endgames.push(endgame)
    }

    this.puzzles = puzzles
    this.byId = byId
    this.byTheme = byTheme
    this.endgameList = endgames
  }

  /** How many puzzles the library holds. */
  get size(): number {
    return this.puzzles.length
  }

  get(id: string): Puzzle | null {
    return this.byId.get(id) ?? null
  }

  /**
   * `count` puzzles of `theme` inside the rating window, none of them in `exclude` (spec §6.5).
   *
   * The window is never widened: answering fewer puzzles is honest, answering easier or harder
   * ones than the coach asked for is not. The draw is random so two sets of the same theme differ,
   * and reproducible when a `seed` is given; the answer is then sorted by rating so a set starts
   * with its easiest puzzle.
   */
  pick(p: PickRequest): Puzzle[] {
    const count = Math.max(0, Math.floor(p.count))
    if (count === 0) return []
    const candidates = (this.byTheme.get(p.theme) ?? []).filter(
      (puzzle) =>
        puzzle.rating >= p.ratingMin && puzzle.rating <= p.ratingMax && !p.exclude.has(puzzle.id)
    )
    if (candidates.length === 0) return []
    const next = random(p.seed ?? Math.floor(Math.random() * 0xffffffff))
    return shuffled(candidates, next)
      .slice(0, count)
      .sort((a, b) => a.rating - b.rating || a.id.localeCompare(b.id))
  }

  /** Every theme with at least one puzzle, most represented first (ties in taxonomy order). */
  themes(): { theme: string; count: number }[] {
    return [...this.byTheme.entries()]
      .map(([theme, bucket]) => ({ theme, count: bucket.length }))
      .sort(
        (a, b) =>
          b.count - a.count || (THEME_ORDER.get(a.theme) ?? 99) - (THEME_ORDER.get(b.theme) ?? 99)
      )
  }

  /** The curated endgames, in dataset order (easiest families first). */
  endgames(): EndgamePosition[] {
    return [...this.endgameList]
  }
}
