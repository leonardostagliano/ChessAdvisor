import { existsSync } from 'node:fs'
import { cpus } from 'node:os'
import type { Analysis, AnalysisProfile, EngineLine, EngineState } from '@shared/types/engine'
import { ManagedProcess } from '../process/childProcess'
import type { SettingsStore } from '../store/settingsStore'
import { parseBestMove, parseInfoLine, type InfoLine } from './uci'

/**
 * Search budget per use case (spec §3.2). `live` drives the eval bar and must stay cheap,
 * `coach` feeds comments, hints and the illegal-move fallback, `review` the post-game analysis.
 */
export const PROFILES: Record<
  AnalysisProfile,
  { depth: number; movetimeMs?: number; multipv: number }
> = {
  live: { depth: 14, movetimeMs: 300, multipv: 1 },
  feedback: { depth: 16, movetimeMs: 300, multipv: 1 },
  'opponent-beginner': { depth: 10, movetimeMs: 300, multipv: 3 },
  'opponent-easy': { depth: 12, movetimeMs: 500, multipv: 4 },
  'opponent-medium': { depth: 15, movetimeMs: 800, multipv: 5 },
  'opponent-challenging': { depth: 18, movetimeMs: 1500, multipv: 6 },
  'opponent-strong': { depth: 20, movetimeMs: 2500, multipv: 8 },
  opponent: { depth: 22, movetimeMs: 4000, multipv: 12 },
  'opponent-check': { depth: 20, movetimeMs: 700, multipv: 1 },
  // Automatic move comments need several candidate lines, but must reach the model promptly.
  comment: { depth: 18, movetimeMs: 900, multipv: 5 },
  coach: { depth: 20, movetimeMs: 2500, multipv: 5 },
  review: { depth: 20, multipv: 2 }
}

/** Bundled builds, tried in this order unless `settings.engineBinary` already names one. */
const BINARIES: { binary: 'avx2' | 'popcnt'; file: string }[] = [
  { binary: 'avx2', file: 'stockfish-avx2.exe' },
  { binary: 'popcnt', file: 'stockfish-popcnt.exe' }
]

/** A build that answers neither `uciok` nor `readyok` in this window is considered broken. */
const PROBE_TIMEOUT_MS = 5000
const HASH_MB = 128
/** Recent deterministic analyses; notably shares the live score used by the board and coach. */
const ANALYSIS_CACHE_SIZE = 32
/** A search that never reports `bestmove` must not wedge the queue for good. */
const SEARCH_TIMEOUT_MS: Record<AnalysisProfile, number> = {
  live: 10_000,
  feedback: 10_000,
  'opponent-beginner': 10_000,
  'opponent-easy': 10_000,
  'opponent-medium': 10_000,
  'opponent-challenging': 10_000,
  'opponent-strong': 10_000,
  opponent: 10_000,
  'opponent-check': 10_000,
  comment: 10_000,
  coach: 60_000,
  review: 180_000
}

/** Carries a machine-readable code to the renderer through the IPC error contract. */
export class EngineError extends Error {
  constructor(
    readonly code: 'ENGINE_UNAVAILABLE' | 'ENGINE_STOPPED' | 'ENGINE_TIMEOUT' | 'ENGINE_CRASHED',
    message: string
  ) {
    super(message)
    this.name = 'EngineError'
  }
}

/** Named `AbortError` so callers can use the standard `err.name === 'AbortError'` check. */
export class EngineAbortError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AbortError'
  }
}

export interface EngineServiceDeps {
  threads?: number
  hashMb?: number
  settings: SettingsStore
  resourcePath(...s: string[]): string
  emit(channel: string, payload: unknown): void
  /** Test hook: run this executable instead of the bundled binaries. */
  override?: { exe: string; args: string[] }
  /** Test hook: shortens the handshake timeout. */
  probeTimeoutMs?: number
  /** Test hook: replaces the per-profile `bestmove` deadline. */
  searchTimeoutMs?: number
}

interface Job {
  fen: string
  profile: AnalysisProfile
  resolve(analysis: Analysis): void
  reject(error: Error): void
  settled: boolean
  lines: Map<number, InfoLine>
  timer: NodeJS.Timeout | null
  detachSignal: (() => void) | null
}

interface Waiter {
  token: string
  resolve(): void
  reject(error: Error): void
  timer: NodeJS.Timeout
}

