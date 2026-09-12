/**
 * Minimal request/response client for the Codex app-server.
 *
 * The app-server does NOT speak JSON-RPC 2.0: messages carry no `jsonrpc` field, so no
 * generic JSON-RPC library is used. Framing rules (spec §3.1):
 * - outgoing request    `{ id, method, params? }`
 * - outgoing notification `{ method, params? }`
 * - incoming response   `{ id, result }` or `{ id, error: { code, message, data? } }`
 * - incoming notification `{ method, params }` (no `id`)
 * - incoming server request `{ id, method, params }` — answered with `{ id, result }` or
 *   `{ id, error: { code: -32000, message } }`
 */

export type RpcMessage = {
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/**
 * Byte sink/source for the client. `write` receives a complete line, newline included, so a
 * transport backed by a child process can forward it to stdin verbatim.
 */
export interface RpcTransport {
  write(line: string): boolean
  onLine(cb: (line: string) => void): void
}

export interface RpcClientOptions {
  onNotification(method: string, params: unknown): void
  /** Resolves the response payload, or throws to answer with an error. */
  onServerRequest(method: string, params: unknown): Promise<unknown>
  /** Default per-request deadline; overridable per call. Defaults to 30 s. */
  requestTimeoutMs?: number
}

export class RpcError extends Error {
  constructor(
    readonly code: number | 'TIMEOUT' | 'CLOSED',
    message: string,
    readonly method: string
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

const SERVER_REQUEST_ERROR_CODE = -32000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

interface Pending {
  method: string
  resolve(value: unknown): void
  reject(error: RpcError): void
  timer: ReturnType<typeof setTimeout> | null
}

export class RpcClient {
  private readonly pending = new Map<number | string, Pending>()
  private readonly requestTimeoutMs: number
  private nextId = 1
  private closed = false

  constructor(
    private readonly transport: RpcTransport,
    private readonly opts: RpcClientOptions
  ) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.transport.onLine((line) => this.handleLine(line))
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new RpcError('CLOSED', 'rpc client is closed', method))
    }
    const id = this.nextId++
    const message: RpcMessage = { id, method }
    if (params !== undefined) message.params = params

    return new Promise<T>((resolve, reject) => {
      const deadline = timeoutMs ?? this.requestTimeoutMs
      let timer: ReturnType<typeof setTimeout> | null = null
      if (deadline > 0 && Number.isFinite(deadline)) {
        timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new RpcError('TIMEOUT', `${method} timed out after ${deadline} ms`, method))
        }, deadline)
        timer.unref?.()
      }
      this.pending.set(id, {
        method,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })
      if (!this.send(message)) {
        this.settleReject(id, new RpcError('CLOSED', 'transport refused the write', method))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) return
    const message: RpcMessage = { method }
    if (params !== undefined) message.params = params
    this.send(message)
  }

  close(reason: string): void {
    if (this.closed) return
    this.closed = true
    const pending = [...this.pending.entries()]
    this.pending.clear()
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer)
      entry.reject(new RpcError('CLOSED', reason, entry.method))
    }
  }

  private send(message: RpcMessage): boolean {
    return this.transport.write(`${JSON.stringify(message)}\n`)
  }

  private settleReject(id: number | string, error: RpcError): void {
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (entry.timer) clearTimeout(entry.timer)
    entry.reject(error)
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) return
    this.handleMessage(message as RpcMessage)
  }

  private handleMessage(message: RpcMessage): void {
    const hasId = message.id !== undefined && message.id !== null
    const hasMethod = typeof message.method === 'string'

    if (hasId && !hasMethod) {
      const entry = this.pending.get(message.id!)
      if (!entry) return
      this.pending.delete(message.id!)
      if (entry.timer) clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(new RpcError(message.error.code, message.error.message, entry.method))
      } else {
        entry.resolve(message.result)
      }
      return
    }

    if (hasMethod && !hasId) {
      this.opts.onNotification(message.method!, message.params)
      return
    }

    if (hasMethod && hasId) {
      void this.answerServerRequest(message.id!, message.method!, message.params)
    }
  }

  private async answerServerRequest(
    id: number | string,
    method: string,
    params: unknown
  ): Promise<void> {
    try {
      const result = await this.opts.onServerRequest(method, params)
      if (this.closed) return
      this.send({ id, result: result === undefined ? null : result })
    } catch (error) {
      if (this.closed) return
      const message = error instanceof Error ? error.message : String(error)
      this.send({ id, error: { code: SERVER_REQUEST_ERROR_CODE, message } })
    }
  }
}
