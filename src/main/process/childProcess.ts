import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

const MAX_LINE_BYTES = 8 * 1024 * 1024
const LF = 0x0a

export interface ManagedProcessOptions {
  name: string
  exe: string
  args: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
  restart?: { maxAttempts: number; backoffMs: number[] }
  onLine?(line: string): void
  onStderr?(chunk: string): void
  onExit?(code: number | null, restarting: boolean): void
}

/**
 * One long-lived child process (codex app-server, Stockfish) owned by the main process:
 * always `shell:false` with an argv array and a hidden window, line-oriented stdout,
 * bounded restarts on an unexpected exit and a hard kill of the whole tree on shutdown.
 */
export class ManagedProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdout: Buffer = Buffer.alloc(0)
  /** Set while a line above the size limit is being discarded up to its terminator. */
  private dropping = false
  private quitting = false
  private attempt = 0
  private restartTimer: NodeJS.Timeout | null = null
  private exitWaiters: Array<() => void> = []

  constructor(private readonly opts: ManagedProcessOptions) {}

  get pid(): number | undefined {
    return this.child?.pid
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && this.child.signalCode === null
  }

  /** Spawns the child; rejects if the executable cannot be started. */
  start(): Promise<void> {
    if (this.alive) return Promise.resolve()
    this.quitting = false
    this.stdout = Buffer.alloc(0)
    this.dropping = false
    return new Promise<void>((resolve, reject) => {
      let settled = false
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(this.opts.exe, this.opts.args, {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.opts.env ?? process.env,
          cwd: this.opts.cwd
        })
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      this.child = child

      child.stdout.on('data', (chunk: Buffer) => this.consume(chunk))
      child.stderr.on('data', (chunk: Buffer) => this.opts.onStderr?.(chunk.toString('utf8')))
      child.stdin.on('error', () => {
        /* the child may close stdin before we do; writes report false on their own */
      })

      child.once('error', (error) => {
        if (settled) return
        settled = true
        this.child = null
        reject(error)
      })
      child.once('spawn', () => {
        if (settled) return
        settled = true
        this.attemptReset()
        resolve()
      })
      child.once('exit', (code) => this.handleExit(child, code))
    })
  }

  write(text: string): boolean {
    const child = this.child
    if (!child || !this.alive || child.stdin.destroyed || !child.stdin.writable) return false
    try {
      return child.stdin.write(text)
    } catch {
      return false
    }
  }

  /** Stops the child for good: no restart, stdin closed, then a forced kill of the tree. */
  async shutdown(graceMs = 1500): Promise<void> {
    this.quitting = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const child = this.child
    if (!child || !this.alive) {
      this.child = null
      return
    }
    const exited = this.waitForExit()
    try {
      child.stdin.end()
    } catch {
      /* already closed */
    }
    const timedOut = await Promise.race([exited.then(() => false), delay(graceMs).then(() => true)])
    if (!timedOut) return
    this.kill(child)
    await Promise.race([exited, delay(1000)])
  }

  private kill(child: ChildProcessWithoutNullStreams): void {
    const pid = child.pid
    if (pid === undefined) return
    if (process.platform === 'win32') {
      try {
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' }).unref()
        return
      } catch {
        /* fall through to SIGKILL */
      }
    }
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }

  private waitForExit(): Promise<void> {
    if (!this.alive) return Promise.resolve()
    return new Promise<void>((resolve) => {
      this.exitWaiters.push(resolve)
    })
  }

  private attemptReset(): void {
    this.attempt = 0
  }

  private handleExit(child: ChildProcessWithoutNullStreams, code: number | null): void {
    if (this.child !== child) return
    this.child = null
    this.stdout = Buffer.alloc(0)
    this.dropping = false
    const waiters = this.exitWaiters
    this.exitWaiters = []
    for (const waiter of waiters) waiter()

    const restart = this.opts.restart
    const canRestart = !this.quitting && restart !== undefined && this.attempt < restart.maxAttempts
    this.opts.onExit?.(code, canRestart)
    if (!canRestart || !restart) return

    const backoff = restart.backoffMs[this.attempt] ?? restart.backoffMs[restart.backoffMs.length - 1] ?? 0
    this.attempt += 1
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.quitting) return
      const attempt = this.attempt
      // start() resets the counter on a successful spawn, so keep it across the call.
      void this.start()
        .then(() => {
          this.attempt = attempt
        })
        .catch((error) => {
          console.error(`[${this.opts.name}] restart failed:`, error)
          this.opts.onExit?.(null, false)
        })
    }, backoff)
  }

  /** Splits stdout into lines, tolerating CRLF and chunks that cut a line in half. */
  private consume(chunk: Buffer): void {
    this.stdout = this.stdout.length === 0 ? chunk : Buffer.concat([this.stdout, chunk])
    for (;;) {
      const index = this.stdout.indexOf(LF)
      if (index < 0) break
      const raw = this.stdout.subarray(0, index)
      this.stdout = this.stdout.subarray(index + 1)
      if (this.dropping) {
        this.dropping = false
        continue
      }
      if (raw.length > MAX_LINE_BYTES) {
        console.error(`[${this.opts.name}] dropped an output line larger than ${MAX_LINE_BYTES} bytes`)
        continue
      }
      const line = stripCr(raw).toString('utf8')
      if (line.length === 0) continue
      try {
        this.opts.onLine?.(line)
      } catch (error) {
        console.error(`[${this.opts.name}] line handler failed:`, error)
      }
    }
    if (this.stdout.length <= MAX_LINE_BYTES) return
    console.error(`[${this.opts.name}] dropped an output line larger than ${MAX_LINE_BYTES} bytes`)
    this.stdout = Buffer.alloc(0)
    this.dropping = true
  }
}

const stripCr = (buffer: Buffer): Buffer => (buffer.length > 0 && buffer[buffer.length - 1] === 0x0d ? buffer.subarray(0, buffer.length - 1) : buffer)

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
