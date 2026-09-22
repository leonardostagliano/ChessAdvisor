// Bounded Stockfish benchmark of fallback move selection on held-out Rapid positions.
// This compares policies, not complete model games or playing Elo.
// node scripts/benchmark-rapid-policy.mjs [--observations FILE] [--out FILE]
//   [--per-band 1..3] [--seeds 1..64]
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { Chess } from 'chess.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOWNLOAD = join(ROOT, 'resources', 'data', '.download', 'rapid')
const ANCHORS = [600, 900, 1200, 1500, 1800, 2100, 2400]
const OLD_TARGETS = [650, 390, 180, 80, 25, 0]
const OLD_CEILINGS = [1200, 700, 350, 200, 100, 50]
const MATE_SCORE = 100_000
const hash = (value) => createHash('sha256').update(value).digest('hex')

function args(argv) {
  const options = {
    observations: join(DOWNLOAD, 'observations.jsonl'),
    out: join(ROOT, 'docs', 'rapid-policy-benchmark.json'),
    perBand: 1,
    seeds: 32
  }
  const names = {
    '--observations': 'observations',
    '--out': 'out',
    '--per-band': 'perBand',
    '--seeds': 'seeds'
  }
  for (let i = 0; i < argv.length; i++) {
    const key = names[argv[i]]
    if (!key) throw new Error(`Unknown option ${argv[i]}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`)
    options[key] = value
  }
  for (const [key, max] of [
    ['perBand', 3],
    ['seeds', 64]
  ]) {
    options[key] = Number(options[key])
    if (!Number.isSafeInteger(options[key]) || options[key] < 1 || options[key] > max)
      throw new Error(`${key} must be 1..${max}`)
  }
  options.observations = resolve(options.observations)
  options.out = resolve(options.out)
  return options
}

async function loadHeldout(path, perBand) {
  const byBand = new Map(ANCHORS.map((elo) => [elo, new Map()]))
  let read = 0,
    eligible = 0
  for await (const line of createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity
  })) {
    if (!line.trim()) continue
    read++
    const row = JSON.parse(line)
    if (
      row.split !== 'test' ||
      row.rootWithinRange !== true ||
      !Number.isFinite(row.cpLoss) ||
      !ANCHORS.includes(row.elo) ||
      typeof row.beforeFen !== 'string'
    )
      continue
    const chess = new Chess(row.beforeFen)
    if (chess.isGameOver()) continue
    eligible++
    const map = byBand.get(row.elo)
    if (!map.has(row.beforeFen))
      map.set(row.beforeFen, {
        id: hash(row.beforeFen).slice(0, 16),
        fen: row.beforeFen,
        elo: row.elo,
        phase: row.phase
      })
  }
  const selected = selectHeldout(byBand, perBand)
  return { selected, read, eligible }
}

/** One global FEN set prevents familiar positions from counting in several Elo bands. */
export function selectHeldout(byBand, perBand) {
  const phases = ['opening', 'middlegame', 'endgame']
  const usedFen = new Set()
  const selected = []
  for (const [bandIndex, elo] of ANCHORS.entries()) {
    const groups = new Map(
      phases.map((phase) => [
        phase,
        [...(byBand.get(elo)?.values() ?? [])]
          .filter((row) => row.phase === phase)
          .sort((a, b) => a.id.localeCompare(b.id))
      ])
    )
    const next = new Map(phases.map((phase) => [phase, 0]))
    for (let slot = 0; slot < perBand; slot++) {
      let choice = null
      // Rotate the first phase by band and slot. Exhaust duplicate FENs within
      // a preferred phase before falling back to another available phase.
      for (let offset = 0; offset < phases.length && !choice; offset++) {
        const phase = phases[(bandIndex + slot + offset) % phases.length]
        const group = groups.get(phase)
        let index = next.get(phase)
        while (index < group.length && usedFen.has(group[index].fen)) index++
        if (index < group.length) choice = group[index]
        next.set(phase, index + (choice?.phase === phase ? 1 : 0))
      }
      if (!choice) break
      selected.push(choice)
      usedFen.add(choice.fen)
    }
  }
  return selected
}

// Freeze the old fallback exactly, including its original FNV seed mixer.
function oldUnit(seed) {
  let value = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    value ^= seed.charCodeAt(i)
    value = Math.imul(value, 0x01000193)
  }
  return (value >>> 0) / 0x1_0000_0000
}

