// Offline pilot: node --experimental-strip-types scripts/analyze-rapid-games.mjs --input games.jsonl
// Node 22.14 needs the flag to import the shared TypeScript feature module.
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Chess } from 'chess.js'
import { phaseOf, positionContext } from '../src/shared/chess/rapidFeatures.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOWNLOAD = join(ROOT, 'resources', 'data', '.download', 'rapid')
export const ELO_ANCHORS = [600, 900, 1200, 1500, 1800, 2100, 2400]
export const PHASES = ['opening', 'middlegame', 'endgame']
export const LOSS_BOUNDS = [20, 60, 150, 300, 600, 1200]
const QUANTILES = [0, 0.5, 0.75, 0.9, 0.95, 0.99, 1]
const PER_PLAYER_GAME_CAP = 100
const MIN_PLIES = 20
const MAX_PROFILE_ROOT_CP = 600

function sha(value) {
  return createHash('sha256').update(value).digest('hex')
}
function integer(value, name, min, max) {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`${name} must be ${min}..${max}`)
  return n
}
export function parseArgs(argv) {
  const options = {
    input: join(DOWNLOAD, 'games.jsonl'),
    out: join(ROOT, 'resources', 'data', 'rapid-calibration.json'),
    observations: join(DOWNLOAD, 'observations.jsonl'),
    nodes: 20_000,
    positionsPerCell: 60,
    seed: 'chessadvisor-rapid-v1',
    workers: 2,
    maxGames: 25_000,
    engine: null
  }
  const names = new Map([
    ['--input', 'input'],
    ['--out', 'out'],
    ['--observations', 'observations'],
    ['--nodes', 'nodes'],
    ['--positions-per-cell', 'positionsPerCell'],
    ['--seed', 'seed'],
    ['--workers', 'workers'],
    ['--max-games', 'maxGames'],
    ['--engine', 'engine']
  ])
  for (let i = 0; i < argv.length; i++) {
    const key = names.get(argv[i])
    if (!key) throw new Error(`Unknown option: ${argv[i]}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`)
    options[key] = value
  }
  options.nodes = integer(options.nodes, '--nodes', 100, 10_000_000)
  options.positionsPerCell = integer(options.positionsPerCell, '--positions-per-cell', 1, 10_000)
  options.workers = integer(options.workers, '--workers', 1, 4)
  options.maxGames = integer(options.maxGames, '--max-games', 1, 1_000_000)
  if (!String(options.seed).trim()) throw new Error('--seed cannot be empty')
  for (const key of ['input', 'out', 'observations']) options[key] = resolve(options[key])
  if (
    options.input === options.out ||
    options.input === options.observations ||
    options.out === options.observations
  ) {
    throw new Error('--input, --out and --observations must be distinct paths')
  }
  if (options.engine) options.engine = resolve(options.engine)
  return options
}

export function playerSplit(username, seed) {
  if (typeof username !== 'string' || !username.trim()) throw new Error('Missing player identity')
  const normalized = username.trim().toLowerCase()
  // The collector selects the *lowest* SHA(seed, username) hashes. A separate
  // namespace is essential or every selected account can land in holdout.
  return parseInt(sha(`${seed}\0player-split-v1\0${normalized}`).slice(0, 8), 16) < 0x33333333
    ? 'test'
    : 'train'
}
export function eloAnchor(rating) {
  const bounded = Math.max(500, Math.min(2500, rating))
  return ELO_ANCHORS.reduce((best, anchor) =>
    Math.abs(anchor - bounded) < Math.abs(best - bounded) ? anchor : best
  )
}
export function lossBucket(loss) {
  const index = LOSS_BOUNDS.findIndex((bound) => loss <= bound)
  return index < 0 ? LOSS_BOUNDS.length : index
}
export function quantiles(values) {
  if (!values.length) return []
  const sorted = [...values].sort((a, b) => a - b)
  return QUANTILES.map((q) => {
    const at = q * (sorted.length - 1)
    const low = Math.floor(at)
    const fraction = at - low
    return (
      Math.round(
        (sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * fraction) *
          100
      ) / 100
    )
  })
}
export function cpLoss(rootScore, childScore, playedUci, bestUci) {
  if (rootScore?.type === 'mate' || childScore?.type === 'mate')
    return { cpLoss: null, mateTransition: true }
  if (
    rootScore?.type !== 'cp' ||
    childScore?.type !== 'cp' ||
    !Number.isFinite(rootScore.value) ||
    !Number.isFinite(childScore.value)
  ) {
    return { cpLoss: null, mateTransition: false }
  }
  return {
    cpLoss: playedUci === bestUci ? 0 : Math.max(0, rootScore.value + childScore.value),
    mateTransition: false
  }
}

