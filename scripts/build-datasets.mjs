// @ts-nocheck
// No shebang on purpose: the script is always run through node (`npm run build:datasets`), and a
// shebang in a CRLF working copy — what git hands out on Windows — makes Vitest fail to import
// this module in `build-datasets.test.mjs`.
/**
 * Build-time preparation of the datasets bundled in `resources/data` (spec §3.1, PuzzleLibrary).
 *
 *   node scripts/build-datasets.mjs openings            downloads a.tsv…e.tsv and rewrites openings.json
 *   node scripts/build-datasets.mjs openings --from DIR  uses the TSV files already in DIR (offline)
 *   node scripts/build-datasets.mjs puzzles             downloads the lichess puzzle DB and rewrites puzzles.json
 *   node scripts/build-datasets.mjs puzzles --from FILE  uses an already downloaded .csv.zst (or .csv)
 *   node scripts/build-datasets.mjs endgames            writes the curated endgames.json (no network)
 *   node scripts/build-datasets.mjs all                  all three
 *   ... --out FILE                                       writes somewhere else than resources/data
 *
 * Sources (both CC0 1.0, see `resources/licenses/lichess-cc0.txt`):
 * - openings: https://github.com/lichess-org/chess-openings — rows `eco \t name \t pgn`; the EPD
 *   (first four FEN fields, the key the app matches positions on) is computed here with chess.js
 *   so the app never replays a PGN at runtime.
 * - puzzles: https://database.lichess.org/lichess_db_puzzle.csv.zst — ~300 MB compressed, several
 *   million rows. It is decompressed **while streaming** with `fzstd` (a pure-JS zstd decoder added
 *   as a devDependency: no `zstd` binary is assumed on a Windows machine) and filtered row by row,
 *   so the build never holds the whole database in memory. The raw download is cached under
 *   `resources/data/.download/` (gitignored) so a re-run costs nothing.
 *
 * The endgames are not downloaded at all: they are the hand-written table below, validated with
 * chess.js before being written.
 *
 * Every JSON under `resources/data` is committed: a build, and the app, must never need the network.
 */

import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { Chess } from 'chess.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = join(ROOT, 'resources', 'data')
const DOWNLOAD_DIR = join(DATA_DIR, '.download')
const DEFAULT_OUT = {
  openings: join(DATA_DIR, 'openings.json'),
  puzzles: join(DATA_DIR, 'puzzles.json'),
  endgames: join(DATA_DIR, 'endgames.json')
}
const VOLUMES = ['a', 'b', 'c', 'd', 'e']
const BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master'
const PUZZLE_URL = 'https://database.lichess.org/lichess_db_puzzle.csv.zst'
/** Above this size the `pgn` of every row is dropped: the app only ever matches on the EPD. */
const MAX_BYTES_WITH_PGN = 3_000_000

// ---------------------------------------------------------------------------------------------
// Openings
// ---------------------------------------------------------------------------------------------

/** One TSV file into `{eco, name, pgn}` rows; the header line and blank lines are skipped. */
export function parseTsv(text) {
  const rows = []
  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    if (line.trim().length === 0) continue
    const [eco, name, pgn] = line.split('\t')
    // The first line of every volume is the header (`eco  name  pgn`).
    if (index === 0 && eco === 'eco') continue
    if (!eco || !name || !pgn) continue
    rows.push({ eco: eco.trim(), name: name.trim(), pgn: pgn.trim() })
  }
  return rows
}

/**
 * Plays the movetext and returns the EPD of the position it reaches, or `null` when chess.js
 * refuses the line (never seen on this dataset, but a bad row must not kill the build).
 */
export function epdOfPgn(pgn) {
  const chess = new Chess()
  try {
    chess.loadPgn(pgn)
  } catch {
    return null
  }
  return chess.fen().split(/\s+/).slice(0, 4).join(' ')
}

/** Rows with their EPD, deduplicated by EPD keeping the first (shortest name) occurrence. */
export function withEpd(rows) {
  const seen = new Set()
  const out = []
  let skipped = 0
  for (const row of rows) {
    const epd = epdOfPgn(row.pgn)
    if (!epd) {
      skipped += 1
      continue
    }
    if (seen.has(epd)) continue
    seen.add(epd)
    out.push({ eco: row.eco, name: row.name, pgn: row.pgn, epd })
  }
  return { entries: out, skipped }
}