function oldChoice(lines, level, seed, utility) {
  const scored = lines
    .map((line) => ({ line, score: utility(line) }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => b.score - a.score || a.line.move.localeCompare(b.line.move))
  if (!scored.length) return null
  const best = scored[0]
  const target = OLD_TARGETS[level - 1]
  if (target === 0) return best.line
  const choices = scored.filter(
    ({ score }) =>
      best.score - score <= OLD_CEILINGS[level - 1] &&
      !(best.line.scoreMate === 1 && score <= MATE_SCORE - 1000)
  )
  if (!choices.length) return best.line
  const desired = target * (0.45 + oldUnit(seed + ':loss') * 0.9)
  return choices.sort(
    (a, b) =>
      Math.abs(best.score - a.score - desired) - Math.abs(best.score - b.score - desired) ||
      oldUnit(seed + ':' + a.line.move) - oldUnit(seed + ':' + b.line.move)
  )[0].line
}

async function runtimeBundle() {
  await mkdir(DOWNLOAD, { recursive: true })
  const outfile = join(DOWNLOAD, `benchmark-runtime-${process.pid}-${randomUUID()}.mjs`)
  await build({
    stdin: {
      contents: `export { EngineService } from './src/main/engine/engineService.ts';
export { difficultyPolicy, sampledCandidate, lineUtility, seededUnit } from './src/main/game/difficultyPolicy.ts';
export { OPPONENT_PROFILE, playOpponentTurn } from './src/main/game/opponentTurn.ts';`,
      resolveDir: ROOT,
      sourcefile: 'benchmark-runtime.ts',
      loader: 'ts'
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    tsconfig: join(ROOT, 'tsconfig.node.json'),
    logLevel: 'silent'
  })
  try {
    return { runtime: await import(pathToFileURL(outfile).href), outfile }
  } catch (error) {
    await rm(outfile, { force: true })
    throw error
  }
}

function stats(values) {
  const finite = values.filter((value) => value.kind === 'cp')
  const sum = finite.reduce((total, value) => total + value.lossCp, 0)
  const current = values[0]?.policy === 'current'
  return {
    selections: values.length,
    finiteCp: finite.length,
    meanLossCp: finite.length ? Math.round((100 * sum) / finite.length) / 100 : null,
    lossOver150: finite.filter((value) => value.lossCp > 150).length,
    mateTransitions: values.filter((value) => value.kind === 'mate').length,
    terminalDraws: values.filter((value) => value.terminal === 'draw').length,
    drawWithMateReference: values.filter((value) => value.kind === 'draw-mate-reference').length,
    runtimeVerified: current
      ? values.filter((value) => value.engineVerified === true).length
      : null,
    runtimeUnverified: current
      ? values.filter((value) => value.engineVerified === false).length
      : null,
    missingScore: values.filter((value) => value.kind === 'missing').length
  }
}

async function benchmark(options) {
  const { selected, read, eligible } = await loadHeldout(options.observations, options.perBand)
  if (!selected.length) throw new Error('No eligible held-out positions in observations')
  const missingBands = ANCHORS.filter((elo) => !selected.some((position) => position.elo === elo))
  if (missingBands.length)
    console.log(`No eligible held-out position in Elo bands: ${missingBands.join(', ')}`)
  const { runtime, outfile } = await runtimeBundle()
  const settings = { get: () => ({ engineBinary: 'avx2' }), save: async () => {} }
  const engine = new runtime.EngineService({
    settings,
    resourcePath: (...parts) => join(ROOT, 'resources', ...parts),
    emit: () => {},
    threads: 1,
    hashMb: 32
  })
  const rootCache = new Map(),
    childCache = new Map(),
    verified = new Map()
  const rows = []
  try {
    const state = await engine.start()
    if (!state.available) throw new Error(`Stockfish unavailable: ${state.message}`)
    const root = async (fen, profile) => {
      const key = `${profile}\0${fen}`
      if (!rootCache.has(key)) rootCache.set(key, await engine.analyze(fen, profile))
      return rootCache.get(key)
    }
    const child = async (fen) => {
      if (!childCache.has(fen)) childCache.set(fen, await engine.analyze(fen, 'opponent-check'))
      return childCache.get(fen)
    }
    for (const [positionIndex, position] of selected.entries()) {
      for (let level = 1; level <= 6; level++) {
        const analysis = await root(position.fen, runtime.OPPONENT_PROFILE[level])
        const bestLine =
          analysis.lines.find((line) => line.move === analysis.bestMove) ?? analysis.lines[0]
        const best = runtime.lineUtility(bestLine)
        if (best === null) throw new Error(`No scored root line: ${position.id}, level ${level}`)
        const difficulty = {
          mode: 'fixed',
          level,
          targetElo: level === 6 ? null : ANCHORS[level - 1]
        }
        for (let index = 0; index < options.seeds; index++) {
          const seed = `${position.id}:${level}:${index}`
          const returned = await runtime.playOpponentTurn(
            {
              codex: {
                runTurn: async () => ({
                  ok: true,
                  text: 'unusable benchmark response',
                  effectiveModel: 'benchmark-mock'
                })
              },
              engine: {
                state: () => engine.state(),
                analyze: (fen, requestedProfile) =>
                  requestedProfile === 'opponent-check' ? child(fen) : root(fen, requestedProfile)
              },
              now: () => 0
            },
            {
              threadId: 'benchmark',
              model: 'benchmark-mock',
              effort: 'low',
              language: 'en',
              difficulty,
              fen: position.fen,
              pgn: '',
              lastUserMove: null,
              takebackNotice: null,
              timeoutMs: 1000,
              streamId: 'benchmark',
              difficultySeed: seed,
              allowResign: false,
              onDelta: () => {},
              onRetry: () => {}
            }
          )
          if (returned.fallback !== 'engine' || returned.attempts !== 3 || returned.resign)
            throw new Error(
              `Runtime did not return engine fallback: ${position.id}, level ${level}`
            )
          const choices = {
            current: { move: returned.uci, engineVerified: returned.engineVerified === true },
            oldFallback: oldChoice(analysis.lines, level, seed, runtime.lineUtility)
          }
          for (const [name, line] of Object.entries(choices)) {
            if (!line) throw new Error(`No selected line: ${position.id}, level ${level}, ${name}`)
            const chess = new Chess(position.fen)
            const move = chess.move({
              from: line.move.slice(0, 2),
              to: line.move.slice(2, 4),
              promotion: line.move[4]
            })
            if (!move)
              throw new Error(`Illegal selected move ${line.move}: ${position.id}, level ${level}`)
            const key = `${position.id}\0${level}\0${line.move}`
            if (!verified.has(key)) {
              let result
              if (chess.isCheckmate()) result = { kind: 'mate', outcome: 'delivered' }
              else if (chess.isGameOver())
                result =
                  Math.abs(best) >= MATE_SCORE - 999
                    ? { kind: 'draw-mate-reference', terminal: 'draw' }
                    : { kind: 'cp', lossCp: Math.max(0, best), terminal: 'draw' }
              else {
                const reply = await child(chess.fen())
                const replyBest = reply.lines
                  .map(runtime.lineUtility)
                  .filter((score) => score !== null)
                  .sort((a, b) => b - a)[0]
                if (replyBest === undefined) result = { kind: 'missing' }
                else if (
                  Math.abs(best) >= MATE_SCORE - 999 ||
                  Math.abs(replyBest) >= MATE_SCORE - 999
                )
                  result = { kind: 'mate', outcome: 'transition' }
                else result = { kind: 'cp', lossCp: Math.max(0, best + replyBest) }
              }
              verified.set(key, result)
            }
            rows.push({
              positionId: position.id,
              elo: position.elo,
              phase: position.phase,
              level,
              policy: name,
              seedIndex: index,
              move: line.move,
              ...(name === 'current' ? { engineVerified: line.engineVerified } : {}),
              ...verified.get(key)
            })
          }
        }
      }
      console.log(
        `Verified ${positionIndex + 1}/${selected.length} positions; ${verified.size} unique root/profile/move checks`
      )
    }
  } finally {
    await engine.shutdown()
    await rm(outfile, { force: true })
  }
  const byLevel = Object.fromEntries(
    [1, 2, 3, 4, 5, 6].map((level) => [
      level,
      Object.fromEntries(
        ['current', 'oldFallback'].map((name) => [
          name,
          stats(rows.filter((row) => row.level === level && row.policy === name))
        ])
      )
    ])
  )
  const report = {
    schemaVersion: 1,
    sourceObservations: relative(ROOT, options.observations).replaceAll('\\', '/'),
    methodology:
      'Held-out, finite-CP, root-within-range positions; deterministic phase-balanced sampling up to the per-band limit. Each level uses its actual EngineService opponent search profile on the same positions. Current invokes playOpponentTurn with three deterministic unusable mocked model responses and records the actual engine fallback after its bounded child-position safety check. OldFallback freezes the former unverified fallback selector on the same root pool. A current fallback may return the best legal line without independent verification if no candidate passes or child scores are missing; runtimeUnverified counts these, and the loss ceiling is not guaranteed for them. Each distinct returned move is checked by Stockfish from the child position with opponent-check. CP loss is max(0, root best + child best), or max(0, root best) for a terminal draw against a finite-CP reference. Mate transitions, terminal draws with a mate reference, and unavailable scores are separate. This benchmarks fallback selection only, not LLM game play or Elo. The former model-move adjustment stage is not simulated.',
    oldFallback: {
      targetLossCp: OLD_TARGETS,
      ceilingCp: OLD_CEILINGS,
      note: 'Frozen pre-change fallback policy, including its original seed mixer and loss multiplier.'
    },
    limits: { perBand: options.perBand, seedsPerPositionLevel: options.seeds, maxPositions: 21 },
    coverage: {
      observationsRead: read,
      eligibleHeldout: eligible,
      selectedPositions: selected.length,
      selectedByElo: Object.fromEntries(
        ANCHORS.map((elo) => [elo, selected.filter((p) => p.elo === elo).length])
      ),
      missingBands,
      uniqueRootAnalyses: rootCache.size,
      uniqueChildAnalyses: childCache.size,
      uniqueVerifiedMoves: verified.size
    },
    positions: selected,
    byLevel
  }
  await mkdir(dirname(options.out), { recursive: true })
  const temp = `${options.out}.tmp-${process.pid}`
  await writeFile(temp, JSON.stringify(report, null, 2) + '\n')
  await rename(temp, options.out)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  benchmark(args(process.argv.slice(2)))
    .then((report) => {
      console.log(
        `Wrote benchmark for ${report.coverage.selectedPositions} positions to ${args(process.argv.slice(2)).out}`
      )
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