export function parseGame(game) {
  if (
    !game ||
    !game.white?.username ||
    !game.black?.username ||
    !Number.isInteger(game.white.rating) ||
    !Number.isInteger(game.black.rating) ||
    typeof game.pgn !== 'string'
  )
    return null
  if (
    /\[(?:Variant|SetUp|FEN)\s+"(?!Standard"|0")/i.test(game.pgn) ||
    /\[Result\s+"\*"\]/i.test(game.pgn) ||
    /\[Termination\s+"[^"]*(?:abort|unterminated)/i.test(game.pgn) ||
    game.pgn.trimEnd().endsWith('*')
  )
    return null
  const chess = new Chess()
  try {
    chess.loadPgn(game.pgn)
  } catch {
    return null
  }
  const history = chess.history({ verbose: true })
  if (history.length < MIN_PLIES) return null
  const positions = []
  for (let ply = 0; ply < history.length; ply++) {
    const move = history[ply]
    const playedUci = move.from + move.to + (move.promotion ?? '')
    positions.push({
      ply,
      beforeFen: move.before,
      playedUci,
      afterFen: move.after,
      rating: ply % 2 === 0 ? game.white.rating : game.black.rating,
      player: String(ply % 2 === 0 ? game.white.username : game.black.username).toLowerCase()
    })
  }
  return positions
}

export function selectGames(
  games,
  seed,
  maxGames,
  perPlayerCap = PER_PLAYER_GAME_CAP,
  progress = () => {}
) {
  const selected = []
  const players = new Map()
  const skipped = { crossSplit: 0, invalidPgn: 0, perPlayerCap: 0, duplicate: 0, maxGames: 0 }
  const seen = new Set()
  const ordered = games
    .map((game) => ({ game, key: sha(`${seed}\0${game.uuid ?? game.url ?? game.pgn}`) }))
    .sort((a, b) => a.key.localeCompare(b.key))
  for (const [index, { game, key }] of ordered.entries()) {
    if (index > 0 && index % 500 === 0) progress(`Parsed ${index}/${ordered.length} games`)
    if (seen.has(game.uuid ?? game.url ?? key)) {
      skipped.duplicate++
      continue
    }
    seen.add(game.uuid ?? game.url ?? key)
    if (selected.length >= maxGames) {
      skipped.maxGames++
      continue
    }
    let whiteSplit, blackSplit
    try {
      whiteSplit = playerSplit(game.white?.username, seed)
      blackSplit = playerSplit(game.black?.username, seed)
    } catch {
      skipped.invalidPgn++
      continue
    }
    if (whiteSplit !== blackSplit) {
      skipped.crossSplit++
      continue
    }
    const white = game.white.username.toLowerCase()
    const black = game.black.username.toLowerCase()
    if ((players.get(white) ?? 0) >= perPlayerCap || (players.get(black) ?? 0) >= perPlayerCap) {
      skipped.perPlayerCap++
      continue
    }
    const positions = parseGame(game)
    if (!positions) {
      skipped.invalidPgn++
      continue
    }
    players.set(white, (players.get(white) ?? 0) + 1)
    if (white !== black) players.set(black, (players.get(black) ?? 0) + 1)
    selected.push({ key, split: whiteSplit, timeControl: game.timeControl ?? null, positions })
  }
  return { selected, skipped }
}

/** Keep the lowest seeded hashes per cell; input order has no influence. */
export function selectPositions(selectedGames, seed, positionsPerCell, progress = () => {}) {
  const cells = new Map()
  const cellPlayerWorst = new Map()
  const candidateCounts = {}
  const openingMap = new Map()
  const outOfRangePositions = { train: 0, test: 0 }
  const perPlayerPositionCap = Math.max(2, Math.min(20, Math.ceil(positionsPerCell / 3)))
  for (const [index, game] of selectedGames.entries()) {
    if (index > 0 && index % 500 === 0)
      progress(`Sampled ${index}/${selectedGames.length} accepted games`)
    for (const position of game.positions) {
      if (position.rating < 500 || position.rating > 2500) {
        outOfRangePositions[game.split]++
        continue
      }
      const elo = eloAnchor(position.rating)
      if (game.split === 'train' && position.ply < 20) {
        const epd = position.beforeFen.split(' ').slice(0, 4).join(' ')
        const key = `${elo}|${epd}`
        let record = openingMap.get(key)
        if (!record) {
          record = { epd, elo, count: 0, moves: new Map() }
          openingMap.set(key, record)
        }
        record.count++
        record.moves.set(position.playedUci, (record.moves.get(position.playedUci) ?? 0) + 1)
      }
      const phase = phaseOf(position.beforeFen)
      const key = sha(`${seed}\0${game.key}\0${position.ply}`)
      for (const samplePhase of [phase, 'all']) {
        const cell = `${game.split}|${elo}|${samplePhase}`
        candidateCounts[cell] = (candidateCounts[cell] ?? 0) + 1
        let picks = cells.get(cell)
        if (!picks) {
          picks = []
          cells.set(cell, picks)
          cellPlayerWorst.set(cell, new Map())
        }
        const candidate = {
          ...position,
          phase,
          samplePhase,
          elo,
          split: game.split,
          gameKey: game.key,
          key
        }
        if (picks.length >= positionsPerCell && key >= picks[0].key) continue
        const playerWorst = cellPlayerWorst.get(cell).get(candidate.player)
        if (playerWorst?.count >= perPlayerPositionCap && key >= playerWorst.key) continue
        const kept = [...picks, candidate].sort((a, b) => a.key.localeCompare(b.key))
        const playerCounts = new Map()
        picks.length = 0
        for (const item of kept) {
          const count = playerCounts.get(item.player) ?? 0
          if (count >= perPlayerPositionCap) continue
          playerCounts.set(item.player, count + 1)
          picks.push(item)
          if (picks.length >= positionsPerCell) break
        }
        picks.reverse()
        const byPlayer = cellPlayerWorst.get(cell)
        byPlayer.clear()
        for (const item of picks) {
          const existing = byPlayer.get(item.player)
          byPlayer.set(item.player, {
            count: (existing?.count ?? 0) + 1,
            key: existing?.key ?? item.key
          })
        }
      }
    }
  }
  const positions = [...cells.values()]
    .flat()
    .sort((a, b) => a.key.localeCompare(b.key) || a.samplePhase.localeCompare(b.samplePhase))
    .map((position) => ({ ...position, ...positionContext(position.beforeFen) }))
  const openings = [...openingMap.values()]
    .filter((r) => r.count >= 8)
    .map((r) => ({
      epd: r.epd,
      elo: r.elo,
      count: r.count,
      moves: [...r.moves]
        .map(([uci, count]) => ({ uci, count }))
        .sort((a, b) => b.count - a.count || a.uci.localeCompare(b.uci))
    }))
    .sort((a, b) => a.elo - b.elo || a.epd.localeCompare(b.epd))
  return { positions, openings, candidateCounts, outOfRangePositions }
}

function parseScore(line) {
  if (!/^info\s/.test(line) || /\bmultipv\s+(?!1\b)\d+/.test(line)) return null
  const match = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)(?:\s+(lowerbound|upperbound))?/)
  if (!match) return null
  return match[3] ? { bound: true } : { type: match[1], value: Number(match[2]) }
}

