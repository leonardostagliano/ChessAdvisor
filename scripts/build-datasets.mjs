#!/usr/bin/env node
// @ts-nocheck
/**
 * Build-time preparation of the datasets bundled in `resources/data` (spec §3.1, PuzzleLibrary).
 *
 *   node scripts/build-datasets.mjs openings            downloads a.tsv…e.tsv and rewrites openings.json
 *   node scripts/build-datasets.mjs openings --from DIR  uses the TSV files already in DIR (offline)
 *   node scripts/build-datasets.mjs openings --out FILE  writes somewhere else than resources/data
 *
 * `openings` is the only dataset of M3; `puzzles` and `endgames` land here in M5.
 *
 * Source: https://github.com/lichess-org/chess-openings (CC0 1.0, see
 * `resources/licenses/lichess-cc0.txt`). Each row is `eco \t name \t pgn`; the EPD — the first four
 * fields of the FEN, i.e. the key the app matches positions on — is computed here with chess.js so
 * the app never has to replay a PGN at runtime. The JSON is committed: a build must not need the
 * network.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Chess } from 'chess.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = join(ROOT, 'resources', 'data', 'openings.json')
const VOLUMES = ['a', 'b', 'c', 'd', 'e']
const BASE = 'https://raw.githubusercontent.com/lichess-org/chess-openings/master'
/** Above this size the `pgn` of every row is dropped: the app only ever matches on the EPD. */
const MAX_BYTES_WITH_PGN = 3_000_000

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
  const response = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'ChessAdvisor-build-datasets' } })
  if (response.status !== 200) throw new Error(`${url} answered HTTP ${response.status} ${response.statusText}`)
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
  if (entries.length === 0) throw new Error('no opening survived the EPD computation: the source format changed')

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

function parseArgs(argv) {
  const args = { command: argv[0] ?? '', from: null, out: DEFAULT_OUT }
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--from') args.from = argv[++i] ?? null
    else if (argv[i] === '--out') args.out = resolve(argv[++i] ?? DEFAULT_OUT)
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.command !== 'openings') {
    process.stderr.write('usage: node scripts/build-datasets.mjs openings [--from DIR] [--out FILE]\n')
    process.exitCode = 2
    return
  }
  await buildOpenings(args)
}

// Importable from tests without running the download.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`build-datasets failed: ${error?.stack ?? error}\n`)
    process.exitCode = 1
  })
}