async function readVolume(volume, from) {
  if (from) return readFile(join(resolve(from), `${volume}.tsv`), 'utf8')
  const url = `${BASE}/${volume}.tsv`
  process.stdout.write(`  downloading ${url}\n`)
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'ChessAdvisor-build-datasets' }
  })
  if (response.status !== 200)
    throw new Error(`${url} answered HTTP ${response.status} ${response.statusText}`)
  return response.text()
}

async function buildOpenings({ from, out }) {
  const rows = []
  for (const volume of VOLUMES) {
    const parsed = parseTsv(await readVolume(volume, from))
    process.stdout.write(`  ${volume}.tsv: ${parsed.length} rows\n`)
    rows.push(...parsed)
  }
  const { entries, skipped } = withEpd(rows)
  if (entries.length === 0)
    throw new Error('no opening survived the EPD computation: the source format changed')

  let payload = JSON.stringify(entries)
  let withPgn = true
  if (payload.length > MAX_BYTES_WITH_PGN) {
    withPgn = false
    payload = JSON.stringify(entries.map(({ eco, name, epd }) => ({ eco, name, epd })))
  }
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${payload}\n`, 'utf8')
  process.stdout.write(
    `openings: ${entries.length} positions${skipped > 0 ? ` (${skipped} unplayable rows skipped)` : ''}, ` +
      `${(payload.length / 1024).toFixed(0)} KB${withPgn ? '' : ' (pgn dropped: over the size budget)'} → ${out}\n`
  )
}

// ---------------------------------------------------------------------------------------------
// Puzzles
// ---------------------------------------------------------------------------------------------

/**
 * Lichess puzzle themes → the fixed taxonomy of spec §6.2.
 *
 * MUST stay equal to `THEME_MAP` of `src/main/data/puzzleLibrary.ts` (a `.mjs` script cannot
 * import a TypeScript module); `scripts/build-datasets.test.mjs` compares the two tables. Lichess
 * themes that describe the *evaluation* rather than the motif — `crushing`, `advantage`,
 * `equality`, `short`, `long`, `master`, `middlegame`… — map to nothing and are dropped.
 */
export const PUZZLE_THEME_MAP = {
  fork: 'fork',
  pin: 'pin',
  skewer: 'skewer',
  xRayAttack: 'skewer',
  hangingPiece: 'hanging_piece',
  trappedPiece: 'hanging_piece',
  backRankMate: 'back_rank',
  discoveredAttack: 'discovered_attack',
  doubleCheck: 'discovered_attack',
  deflection: 'overloaded_piece',
  attraction: 'overloaded_piece',
  capturingDefender: 'overloaded_piece',
  interference: 'overloaded_piece',
  exposedKing: 'king_safety',
  kingsideAttack: 'king_safety',
  queensideAttack: 'king_safety',
  attackingF2F7: 'king_safety',
  castling: 'king_safety',
  advancedPawn: 'pawn_structure',
  promotion: 'pawn_structure',
  underPromotion: 'pawn_structure',
  enPassant: 'pawn_structure',
  opening: 'opening_principles',
  endgame: 'endgame_technique',
  pawnEndgame: 'endgame_technique',
  rookEndgame: 'endgame_technique',
  queenEndgame: 'endgame_technique',
  bishopEndgame: 'endgame_technique',
  knightEndgame: 'endgame_technique',
  queenRookEndgame: 'endgame_technique',
  zugzwang: 'endgame_technique',
  sacrifice: 'piece_activity',
  clearance: 'piece_activity',
  quietMove: 'calculation_error',
  intermezzo: 'calculation_error',
  defensiveMove: 'calculation_error',
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

/** The fixed taxonomy, in the order of spec §6.2: it also orders a puzzle's themes. */
export const TAXONOMY = [
  'fork',
  'pin',
  'skewer',
  'hanging_piece',
  'back_rank',
  'discovered_attack',
  'overloaded_piece',
  'king_safety',
  'pawn_structure',
  'opening_principles',
  'development',
  'center_control',
  'endgame_technique',
  'piece_activity',
  'trade_evaluation',
  'time_pressure',
  'calculation_error',
  'missed_tactic'
]

/** Selection rules of the plan: a puzzle nobody solved or nobody liked teaches nothing. */
export const PUZZLE_FILTERS = { ratingMin: 400, ratingMax: 2200, popularityMin: 80, playsMin: 200 }
/** How many puzzles the bundled subset aims at (~1.5 MB of JSON). */
export const PUZZLE_TARGET = 8000
/** Rows kept in memory per (rating bucket, theme) cell while streaming the database. */
const CELL_CAP = 160

/**
 * One CSV line of `lichess_db_puzzle.csv` into the fields the app needs.
 *
 * Columns: `PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags`.
 * No field is quoted in this database — themes and opening tags are space-separated — so a plain
 * split is enough. The header, blank lines and anything that does not parse answer `null`.
 */
export function parsePuzzleRow(line) {
  if (typeof line !== 'string' || line.length === 0) return null
  const fields = line.split(',')
  if (fields.length < 8) return null
  const [id, fen, moves, rating, , popularity, nbPlays, themes] = fields
  if (!id || !fen || !moves || id === 'PuzzleId') return null
  const numbers = [Number(rating), Number(popularity), Number(nbPlays)]
  if (numbers.some((n) => !Number.isFinite(n))) return null
  return {
    id,
    fen,
    moves: moves.trim().split(/\s+/).filter(Boolean),
    rating: numbers[0],
    popularity: numbers[1],
    nbPlays: numbers[2],
    themes: String(themes ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
  }
}

/** The lichess themes of a row translated into the taxonomy, deduplicated, in taxonomy order. */
export function mapPuzzleThemes(themes) {
  const mapped = new Set()
  for (const theme of themes ?? []) {
    const app = PUZZLE_THEME_MAP[theme]
    if (app) mapped.add(app)
  }
  return TAXONOMY.filter((theme) => mapped.has(theme))
}

/** The theme a puzzle is filed under when balancing the selection: the first one of the taxonomy. */
export function primaryTheme(themes) {
  return TAXONOMY.find((theme) => (themes ?? []).includes(theme)) ?? 'missed_tactic'
}

/** Rating window, popularity, plays, a usable solution and at least one theme we can name. */
export function eligiblePuzzle(row) {
  if (!row) return false
  if (row.rating < PUZZLE_FILTERS.ratingMin || row.rating > PUZZLE_FILTERS.ratingMax) return false
  if (row.popularity < PUZZLE_FILTERS.popularityMin) return false
  if (row.nbPlays < PUZZLE_FILTERS.playsMin) return false
  // moves[0] is the opponent premove, so a real puzzle has at least one more move after it.
  if (!Array.isArray(row.moves) || row.moves.length < 2) return false
  return mapPuzzleThemes(row.themes).length > 0
}

/** 100-point bucket a rating falls in; the selection is balanced over these. */
export function ratingBucket(rating) {
  return Math.floor(rating / 100) * 100
}

/**
 * A parsed row into the record the app ships: the opponent premove (`moves[0]`) is applied here,
 * so at runtime the library hands out a position the user can play straight away (spec §3.1).
 * `null` when chess.js refuses the FEN or the premove — a handful of rows in any large dump.
 */
export function toPuzzle(row) {
  if (!row || !Array.isArray(row.moves) || row.moves.length < 2) return null
  let board
  try {
    board = new Chess(row.fen)
  } catch {
    return null
  }
  const premove = row.moves[0]
  const from = premove.slice(0, 2)
  const to = premove.slice(2, 4)
  const promotion = premove.slice(4, 5) || undefined
  try {
    board.move(promotion ? { from, to, promotion } : { from, to })
  } catch {
    return null
  }
  return {
    id: row.id,
    fen: board.fen(),
    sideToMove: board.turn(),
    solution: row.moves.slice(1),
    rating: row.rating,
    themes: mapPuzzleThemes(row.themes),
    source: 'lichess'
  }
}

/**
 * Balances the pool over (rating bucket, primary theme) cells and takes `target` puzzles.
 *
 * Taking the first N rows of the database would ship a lump of 1500-rated forks; a training set
 * has to cover the whole window and the whole taxonomy. Cells are visited round-robin in a fixed
 * order, so the answer only depends on the pool — no randomness in a committed dataset.
 */
export function selectPuzzles(pool, target = PUZZLE_TARGET) {
  const cells = new Map()
  for (const puzzle of pool) {
    const key = `${ratingBucket(puzzle.rating)}|${primaryTheme(puzzle.themes)}`
    const cell = cells.get(key)
    if (cell) cell.push(puzzle)
    else cells.set(key, [puzzle])
  }
  const keys = [...cells.keys()].sort()
  const out = []
  let round = 0
  let served = true
  while (out.length < target && served) {
    served = false
    for (const key of keys) {
      if (out.length >= target) break
      const cell = cells.get(key)
      if (round >= cell.length) continue
      out.push(cell[round])
      served = true
    }
    round += 1
  }
  return out
}

/** Downloads `url` to `file` unless it is already there; answers the path. */
async function cachedDownload(url, file) {
  try {
    const info = await stat(file)
    if (info.isFile() && info.size > 0) {
      process.stdout.write(
        `  using the cached download ${file} (${(info.size / 1024 / 1024).toFixed(0)} MB)\n`
      )
      return file
    }
  } catch {
    // Not downloaded yet.
  }
  process.stdout.write(`  downloading ${url}\n`)
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'ChessAdvisor-build-datasets' }
  })
  if (response.status !== 200)
    throw new Error(`${url} answered HTTP ${response.status} ${response.statusText}`)
  await mkdir(dirname(file), { recursive: true })
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file))
  return file
}

/**
 * Streams the (optionally zstd-compressed) CSV and calls `onRow` with every parsed line.
 * Decompression happens chunk by chunk: the 300 MB database never lands in memory as a whole.
 */
async function streamCsv(file, onRow) {
  const utf8 = new TextDecoder()
  let rest = ''
  const feed = (bytes) => {
    const text = utf8.decode(bytes, { stream: true })
    const lines = (rest + text).split('\n')
    rest = lines.pop() ?? ''
    for (const line of lines) onRow(line.endsWith('\r') ? line.slice(0, -1) : line)
  }

  let decoder = null
  if (file.endsWith('.zst')) {
    const { Decompress } = await import('fzstd')
    decoder = new Decompress((chunk) => feed(chunk))
  }

  for await (const chunk of createReadStream(file, { highWaterMark: 1 << 20 })) {
    if (decoder) decoder.push(chunk)
    else feed(chunk)
  }
  if (decoder) decoder.push(new Uint8Array(0), true)
  if (rest.length > 0) onRow(rest)
}

async function buildPuzzles({ from, out }) {
  const file = from
    ? resolve(from)
    : await cachedDownload(PUZZLE_URL, join(DOWNLOAD_DIR, 'lichess_db_puzzle.csv.zst'))

  // Bounded reservoir: at most CELL_CAP candidates per (bucket, theme) cell survive the stream,
  // which caps the memory at a few tens of thousands of rows whatever the size of the database.
  const cells = new Map()
  let read = 0
  let eligible = 0
  let unplayable = 0
  await streamCsv(file, (line) => {
    read += 1
    if (read % 500_000 === 0)
      process.stdout.write(
        `  ${read.toLocaleString('en-US')} rows read, ${eligible} eligible so far\n`
      )
    const row = parsePuzzleRow(line)
    if (!row || !eligiblePuzzle(row)) return
    eligible += 1
    const themes = mapPuzzleThemes(row.themes)
    const key = `${ratingBucket(row.rating)}|${primaryTheme(themes)}`
    const cell = cells.get(key)
    if (cell && cell.length >= CELL_CAP) return
    const puzzle = toPuzzle(row)
    if (!puzzle) {
      unplayable += 1
      return
    }
    if (cell) cell.push(puzzle)
    else cells.set(key, [puzzle])
  })

  const pool = [...cells.values()].flat()
  const selected = selectPuzzles(pool, PUZZLE_TARGET)
  if (selected.length === 0)
    throw new Error('no puzzle survived the filters: the database format changed')

  const payload = JSON.stringify(selected)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${payload}\n`, 'utf8')

  const buckets = new Set(selected.map((p) => ratingBucket(p.rating)))
  const themes = new Set(selected.flatMap((p) => p.themes))
  process.stdout.write(
    `puzzles: ${selected.length} of ${eligible} eligible rows (${read.toLocaleString('en-US')} read` +
      `${unplayable > 0 ? `, ${unplayable} unplayable` : ''}), ${buckets.size} rating buckets, ${themes.size} themes, ` +
      `${(payload.length / 1024).toFixed(0)} KB → ${out}\n`
  )
}