/**
 * One Stockfish child process behind a serial analysis queue.
 *
 * Every `info`/`bestmove` line belongs to the request currently in flight: the next request is
 * dispatched only after the previous `bestmove` arrives, so a pre-empted search (`stop`) can
 * never have its output attributed to its successor.
 */
export class EngineService {
  private proc: ManagedProcess | null = null
  private current: EngineState = { available: false, binary: 'none', version: null, message: null }
  private starting: Promise<EngineState> | null = null
  private queue: Job[] = []
  private running: Job | null = null
  private waiters: Waiter[] = []
  private version: string | null = null
  private quitting = false
  private analysisCache = new Map<string, Analysis>()

  constructor(private readonly deps: EngineServiceDeps) {}

  /** True while the child process is up — used by shutdown assertions and the tray tooltip. */
  get alive(): boolean {
    return this.proc?.alive ?? false
  }

  state(): EngineState {
    return { ...this.current }
  }

  /**
   * Probes the bundled builds once and keeps the winner running. The outcome (including the
   * total failure, stored as `'none'`) is persisted in settings so the probe is not repeated at
   * every launch; clearing `settings.engineBinary` makes the next start probe again.
   */
  start(): Promise<EngineState> {
    if (this.starting) return this.starting
    this.starting = this.probeAll().catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      return this.setState({ available: false, binary: 'none', version: null, message })
    })
    return this.starting
  }

  private async probeAll(): Promise<EngineState> {
    const cached = this.deps.settings.get().engineBinary
    const override = this.deps.override

    // A failed probe is never remembered: antivirus scans, a busy machine or a missing download can
    // all make one launch fail, and the engine must come back on its own at the next start.
    const candidates = override
      ? [
          {
            binary: (cached === 'avx2' || cached === 'popcnt' ? cached : 'avx2') as
              'avx2' | 'popcnt',
            exe: override.exe,
            args: override.args
          }
        ]
      : BINARIES.slice()
          // The build chosen by a previous probe goes first; the others stay as a fallback.
          .sort((a, b) => Number(b.binary === cached) - Number(a.binary === cached))
          .map((entry) => ({
            binary: entry.binary,
            exe: this.deps.resourcePath('engine', entry.file),
            args: [] as string[]
          }))

    const failures: string[] = []
    for (const candidate of candidates) {
      if (!override && !existsSync(candidate.exe)) {
        failures.push(`${candidate.exe}: not found`)
        continue
      }
      const failure = await this.probe(candidate.exe, candidate.args)
      if (failure === null) {
        await this.persistBinary(candidate.binary)
        return this.setState({
          available: true,
          binary: candidate.binary,
          version: this.version,
          message: null
        })
      }
      failures.push(`${candidate.exe}: ${failure}`)
    }

    if (cached === 'none') await this.persistBinary(null)
    return this.setState({
      available: false,
      binary: 'none',
      version: null,
      message: `no usable Stockfish build — ${failures.join('; ')}`
    })
  }

  /** Starts one candidate and runs the UCI handshake. Returns `null` on success, else the reason. */
  private async probe(exe: string, args: string[]): Promise<string | null> {
    this.version = null
    this.quitting = false
    const proc = new ManagedProcess({
      name: 'stockfish',
      exe,
      args,
      // No automatic restart: a Stockfish that dies mid-analysis invalidates the request anyway.
      onLine: (line) => this.handleLine(line),
      onStderr: (chunk) => console.error('[engine]', chunk.trimEnd()),
      onExit: (code) => this.handleExit(proc, code)
    })
    this.proc = proc
    try {
      await proc.start()
    } catch (error) {
      this.proc = null
      return error instanceof Error ? error.message : String(error)
    }

    const timeout = this.deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS
    try {
      proc.write('uci\n')
      await this.waitFor('uciok', timeout)
      const threads = this.deps.threads ?? Math.min(4, Math.max(1, cpus().length - 2))
      proc.write(`setoption name Threads value ${threads}\n`)
      proc.write(`setoption name Hash value ${this.deps.hashMb ?? HASH_MB}\n`)
      proc.write('isready\n')
      await this.waitFor('readyok', timeout)
      return null
    } catch (error) {
      await proc.shutdown(200).catch(() => undefined)
      if (this.proc === proc) this.proc = null
      return error instanceof Error ? error.message : String(error)
    }
  }

  private waitFor(token: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((waiter) => waiter.timer !== timer)
        reject(new Error(`no ${token} within ${timeoutMs} ms`))
      }, timeoutMs)
      this.waiters.push({ token, resolve, reject, timer })
    })
  }

  private async persistBinary(binary: 'avx2' | 'popcnt' | null): Promise<void> {
    if (this.deps.settings.get().engineBinary === binary) return
    await this.deps.settings.save({ engineBinary: binary }).catch((error) => {
      console.error('[engine] could not persist the probe result:', error)
      return undefined
    })
  }

  private setState(state: EngineState): EngineState {
    this.current = state
    this.deps.emit('engine:state', this.state())
    return this.state()
  }

  /**
   * Queues one analysis. A new `live` request replaces any pending `live` one and stops the
   * running one (its promise rejects with an `AbortError`); `coach` and `review` requests are
   * never pre-empted, so a post-game analysis is not destroyed by the eval bar.
   */
  analyze(
    fen: string,
    profile: AnalysisProfile,
    opts?: { signal?: AbortSignal }
  ): Promise<Analysis> {
    if (!this.current.available || !this.proc || !this.proc.alive) {
      return Promise.reject(
        new EngineError(
          'ENGINE_UNAVAILABLE',
          this.current.message ?? 'the chess engine is not available'
        )
      )
    }
    if (opts?.signal?.aborted)
      return Promise.reject(new EngineAbortError('analysis aborted before it started'))

    const cached = this.analysisCache.get(this.cacheKey(fen, profile))
    if (cached) return Promise.resolve(cached)

    return new Promise<Analysis>((resolve, reject) => {
      const job: Job = {
        fen,
        profile,
        resolve,
        reject,
        settled: false,
        lines: new Map(),
        timer: null,
        detachSignal: null
      }

      const signal = opts?.signal
      if (signal) {
        const onAbort = (): void => this.abort(job)
        signal.addEventListener('abort', onAbort, { once: true })
        job.detachSignal = () => signal.removeEventListener('abort', onAbort)
      }

      if (profile === 'live') {
        for (const queued of this.queue.filter((entry) => entry.profile === 'live')) {
          this.remove(queued)
          this.settle(queued, new EngineAbortError('superseded by a newer live analysis'))
        }
        if (this.running && this.running.profile === 'live')
          this.preempt(this.running, 'superseded by a newer live analysis')
      }

      this.queue.push(job)
      this.pump()
    })
  }

  private pump(): void {
    if (this.running || this.queue.length === 0) return
    const proc = this.proc
    if (!proc || !proc.alive) {
      const job = this.queue.shift()
      if (job)
        this.settle(job, new EngineError('ENGINE_UNAVAILABLE', 'the chess engine is not running'))
      return
    }
    const job = this.queue.shift()!
    this.running = job

    const profile = PROFILES[job.profile]
    proc.write(`position fen ${job.fen}\n`)
    proc.write(`setoption name MultiPV value ${profile.multipv}\n`)
    const movetime = profile.movetimeMs === undefined ? '' : ` movetime ${profile.movetimeMs}`
    proc.write(`go depth ${profile.depth}${movetime}\n`)

    const deadline = this.deps.searchTimeoutMs ?? SEARCH_TIMEOUT_MS[job.profile]
    job.timer = setTimeout(() => this.handleSearchTimeout(job, deadline), deadline)
  }

  private handleLine(line: string): void {
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i]!
      if (line.trim() === waiter.token) {
        this.waiters.splice(i, 1)
        clearTimeout(waiter.timer)
        waiter.resolve()
        return
      }
    }
    if (this.version === null && line.startsWith('id name ')) {
      this.version = line.slice('id name '.length).trim() || null
      return
    }

    const job = this.running
    if (!job) return

    if (line.startsWith('bestmove')) {
      // The search is over for good: release the queue even if the job was already rejected.
      if (job.timer) clearTimeout(job.timer)
      this.running = null
      if (!job.settled) {
        job.settled = true
        job.detachSignal?.()
        const analysis = buildAnalysis(job, parseBestMove(line))
        this.cache(analysis, job.profile)
        job.resolve(analysis)
      }
      this.pump()
      return
    }

    const info = parseInfoLine(line)
    if (!info) return
    const previous = job.lines.get(info.multipv)
    // Keep the last line at the deepest depth reached for each MultiPV slot.
    if (!previous || info.depth >= previous.depth) job.lines.set(info.multipv, info)
  }

  private cacheKey(fen: string, profile: AnalysisProfile): string {
    return `${profile}\u0000${fen}`
  }

  private cache(analysis: Analysis, profile: AnalysisProfile): void {
    const key = this.cacheKey(analysis.fen, profile)
    this.analysisCache.delete(key)
    this.analysisCache.set(key, analysis)
    while (this.analysisCache.size > ANALYSIS_CACHE_SIZE) {
      const oldest = this.analysisCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.analysisCache.delete(oldest)
    }
  }

  private handleExit(proc: ManagedProcess, code: number | null): void {
    if (this.proc !== proc) return
    this.proc = null
    const waiters = this.waiters
    this.waiters = []
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error(`the engine exited with code ${code} during the handshake`))
    }
    if (this.quitting) return
    const error = new EngineError(
      'ENGINE_CRASHED',
      `the chess engine exited unexpectedly (code ${code})`
    )
    this.failAll(error)
    if (this.current.available) {
      this.setState({ ...this.current, available: false, message: error.message })
    }
  }

  /** Stops the search in flight and rejects its promise; the queue resumes on `bestmove`. */
  private preempt(job: Job, reason: string): void {
    this.settle(job, new EngineAbortError(reason))
    this.proc?.write('stop\n')
  }

  /**
   * An engine that owes us a `bestmove` and never sends it would wedge the queue for good: the
   * next request is only dispatched once the previous search reports. There is no safe way to
   * keep using it either — a late `bestmove` would be attributed to the wrong request — so the
   * process is torn down. A later `start()` probes again.
   */
  private handleSearchTimeout(job: Job, deadline: number): void {
    this.settle(job, new EngineError('ENGINE_TIMEOUT', `no bestmove within ${deadline} ms`))
    void this.terminate(
      `the chess engine stopped answering (no bestmove within ${deadline} ms)`
    ).catch(() => undefined)
  }

  private abort(job: Job): void {
    if (job.settled) return
    if (this.running === job) {
      this.preempt(job, 'analysis aborted by the caller')
      return
    }
    this.remove(job)
    this.settle(job, new EngineAbortError('analysis aborted by the caller'))
  }

  private remove(job: Job): void {
    const index = this.queue.indexOf(job)
    if (index >= 0) this.queue.splice(index, 1)
  }

  private settle(job: Job, error: Error): void {
    if (job.settled) return
    job.settled = true
    if (job.timer) clearTimeout(job.timer)
    job.timer = null
    job.detachSignal?.()
    job.reject(error)
  }

  private failAll(error: Error): void {
    const pending = this.queue
    this.queue = []
    const running = this.running
    this.running = null
    if (running) this.settle(running, error)
    for (const job of pending) this.settle(job, error)
  }

  /** `quit` first so Stockfish frees its hash table, then the hard kill of the process tree. */
  async shutdown(): Promise<void> {
    await this.terminate('the chess engine is shutting down', false)
  }

  /** Stops the child for good and fails everything still queued; idempotent. */
  private async terminate(message: string, emitState = true): Promise<void> {
    const proc = this.proc
    // No restart and no crash report: this exit is the one we asked for.
    this.quitting = true
    this.proc = null
    this.starting = null
    if (this.current.available) {
      const state: EngineState = { ...this.current, available: false, message }
      if (emitState) this.setState(state)
      else this.current = state
    }
    this.failAll(new EngineError('ENGINE_STOPPED', message))
    if (!proc) return
    proc.write('quit\n')
    await proc.shutdown(1000)
  }
}

function buildAnalysis(job: Job, bestMove: string | null): Analysis {
  const lines: EngineLine[] = [...job.lines.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, info]) => {
      const line: EngineLine = { move: info.pv[0]!, pv: info.pv, depth: info.depth }
      if (info.scoreCp !== undefined) line.scoreCp = info.scoreCp
      if (info.scoreMate !== undefined) line.scoreMate = info.scoreMate
      return line
    })
  const depth = lines.reduce((max, line) => Math.max(max, line.depth), 0)
  return { bestMove, lines, depth, fen: job.fen }
}