export class UciEngine {
  constructor(path, nodes, timeoutMs = 90_000) {
    this.path = path
    this.nodes = nodes
    this.timeoutMs = timeoutMs
    this.child = null
    this.pending = null
    this.buffer = ''
    this.stderr = ''
    this.name = null
  }
  async start() {
    if (this.child) return
    const child = spawn(this.path, [], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child = child
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      let at
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at).trim()
        this.buffer = this.buffer.slice(at + 1)
        if (line.startsWith('id name ')) this.name = line.slice(8)
        this.pending?.(line)
      }
    })
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-2000)
    })
    child.once('error', (error) => {
      this.pending?.(null, error)
      this.child = null
    })
    child.once('exit', (code) => {
      this.pending?.(null, new Error(`Engine exited ${code}: ${this.stderr}`))
      this.child = null
    })
    try {
      this.send('uci')
      await this.waitFor((line) => line === 'uciok')
      this.send('setoption name Threads value 1')
      this.send('setoption name Hash value 32')
      this.send('setoption name MultiPV value 1')
      this.send('setoption name UCI_ShowWDL value false')
      await this.ready()
    } catch (error) {
      this.close()
      throw error
    }
  }
  send(line) {
    this.child.stdin.write(`${line}\n`)
  }
  waitFor(predicate) {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending = null
        this.close()
        rejectPromise(new Error('Stockfish timed out'))
      }, this.timeoutMs)
      this.pending = (line, error) => {
        if (error || line === null) {
          clearTimeout(timer)
          this.pending = null
          rejectPromise(error ?? new Error('Stockfish closed'))
          return
        }
        if (predicate(line)) {
          clearTimeout(timer)
          this.pending = null
          resolvePromise(line)
        }
      }
    })
  }
  async ready() {
    this.send('isready')
    await this.waitFor((line) => line === 'readyok')
  }
  async search(fen) {
    await this.start()
    try {
      this.send('ucinewgame')
      await this.ready() // clears the hash before every independent search
      this.send(`position fen ${fen}`)
      let score = null
      let bestUci = null
      const result = new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          this.pending = null
          this.close()
          rejectPromise(new Error('Stockfish search timed out'))
        }, this.timeoutMs)
        this.pending = (line, error) => {
          if (error || line === null) {
            clearTimeout(timer)
            this.pending = null
            rejectPromise(error ?? new Error('Stockfish closed'))
            return
          }
          const parsed = parseScore(line)
          // A bounded final iteration can follow a completed exact iteration. Retain
          // the last exact score rather than turning a usable search into missing data.
          if (parsed && !parsed.bound) score = parsed
          if (line.startsWith('bestmove ')) {
            bestUci = line.split(/\s+/)[1]
            clearTimeout(timer)
            this.pending = null
            if (!score || !bestUci || bestUci === '(none)')
              rejectPromise(new Error('Stockfish returned no usable score'))
            else resolvePromise({ score, bestUci })
          }
        }
      })
      this.send(`go nodes ${this.nodes}`)
      return await result
    } catch (error) {
      this.close()
      throw error
    }
  }
  close() {
    const child = this.child
    this.child = null
    this.pending = null
    if (child && !child.killed) child.kill()
  }
}

