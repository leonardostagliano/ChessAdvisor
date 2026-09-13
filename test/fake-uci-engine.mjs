#!/usr/bin/env node
// @ts-nocheck
/**
 * Minimal, deterministic UCI responder used instead of Stockfish in the tests.
 *
 *   node test/fake-uci-engine.mjs
 *   uci / isready / position fen <fen> / go depth 18 / stop / quit
 *
 * Behaviour:
 *   - `uci`      → `id name FakeFish 1.0`, `id author ChessAdvisor`, `uciok`
 *   - `isready`  → `readyok`
 *   - `go`       → MultiPV info lines at depth 8 then at the requested depth, then `bestmove`
 *   - a FEN containing `8/8/8/8/8/8/8/K6k` scores `mate 3` instead of centipawns
 *   - `go depth >= 18` waits 200 ms before `bestmove` so `stop` can be exercised
 *   - `stop`     → answers `bestmove` immediately for the search in flight
 *
 * Failure switches, as an environment variable or as an argv flag (the EngineService test hook
 * only passes argv, so both spellings exist):
 *   FAKE_UCI_NO_UCIOK=1 / --no-uciok  answers everything but never `uciok`
 *   FAKE_UCI_EXIT=1     / --exit      exits with code 1 right away (a binary the CPU refuses)
 *   FAKE_UCI_NO_NAME=1  / --no-name   answers `uciok` without `id name` (version stays unknown)
 *   FAKE_UCI_HANG_GO=1  / --hang-go   searches for ever: no `bestmove`, and `stop` is ignored
 */

const flag = (name, env) => process.argv.includes(name) || process.env[env] === '1'

if (flag('--exit', 'FAKE_UCI_EXIT')) process.exit(1)

const NO_UCIOK = flag('--no-uciok', 'FAKE_UCI_NO_UCIOK')
const NO_NAME = flag('--no-name', 'FAKE_UCI_NO_NAME')
const HANG_GO = flag('--hang-go', 'FAKE_UCI_HANG_GO')
const MATE_FEN_FRAGMENT = '8/8/8/8/8/8/8/K6k'

/** Fixed candidates so every assertion in the tests is deterministic. */
const CANDIDATES = [
  { pv: ['e2e4', 'e7e5', 'g1f3'], cp: 35 },
  { pv: ['d2d4', 'd7d5', 'c2c4'], cp: 20 },
  { pv: ['g1f3', 'g8f6', 'c2c4'], cp: 10 }
]

let multipv = 1
let fen = 'startpos'
let search = null

const send = (line) => process.stdout.write(`${line}\n`)

function infoLines(depth) {
  const mate = fen.includes(MATE_FEN_FRAGMENT)
  const lines = []
  for (let i = 0; i < Math.min(multipv, CANDIDATES.length); i += 1) {
    const candidate = CANDIDATES[i]
    const score = mate ? `mate ${3 + i}` : `cp ${candidate.cp}`
    lines.push(
      `info depth ${depth} seldepth ${depth + 4} multipv ${i + 1} score ${score} nodes 1000 nps 50000 time 10 pv ${candidate.pv.join(' ')}`
    )
  }
  return lines
}

function finish() {
  if (!search || HANG_GO) return
  const { timer } = search
  if (timer) clearTimeout(timer)
  search = null
  send('bestmove e2e4 ponder e7e5')
}

function go(args) {
  const depthIndex = args.indexOf('depth')
  const depth = depthIndex >= 0 ? Number.parseInt(args[depthIndex + 1] ?? '12', 10) : 12
  // Search progress the parser must ignore, then a shallow pass, then the final depth.
  send(`info depth 1 currmove e2e4 currmovenumber 1`)
  send('info string fake engine')
  for (const line of infoLines(Math.max(1, Math.min(8, depth)))) send(line)
  for (const line of infoLines(depth)) send(line)
  // A deep search stays open long enough for `stop` to arrive from the queue.
  const delay = depth >= 18 ? 200 : 0
  search = { timer: null }
  if (delay === 0) {
    finish()
    return
  }
  search.timer = setTimeout(finish, delay)
}

function handle(line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return
  switch (tokens[0]) {
    case 'uci':
      if (!NO_NAME) send('id name FakeFish 1.0')
      send('id author ChessAdvisor')
      if (!NO_UCIOK) send('uciok')
      return
    case 'isready':
      send('readyok')
      return
    case 'setoption': {
      const nameIndex = tokens.indexOf('name')
      const valueIndex = tokens.indexOf('value')
      if (nameIndex >= 0 && valueIndex > nameIndex) {
        const name = tokens.slice(nameIndex + 1, valueIndex).join(' ')
        if (name === 'MultiPV')
          multipv = Math.max(1, Number.parseInt(tokens[valueIndex + 1] ?? '1', 10))
      }
      return
    }
    case 'ucinewgame':
      return
    case 'position':
      fen = tokens.slice(1).join(' ')
      return
    case 'go':
      go(tokens.slice(1))
      return
    case 'stop':
      finish()
      return
    case 'quit':
      process.exit(0)
      return
    default:
      return
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const nl = buffer.indexOf('\n')
    if (nl === -1) break
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    handle(line)
  }
})
process.stdin.on('end', () => process.exit(0))