// ---------------------------------------------------------------------------------------------
// Endgames
// ---------------------------------------------------------------------------------------------

/**
 * The curated endgames of spec §6.7, written by hand: twenty positions every club player should
 * know, from the basic mates to Lucena, Philidor and Vancura. `goal` is what the side to move is
 * playing for, so a `draw` position is a defensive drill. Each one is validated below before the
 * dataset is written.
 *
 * `validateEndgames` only proves a position is legal and playable: whether the declared `goal` is
 * actually reachable is a theoretical claim no test can check offline, so every entry here has been
 * verified against the bundled Stockfish (`resources/engine/stockfish-avx2.exe`, depth 30+) — a
 * `win` scores decisively for the side to move, a `draw` scores about zero. Re-run that check by
 * hand whenever a position is added or edited: a wrong `goal` is a drill the user cannot pass.
 */
export const ENDGAMES = [
  {
    id: 'queen_mate',
    name: { it: 'Matto con la donna', en: 'Queen mate' },
    fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 1,
    theme: 'endgame_technique'
  },
  {
    id: 'rook_mate',
    name: { it: 'Matto con la torre', en: 'Rook mate' },
    fen: '8/8/8/4k3/8/8/8/3RK3 w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 1,
    theme: 'endgame_technique'
  },
  {
    id: 'two_bishops_mate',
    name: { it: 'Matto con i due alfieri', en: 'Two bishops mate' },
    fen: '8/8/8/4k3/8/8/8/2BBK3 w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 2,
    theme: 'endgame_technique'
  },
  {
    id: 'bishop_knight_mate',
    name: { it: 'Matto con alfiere e cavallo', en: 'Bishop and knight mate' },
    fen: '8/8/8/4k3/8/4K3/8/3BN3 w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 3,
    theme: 'endgame_technique'
  },
  {
    id: 'kp_king_in_front',
    name: { it: 'Re e pedone: re davanti al pedone', en: 'King and pawn: king in front' },
    fen: '4k3/8/4K3/4P3/8/8/8/8 w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 1,
    theme: 'endgame_technique'
  },
  {
    id: 'kp_key_squares',
    name: { it: 'Re e pedone: case chiave', en: 'King and pawn: key squares' },
    fen: '8/8/8/3K4/8/8/3P4/3k4 w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 2,
    theme: 'endgame_technique'
  },
  {
    id: 'kp_distant_opposition',
    name: { it: 'Opposizione a distanza', en: 'Distant opposition' },
    // Black draws with the single move 1...Kd5, taking the opposition; every other king move
    // loses (Stockfish 17.1 at depth 34: mate for White after Kc5/Kc6/Kc7/Kd7/Ke5/Ke6/Ke7).
    // With the black king on d5 instead the defence is already lost, so the square matters.
    fen: '8/8/3k4/8/8/3K4/3P4/8 b - - 0 1',
    sideToMove: 'b',
    goal: 'draw',
    difficulty: 3,
    theme: 'endgame_technique'
  },
  {
    id: 'kp_rook_pawn_corner',
    name: { it: 'Pedone di torre: patta nell’angolo', en: 'Rook pawn: draw in the corner' },
    fen: '7k/8/7K/7P/8/8/8/8 b - - 0 1',
    sideToMove: 'b',
    goal: 'draw',
    difficulty: 2,
    theme: 'endgame_technique'
  },
  {
    id: 'king_in_the_square',
    name: { it: 'La regola del quadrato', en: 'The square of the pawn' },
    fen: '8/8/8/4k3/P7/8/8/6K1 b - - 0 1',
    sideToMove: 'b',
    goal: 'draw',
    difficulty: 1,
    theme: 'endgame_technique'
  },
  {
    id: 'pawn_breakthrough',
    name: { it: 'La rottura dei tre pedoni', en: 'Three pawns breakthrough' },
    fen: '7k/ppp5/8/PPP5/8/8/8/7K w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 2,
    theme: 'pawn_structure'
  },
  {
    id: 'outside_passed_pawn',
    name: { it: 'Il pedone passato esterno', en: 'The outside passed pawn' },
    fen: '8/8/8/2k1p3/P3P3/2K5/8/8 w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 2,
    theme: 'pawn_structure'
  },
  {
    id: 'lucena',
    name: { it: 'Posizione di Lucena', en: 'Lucena position' },
    fen: '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 3,
    theme: 'endgame_technique'
  },
  {
    id: 'philidor',
    name: { it: 'Posizione di Philidor', en: 'Philidor position' },
    fen: '8/4k3/r7/4K3/4P3/8/8/7R b - - 0 1',
    sideToMove: 'b',
    goal: 'draw',
    difficulty: 3,
    theme: 'endgame_technique'
  },
  {
    id: 'vancura',
    name: { it: 'Posizione di Vancura', en: 'Vancura position' },
    fen: 'R7/6k1/P4r2/8/8/8/8/6K1 b - - 0 1',
    sideToMove: 'b',
    goal: 'draw',
    difficulty: 3,
    theme: 'endgame_technique'
  },
  {
    id: 'rook_behind_passer',
    name: { it: 'Torre dietro al pedone passato', en: 'Rook behind the passed pawn' },
    fen: 'r7/8/8/P6k/4K3/8/8/R7 w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 2,
    theme: 'endgame_technique'
  },
  {
    id: 'rook_vs_bishop',
    name: { it: 'Torre contro alfiere', en: 'Rook versus bishop' },
    fen: '5k2/5b2/8/8/8/8/3R4/5K2 b - - 0 1',
    sideToMove: 'b',
    goal: 'draw',
    difficulty: 2,
    theme: 'endgame_technique'
  },
  {
    id: 'queen_vs_center_pawn',
    name: { it: 'Donna contro pedone centrale', en: 'Queen versus central pawn' },
    fen: '8/8/7K/Q7/8/8/3p4/3k4 w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 3,
    theme: 'endgame_technique'
  },
  {
    id: 'queen_vs_rook_pawn',
    name: { it: 'Donna contro pedone di torre', en: 'Queen versus rook pawn' },
    fen: '8/8/5K2/4Q3/8/8/p7/1k6 b - - 0 1',
    sideToMove: 'b',
    goal: 'draw',
    difficulty: 3,
    theme: 'endgame_technique'
  },
  {
    id: 'queen_vs_rook',
    name: { it: 'Donna contro torre', en: 'Queen versus rook' },
    fen: '6k1/5r2/8/8/4Q3/8/8/6K1 w - - 0 1',
    sideToMove: 'w',
    goal: 'win',
    difficulty: 3,
    theme: 'endgame_technique'
  },
  {
    id: 'wrong_bishop',
    name: { it: 'Alfiere di colore sbagliato', en: 'Wrong-coloured bishop' },
    fen: '7k/5K2/7P/3B4/8/8/8/8 b - - 0 1',
    sideToMove: 'b',
    goal: 'draw',
    difficulty: 3,
    theme: 'endgame_technique'
  }
]