export async function observePosition(position, engine) {
  const root = await engine.search(position.beforeFen)
  // The second search evaluates the exact human continuation from the opponent's perspective.
  const after = new Chess(position.afterFen)
  const child = after.isGameOver()
    ? { score: after.isCheckmate() ? { type: 'mate', value: 0 } : { type: 'cp', value: 0 } }
    : await engine.search(position.afterFen)
  const loss = cpLoss(root.score, child.score, position.playedUci, root.bestUci)
  return {
    ...loss,
    rootScore: root.score,
    childScore: child.score,
    bestUci: root.bestUci,
    rootWithinRange: root.score.type === 'cp' && Math.abs(root.score.value) <= MAX_PROFILE_ROOT_CP
  }
}

function emptyStat() {
  return {
    losses: [],
    ratings: [],
    players: new Set(),
    games: new Set(),
    inCheck: [],
    hasCapture: []
  }
}
export function buildProfiles(observations) {
  const stats = new Map()
  for (const observation of observations) {
    if (
      observation.split !== 'train' ||
      observation.cpLoss === null ||
      !observation.rootWithinRange
    )
      continue
    for (const phase of [observation.samplePhase ?? observation.phase]) {
      const key = `${observation.elo}|${phase}`
      let stat = stats.get(key)
      if (!stat) {
        stat = emptyStat()
        stats.set(key, stat)
      }
      stat.losses.push(observation.cpLoss)
      stat.ratings.push(observation.rating)
      stat.players.add(observation.player)
      stat.games.add(observation.gameKey)
      if (observation.inCheck) stat.inCheck.push(observation.cpLoss)
      if (observation.hasCapture) stat.hasCapture.push(observation.cpLoss)
    }
  }
  const counts = (losses) => {
    const buckets = Array(LOSS_BOUNDS.length + 1).fill(0)
    for (const loss of losses) buckets[lossBucket(loss)]++
    return buckets
  }
  return [...stats]
    .map(([key, s]) => {
      const [elo, phase] = key.split('|')
      return {
        elo: Number(elo),
        phase,
        count: s.losses.length,
        players: s.players.size,
        games: s.games.size,
        ratingMin: Math.min(...s.ratings),
        ratingMax: Math.max(...s.ratings),
        ratingMedian: quantiles(s.ratings)[1],
        quantilesCp: quantiles(s.losses),
        lossCounts: counts(s.losses),
        inCheck: { count: s.inCheck.length, lossCounts: counts(s.inCheck) },
        hasCapture: { count: s.hasCapture.length, lossCounts: counts(s.hasCapture) }
      }
    })
    .sort(
      (a, b) =>
        a.elo - b.elo ||
        ['opening', 'middlegame', 'endgame', 'all'].indexOf(a.phase) -
          ['opening', 'middlegame', 'endgame', 'all'].indexOf(b.phase)
    )
}

async function loadGames(path) {
  const games = []
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity })
  let number = 0
  for await (const line of lines) {
    number++
    if (!line.trim()) continue
    try {
      games.push(JSON.parse(line))
    } catch {
      throw new Error(`Invalid JSON on line ${number}`)
    }
  }
  return games
}
async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temp, content)
  await rename(temp, path)
}
async function cachedObservation(position, engine, cacheDir, engineHash, nodes, inFlight) {
  const key = sha(`${engineHash}\0${nodes}\0${position.beforeFen}\0${position.playedUci}`)
  const running = inFlight.get(key)
  if (running) return { ...(await running), reused: true }
  const task = (async () => {
    const path = join(cacheDir, `${key}.json`)
    try {
      const value = JSON.parse(await readFile(path, 'utf8'))
      if (value?.cacheVersion === 1 && value.result?.rootScore && value.result?.childScore)
        return { ...value.result, cached: true }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const result = await observePosition(position, engine)
    try {
      await atomicWrite(path, JSON.stringify({ cacheVersion: 1, result }))
      return { ...result, cached: false }
    } catch (error) {
      // A transient cache write failure must never discard a completed search.
      return {
        ...result,
        cached: false,
        cacheWriteError: String(error.message ?? error).slice(0, 200)
      }
    }
  })()
  inFlight.set(key, task)
  try {
    return await task
  } finally {
    inFlight.delete(key)
  }
}

export async function analyze(options, dependencies = {}) {
  if (
    options.input &&
    (resolve(options.input) === resolve(options.out) ||
      resolve(options.input) === resolve(options.observations))
  ) {
    throw new Error('Analysis outputs cannot overwrite the input corpus')
  }
  const games = dependencies.games ?? (await loadGames(options.input))
  const { selected, skipped } = selectGames(
    games,
    options.seed,
    options.maxGames,
    PER_PLAYER_GAME_CAP,
    (message) => console.log(message)
  )
  const { positions, openings, candidateCounts, outOfRangePositions } = selectPositions(
    selected,
    options.seed,
    options.positionsPerCell,
    (message) => console.log(message)
  )
  console.log(`Selected ${positions.length} positions from ${selected.length} games`)
  const enginePath = options.engine ?? join(ROOT, 'resources', 'engine', 'stockfish-avx2.exe')
  if (!dependencies.engineFactory) await stat(enginePath)
  const engineHash =
    dependencies.engineHash ??
    (dependencies.engineFactory ? 'test-engine' : sha(await readFile(enginePath)))
  const cacheDir = dependencies.cacheDir ?? join(DOWNLOAD, 'analysis-cache')
  await mkdir(cacheDir, { recursive: true })
  const workers = Array.from({ length: options.workers }, () =>
    dependencies.engineFactory
      ? dependencies.engineFactory()
      : new UciEngine(enginePath, options.nodes)
  )
  // Resolve UCI identity even when every observation is already cached.
  await workers[0].start?.()
  const observations = Array(positions.length)
  let next = 0
  let completed = 0
  let errors = 0
  let cached = 0
  let reused = 0
  let cacheWriteErrors = 0
  const inFlight = new Map()
  await Promise.all(
    workers.map(async (engine) => {
      try {
        while (next < positions.length) {
          const index = next++
          const p = positions[index]
          let evaluation
          try {
            evaluation = await cachedObservation(
              p,
              engine,
              cacheDir,
              engineHash,
              options.nodes,
              inFlight
            )
            if (evaluation.cached) cached++
            if (evaluation.reused) reused++
            if (evaluation.cacheWriteError) cacheWriteErrors++
          } catch (error) {
            errors++
            evaluation = {
              cpLoss: null,
              mateTransition: false,
              rootWithinRange: false,
              error: String(error.message ?? error).slice(0, 200)
            }
          }
          observations[index] = {
            beforeFen: p.beforeFen,
            playedUci: p.playedUci,
            rating: p.rating,
            elo: p.elo,
            phase: p.phase,
            samplePhase: p.samplePhase,
            split: p.split,
            inCheck: p.inCheck,
            hasCapture: p.hasCapture,
            legalMoves: p.legalMoves,
            cpLoss: evaluation.cpLoss,
            mateTransition: evaluation.mateTransition,
            rootWithinRange: evaluation.rootWithinRange,
            rootMate: evaluation.rootScore?.type === 'mate',
            childMate: evaluation.childScore?.type === 'mate',
            rootScore: evaluation.rootScore ?? null,
            childScore: evaluation.childScore ?? null,
            bestUci: evaluation.bestUci ?? null,
            error: evaluation.error ?? null,
            player: sha(`${options.seed}\0${p.player}`).slice(0, 16),
            gameKey: p.gameKey
          }
          completed++
          if (completed % 100 === 0)
            console.log(`Analyzed ${completed}/${positions.length} positions`)
        }
      } finally {
        engine.close?.()
      }
    })
  )
  const profiles = buildProfiles(observations)
  const count = (predicate) => observations.filter(predicate).length
  const coverage = {
    inputGames: games.length,
    acceptedGames: selected.length,
    trainGames: selected.filter((g) => g.split === 'train').length,
    holdoutGames: selected.filter((g) => g.split === 'test').length,
    skipped,
    outOfRangePositions,
    candidateCounts,
    selectedPositions: positions.length,
    timeControls: Object.fromEntries(
      [...new Set(selected.map((g) => g.timeControl ?? 'unknown'))]
        .sort()
        .map((control) => [
          control,
          selected.filter((g) => (g.timeControl ?? 'unknown') === control).length
        ])
    ),
    trainPositions: count((o) => o.split === 'train'),
    holdoutPositions: count((o) => o.split === 'test'),
    cachedPositions: cached,
    errors,
    reusedPositions: reused,
    cacheWriteErrors,
    mateTransitions: count((o) => o.mateTransition),
    rootMateScores: count((o) => o.rootMate),
    childMateScores: count((o) => o.childMate),
    missingScore: count((o) => o.cpLoss === null && !o.mateTransition),
    excludedRootCp: count((o) => o.cpLoss !== null && !o.rootWithinRange),
    profilePositions: count((o) => o.split === 'train' && o.cpLoss !== null && o.rootWithinRange),
    byCell: Object.fromEntries(
      Object.keys(candidateCounts)
        .sort()
        .map((cell) => {
          const [split, elo, phase] = cell.split('|')
          const members = observations.filter(
            (o) => o.split === split && o.elo === Number(elo) && o.samplePhase === phase
          )
          return [
            cell,
            {
              candidates: candidateCounts[cell],
              selected: members.length,
              eligible: members.filter((o) => o.cpLoss !== null && o.rootWithinRange).length,
              mateTransitions: members.filter((o) => o.mateTransition).length,
              excludedRootCp: members.filter((o) => o.cpLoss !== null && !o.rootWithinRange).length,
              missingScore: members.filter((o) => o.cpLoss === null && !o.mateTransition).length
            }
          ]
        })
    )
  }
  const artifact = {
    schemaVersion: 1,
    source: 'Chess.com PubAPI',
    timeClass: 'rapid',
    ratingMeaning: 'Historical postgame player ratings from Chess.com monthly archives',
    caveat: 'Biased observational pilot; not a calibrated Elo model or population estimate.',
    engine: {
      name: workers[0]?.name ?? 'unknown',
      version: workers[0]?.name ?? 'unknown',
      binarySha256: engineHash,
      nodes: options.nodes,
      threads: 1,
      hashMb: 32,
      scorePerspective: 'side-to-move',
      rootCpCalibrationLimit: MAX_PROFILE_ROOT_CP
    },
    sampling: {
      seed: options.seed,
      positionsPerCell: options.positionsPerCell,
      eloAnchors: ELO_ANCHORS,
      eligibleRatingRange: [500, 2500],
      clockStratification:
        'None; game time controls are reported but remaining clock is not modeled',
      playerSplit:
        'SHA-256(seed,player-split-v1,lowercase username), 80% train/20% holdout; both players must match',
      aggregateProfile:
        'Independent per-Elo reservoir over all phases (natural corpus phase frequencies)',
      maxPositionsPerPlayerPerCell: Math.max(
        2,
        Math.min(20, Math.ceil(options.positionsPerCell / 3))
      ),
      perPlayerGameCap: PER_PLAYER_GAME_CAP,
      minimumGamePlies: MIN_PLIES,
      lossBoundsCp: LOSS_BOUNDS,
      quantileProbabilities: QUANTILES
    },
    coverage,
    profiles,
    openings
  }
  // Observations are a local research artifact. Strip direct player names and game URLs from the bundled JSON.
  await atomicWrite(
    options.observations,
    observations.map((o) => JSON.stringify(o)).join('\n') + (observations.length ? '\n' : '')
  )
  await atomicWrite(options.out, JSON.stringify(artifact, null, 2) + '\n')
  return artifact
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  analyze(parseArgs(process.argv.slice(2)))
    .then((artifact) => {
      console.log(
        `Analyzed ${artifact.coverage.selectedPositions} positions; ${artifact.coverage.profilePositions} train calibration observations.`
      )
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