/**
 * Refuses to write a position chess.js cannot play, one whose side to move does not match the FEN,
 * or one already over: a broken drill would only show up as a blank board months later.
 */
export function validateEndgames(list) {
  const seen = new Set()
  for (const endgame of list) {
    if (seen.has(endgame.id)) throw new Error(`duplicate endgame id ${endgame.id}`)
    seen.add(endgame.id)
    let board
    try {
      board = new Chess(endgame.fen)
    } catch (error) {
      throw new Error(`endgame ${endgame.id}: illegal fen (${error?.message ?? error})`)
    }
    if (board.turn() !== endgame.sideToMove)
      throw new Error(`endgame ${endgame.id}: side to move differs from the fen`)
    if (board.moves().length === 0)
      throw new Error(`endgame ${endgame.id}: the position is already over`)
    if (!TAXONOMY.includes(endgame.theme))
      throw new Error(`endgame ${endgame.id}: theme ${endgame.theme} is outside the taxonomy`)
  }
  return list
}

async function buildEndgames({ out }) {
  const payload = JSON.stringify(validateEndgames(ENDGAMES), null, 2)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, `${payload}\n`, 'utf8')
  process.stdout.write(
    `endgames: ${ENDGAMES.length} curated positions, ${(payload.length / 1024).toFixed(0)} KB → ${out}\n`
  )
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const COMMANDS = ['openings', 'puzzles', 'endgames', 'all']

function parseArgs(argv) {
  const args = { command: argv[0] ?? '', from: null, out: null }
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--from') args.from = argv[++i] ?? null
    else if (argv[i] === '--out') args.out = resolve(argv[++i] ?? '')
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!COMMANDS.includes(args.command)) {
    process.stderr.write(
      `usage: node scripts/build-datasets.mjs <${COMMANDS.join('|')}> [--from DIR|FILE] [--out FILE]\n`
    )
    process.exitCode = 2
    return
  }
  const targets = args.command === 'all' ? ['openings', 'puzzles', 'endgames'] : [args.command]
  for (const target of targets) {
    const out = args.out && targets.length === 1 ? args.out : DEFAULT_OUT[target]
    if (target === 'openings') await buildOpenings({ from: args.from, out })
    else if (target === 'puzzles') await buildPuzzles({ from: args.from, out })
    else await buildEndgames({ out })
  }
}

// Importable from tests without running the download.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`build-datasets failed: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}
