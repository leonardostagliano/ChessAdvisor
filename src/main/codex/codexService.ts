import type {
  CodexState,
  ModelInfo,
  QuotaSnapshot,
  ThreadRole,
  TurnRequest,
  TurnResult
} from '@shared/types/codex'
import pkg from '../../../package.json'
import { ManagedProcess } from '../process/childProcess'
import type { SettingsStore } from '../store/settingsStore'
import { ensureCodexHome, resetAuth, syncAuth } from './codexHome'
import { TESTED_CODEX_VERSION } from './protocolVersion'
import { mergeQuotaPatch, quotaFromRead } from './quota'
import { appServerCommand, codexVersion, findCodexExe } from './resolveCodex'
import { RpcClient, type RpcTransport } from './rpcClient'
import { SERVER_REQUEST_METHOD, type NotificationBus, runTurn } from './turnRunner'

/**
 * The single owner of the `codex app-server` child process.
 *
 * It resolves the CLI, boots it inside the dedicated CODEX_HOME, proves the environment really is
 * isolated (no plugins, no MCP servers, no hooks, no instruction files), then exposes what the app
 * needs: the account, the model catalogue, the quota, and one thread per role with a turn runner
 * on top. Everything that can go wrong ends in a {@link CodexState} the renderer can render; no
 * caller ever sees a raw protocol error.
 */

const APP_VERSION: string = pkg.version
/**
 * Written into the dedicated `config.toml` before the model catalogue is known. It is only the
 * app-server's own default: every thread and every turn passes its model explicitly.
 */
const FALLBACK_CONFIG_MODEL = 'gpt-5.1-codex'
const REQUEST_TIMEOUT_MS = 30_000
/** Restart budget of spec §3.1: 1 s, 2 s, then 5 s, five attempts, then the crashed state. */
const RESTART_BACKOFF_MS = [1000, 2000, 5000, 5000, 5000]
const STDERR_RING_BYTES = 64 * 1024
const MAX_MODEL_PAGES = 20

export interface CodexServiceDeps {
  settings: SettingsStore
  /** Dedicated CODEX_HOME (`userData/codex-home`). */
  codexHomeDir: string
  /** The user's own CODEX_HOME, the source of `auth.json`. */
  userHome: string
  emit(channel: string, payload: unknown): void
  /** Replaces the real CLI with the fake app-server (tests, `CHESSADVISOR_FAKE_CODEX=1`). */
  fake?: { exe: string; args: string[] }
  /** `cwd` of the game threads; defaults to the dedicated CODEX_HOME. */
  dataDir?: string
  /** Base environment of the child process; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

export interface StartThreadOptions {
  model: string
  baseInstructions: string
  gameId?: string
}

interface ThreadEntry {
  role: ThreadRole
  gameId?: string
  currentTurnId: string | null
  effectiveModel: string | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Params = any

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const hasEntries = (value: unknown): boolean => isRecord(value) && Object.keys(value).length > 0

function parseVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /(\d+\.\d+\.\d+)/.exec(value)
  return match ? match[1]! : null
}

function toModelInfo(raw: Params): ModelInfo | null {
  if (!isRecord(raw) || typeof raw.id !== 'string') return null
  const efforts = Array.isArray(raw.supportedReasoningEfforts)
    ? raw.supportedReasoningEfforts
        .filter((option: Params) => typeof option?.reasoningEffort === 'string')
        .map((option: Params) => ({
          id: option.reasoningEffort as string,
          description: typeof option.description === 'string' ? option.description : ''
        }))
    : []
  const defaultEffort =
    typeof raw.defaultReasoningEffort === 'string'
      ? raw.defaultReasoningEffort
      : (efforts[0]?.id ?? '')
  return {
    id: raw.id,
    displayName: typeof raw.displayName === 'string' ? raw.displayName : raw.id,
    description: typeof raw.description === 'string' ? raw.description : '',
    isDefault: raw.isDefault === true,
    defaultEffort,
    efforts
  }
}

function toAccount(raw: Params): { email: string | null; planType: string } | null {
  if (!isRecord(raw) || typeof raw.type !== 'string') return null
  if (raw.type === 'chatgpt') {
    return {
      email: typeof raw.email === 'string' ? raw.email : null,
      planType: typeof raw.planType === 'string' ? raw.planType : 'unknown'
    }
  }
  return { email: null, planType: raw.type }
}

export class CodexService {
  private readonly threads = new Map<string, ThreadEntry>()
  private readonly listeners = new Map<string, Set<(params: Params) => void>>()
  private readonly bus: NotificationBus = {
    on: (method, cb) => {
      const set = this.listeners.get(method) ?? new Set()
      set.add(cb)
      this.listeners.set(method, set)
      return () => {
        set.delete(cb)
      }
    }
  }

  private current: CodexState = { status: 'starting' }
  private proc: ManagedProcess | null = null
  private rpc: RpcClient | null = null
  private lineListener: ((line: string) => void) | null = null
  private stderrRing = ''
  private restartAttempt = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private stopping = false
  private booting: Promise<void> | null = null
  private isolationChecked = false
  private modelCatalogue: ModelInfo[] = []
  private quotaSnapshot: QuotaSnapshot | null = null

  constructor(private readonly deps: CodexServiceDeps) {}

  private get env(): NodeJS.ProcessEnv {
    return this.deps.env ?? process.env
  }

  state(): CodexState {
    return this.current
  }

  models(): ModelInfo[] {
    return this.modelCatalogue
  }

  quota(): QuotaSnapshot | null {
    return this.quotaSnapshot
  }

  /** Boots the app-server and runs the whole handshake; never rejects on an expected failure. */
  start(): Promise<void> {
    if (this.booting) return this.booting
    this.stopping = false
    this.booting = this.boot().finally(() => {
      this.booting = null
    })
    return this.booting
  }

  /** Manual "Riprova" from the Codex status screen. */
  async retry(): Promise<void> {
    if (this.current.status === 'ready') return
    this.restartAttempt = 0
    await this.start()
  }

  async startThread(role: ThreadRole, opts: StartThreadOptions): Promise<string> {
    const rpc = this.requireReady()
    const response = await rpc.request<Params>('thread/start', {
      model: opts.model,
      baseInstructions: opts.baseInstructions,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      cwd: this.deps.dataDir ?? this.deps.codexHomeDir
    })
    const id = response?.thread?.id
    if (typeof id !== 'string') throw new Error('thread/start returned no thread id')

    // The first thread is the last isolation probe: base instructions must replace everything.
    if (!this.isolationChecked) {
      this.isolationChecked = true
      const sources: unknown[] = Array.isArray(response?.instructionSources)
        ? response.instructionSources
        : []
      if (sources.length > 0) {
        this.setState({
          status: 'not-isolated',
          problems: [
            `thread/start loaded ${sources.length} instruction source(s): ${sources.join(', ')}`
          ]
        })
        await rpc.request('thread/unsubscribe', { threadId: id }).catch(() => undefined)
        throw new Error('the Codex environment is not isolated')
      }
    }

    this.threads.set(id, {
      role,
      gameId: opts.gameId,
      currentTurnId: null,
      effectiveModel: null
    })
    return id
  }

  /**
   * Runs one turn on a registered thread, forwarding the live deltas both to the caller and to the
   * renderer as `stream` envelopes.
   */
  async runTurn(
    req: TurnRequest,
    onDelta?: (kind: 'text' | 'reasoning', delta: string) => void
  ): Promise<TurnResult> {
    const rpc = this.rpc
    if (!rpc || this.current.status !== 'ready') {
      return {
        ok: false,
        reason: 'failed',
        message: 'the Codex session is not ready',
        turnId: null
      }
    }
    const entry = this.threads.get(req.threadId)
    if (!entry) {
      return {
        ok: false,
        reason: 'failed',
        message: `unknown thread ${req.threadId}`,
        turnId: null
      }
    }
    entry.effectiveModel = null

    const forward = (kind: 'text' | 'reasoning') => (params: Params) => {
      if (params?.threadId !== req.threadId) return
      if (entry.currentTurnId !== null && params?.turnId !== entry.currentTurnId) return
      if (typeof params?.delta !== 'string') return
      this.deps.emit('stream', {
        streamId: req.streamId,
        threadId: req.threadId,
        turnId: typeof params.turnId === 'string' ? params.turnId : '',
        itemId: typeof params.itemId === 'string' ? params.itemId : '',
        kind,
        chunk: params.delta
      })
    }
    const unsubscribe = [
      this.bus.on('item/agentMessage/delta', forward('text')),
      this.bus.on('item/reasoning/summaryTextDelta', forward('reasoning'))
    ]

    try {
      const result = await runTurn(
        rpc,
        this.bus,
        req,
        { onDelta: (kind, _itemId, delta) => onDelta?.(kind, delta) },
        { itemsList: (threadId, turnId) => this.itemsList(threadId, turnId) }
      )
      if (result.ok && result.effectiveModel === null && entry.effectiveModel !== null) {
        return { ...result, effectiveModel: entry.effectiveModel }
      }
      return result
    } finally {
      entry.currentTurnId = null
      for (const off of unsubscribe) off()
    }
  }

  /** Stops the turn currently running on a thread, if any. */
  async interrupt(threadId: string): Promise<void> {
    const turnId = this.threads.get(threadId)?.currentTurnId
    if (!this.rpc || !turnId) return
    await this.rpc.request('turn/interrupt', { threadId, turnId }).catch((error) => {
      console.error('[codex] turn/interrupt failed:', error)
    })
  }

  /** Ends a thread at the end of a game; ephemeral threads need no archiving. */
  async closeThread(threadId: string): Promise<void> {
    this.threads.delete(threadId)
    if (!this.rpc) return
    await this.rpc.request('thread/unsubscribe', { threadId }).catch((error) => {
      console.error('[codex] thread/unsubscribe failed:', error)
    })
  }

  async shutdown(): Promise<void> {
    this.stopping = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    this.rpc?.close('ChessAdvisor is shutting down')
    this.rpc = null
    this.threads.clear()
    const proc = this.proc
    this.proc = null
    await proc?.shutdown()
  }

  // ---------------------------------------------------------------- internals

  private requireReady(): RpcClient {
    if (!this.rpc || this.current.status !== 'ready') {
      throw new Error(`the Codex session is not ready (${this.current.status})`)
    }
    return this.rpc
  }

  private setState(next: CodexState): void {
    this.current = next
    this.deps.emit('codex:state', next)
  }

  private async boot(): Promise<void> {
    this.setState({ status: 'starting' })
    this.isolationChecked = false
    await this.disposeProcess()

    let command: { exe: string; args: string[]; windowsVerbatimArguments: boolean }
    let cliVersion: string | null = null
    if (this.deps.fake) {
      command = {
        exe: this.deps.fake.exe,
        args: this.deps.fake.args,
        windowsVerbatimArguments: false
      }
    } else {
      const location = findCodexExe(this.env)
      if (location.exe === null) {
        this.setState({ status: 'not-installed', searched: location.searched })
        return
      }
      cliVersion = await codexVersion(location.exe)
      if (cliVersion === null) {
        // The file exists but cannot be run: same dead end as a missing installation (spec §8).
        this.setState({ status: 'not-installed', searched: [location.exe] })
        return
      }
      command = appServerCommand(location)
    }

    const configModel = this.deps.settings.get().defaultModel ?? FALLBACK_CONFIG_MODEL
    try {
      await ensureCodexHome(this.deps.codexHomeDir, configModel)
      await syncAuth(this.deps.codexHomeDir, this.deps.userHome)
    } catch (error) {
      this.setState({ status: 'crashed', message: this.describe(error) })
      return
    }

    try {
      await this.spawn(command)
    } catch (error) {
      this.setState({ status: 'crashed', message: this.describe(error) })
      return
    }
    await this.handshake(cliVersion)
  }

  private async spawn(command: {
    exe: string
    args: string[]
    windowsVerbatimArguments: boolean
  }): Promise<void> {
    const proc: ManagedProcess = new ManagedProcess({
      name: 'codex',
      exe: command.exe,
      args: command.args,
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      // The dedicated home is the whole point: never let the app-server read the user's own one.
      env: { ...this.env, CODEX_HOME: this.deps.codexHomeDir },
      cwd: this.deps.codexHomeDir,
      onLine: (line) => this.lineListener?.(line),
      onStderr: (chunk) => this.recordStderr(chunk),
      onExit: (code) => this.handleExit(proc, code)
    })
    this.proc = proc
    await proc.start()

    const transport: RpcTransport = {
      write: (line) => proc.write(line),
      onLine: (cb) => {
        this.lineListener = cb
      }
    }
    this.rpc = new RpcClient(transport, {
      onNotification: (method, params) => this.onNotification(method, params),
      onServerRequest: (method, params) => this.onServerRequest(method, params),
      requestTimeoutMs: REQUEST_TIMEOUT_MS
    })
  }

  private async handshake(cliVersionFromExe: string | null): Promise<void> {
    const rpc = this.rpc
    if (!rpc) return
    try {
      const initialized = await rpc.request<Params>('initialize', {
        clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: APP_VERSION },
        capabilities: null
      })
      rpc.notify('initialized')
      const cliVersion = cliVersionFromExe ?? parseVersion(initialized?.userAgent) ?? 'unknown'

      const problems = await this.isolationProblems(rpc)
      if (problems.length > 0) {
        this.setState({ status: 'not-isolated', problems })
        return
      }

      const account = await this.readAccount(rpc)
      if (!account) {
        this.setState({ status: 'not-authenticated' })
        return
      }

      this.modelCatalogue = await this.readModels(rpc)
      const rateLimits = await rpc.request<Params>('account/rateLimits/read').catch((error) => {
        console.error('[codex] account/rateLimits/read failed:', error)
        return null
      })
      this.quotaSnapshot = quotaFromRead(rateLimits)

      this.restartAttempt = 0
      this.setState({
        status: 'ready',
        account,
        cliVersion,
        versionMismatch: cliVersion !== TESTED_CODEX_VERSION,
        models: this.modelCatalogue,
        quota: this.quotaSnapshot
      })
    } catch (error) {
      this.setState({ status: 'crashed', message: this.describe(error) })
    }
  }

  /** Every check of spec §3.1 "Verifica dell'isolamento" except the `thread/start` one. */
  private async isolationProblems(rpc: RpcClient): Promise<string[]> {
    const problems: string[] = []
    const config = await rpc.request<Params>('config/read', {}).catch((error) => {
      problems.push(`config/read failed: ${this.describe(error)}`)
      return null
    })
    if (config) {
      const values = isRecord(config.config) ? config.config : {}
      if (hasEntries(values.plugins)) problems.push('config.plugins is not empty')
      if (hasEntries(values.mcp_servers)) problems.push('config.mcp_servers is not empty')
      if (isRecord(values.features) && values.features.hooks === true) {
        problems.push('config.features.hooks is enabled')
      }
    }

    const hooks = await rpc.request<Params>('hooks/list', {}).catch((error) => {
      problems.push(`hooks/list failed: ${this.describe(error)}`)
      return null
    })
    if (hooks) {
      const entries: Params[] = Array.isArray(hooks.data) ? hooks.data : []
      const count = entries.reduce(
        (total: number, entry: Params) =>
          total + (Array.isArray(entry?.hooks) ? entry.hooks.length : 0),
        0
      )
      if (count > 0) problems.push(`hooks/list returned ${count} hook(s)`)
    }
    return problems
  }

  private async readAccount(
    rpc: RpcClient
  ): Promise<{ email: string | null; planType: string } | null> {
    const read = async (): Promise<Params> => rpc.request<Params>('account/read', {})
    let response = await read()
    if (!response?.account) {
      // The copy may be stale or broken: start again from the user's own auth.json, once.
      await resetAuth(this.deps.codexHomeDir).catch(() => undefined)
      const synced = await syncAuth(this.deps.codexHomeDir, this.deps.userHome).catch(
        () => 'missing'
      )
      if (synced === 'copied') response = await read()
    }
    return response?.account ? toAccount(response.account) : null
  }

  private async readModels(rpc: RpcClient): Promise<ModelInfo[]> {
    const models: ModelInfo[] = []
    let cursor: string | null = null
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const response = await rpc.request<Params>('model/list', { cursor, includeHidden: false })
      for (const raw of Array.isArray(response?.data) ? response.data : []) {
        const model = toModelInfo(raw)
        if (model) models.push(model)
      }
      cursor = typeof response?.nextCursor === 'string' ? response.nextCursor : null
      if (cursor === null) break
    }
    return models
  }

  private async itemsList(threadId: string, turnId: string): Promise<unknown[]> {
    const rpc = this.rpc
    if (!rpc) return []
    const response = await rpc.request<Params>('thread/items/list', { threadId, turnId })
    return Array.isArray(response?.data) ? response.data : []
  }

  private onNotification(method: string, params: Params): void {
    switch (method) {
      case 'turn/started': {
        const entry = this.threads.get(params?.threadId)
        if (entry && typeof params?.turn?.id === 'string') entry.currentTurnId = params.turn.id
        break
      }
      case 'model/rerouted': {
        const entry = this.threads.get(params?.threadId)
        if (entry && typeof params?.toModel === 'string') entry.effectiveModel = params.toModel
        break
      }
      case 'account/rateLimits/updated': {
        this.quotaSnapshot = mergeQuotaPatch(this.quotaSnapshot, params)
        if (this.current.status === 'ready') {
          this.setState({ ...this.current, quota: this.quotaSnapshot })
        }
        break
      }
      default:
        break
    }
    this.emitNotification(method, params)
  }

  /**
   * Approvals, elicitations and user-input requests are always denied: in an isolated environment
   * they cannot happen, and if they do the turn they belong to is void (spec §3.1).
   */
  private async onServerRequest(method: string, params: Params): Promise<never> {
    console.error(
      '[codex] denied a server request:',
      method,
      JSON.stringify(params ?? null).slice(0, 500)
    )
    const threadId = typeof params?.threadId === 'string' ? params.threadId : undefined
    this.emitNotification(SERVER_REQUEST_METHOD, { threadId, method })
    throw new Error('denied by ChessAdvisor')
  }

  private emitNotification(method: string, params: Params): void {
    for (const cb of [...(this.listeners.get(method) ?? [])]) {
      try {
        cb(params)
      } catch (error) {
        console.error(`[codex] notification handler for ${method} failed:`, error)
      }
    }
  }

  private recordStderr(chunk: string): void {
    this.stderrRing = `${this.stderrRing}${chunk}`.slice(-STDERR_RING_BYTES)
  }

  private describe(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    const tail = this.stderrRing.trim().slice(-500)
    return tail.length > 0 ? `${message}\n${tail}` : message
  }

  private async disposeProcess(): Promise<void> {
    const proc = this.proc
    this.proc = null
    this.lineListener = null
    this.rpc?.close('the codex app-server is being restarted')
    this.rpc = null
    this.threads.clear()
    await proc?.shutdown(500)
  }

  /**
   * Bounded restarts with the handshake redone from scratch: after a restart the old thread ids
   * mean nothing, so the registry is dropped and the game layer recreates its threads from the PGN.
   */
  private handleExit(proc: ManagedProcess, code: number | null): void {
    if (this.proc !== proc) return
    this.proc = null
    this.rpc?.close('the codex app-server exited')
    this.rpc = null
    this.threads.clear()
    if (this.stopping) return

    this.restartAttempt += 1
    if (this.restartAttempt > RESTART_BACKOFF_MS.length) {
      this.setState({
        status: 'crashed',
        message: this.describe(new Error(`codex app-server exited (code ${code}) too many times`))
      })
      return
    }
    const wait = RESTART_BACKOFF_MS[this.restartAttempt - 1]!
    console.error(`[codex] app-server exited (code ${code}); restarting in ${wait} ms`)
    this.setState({ status: 'starting' })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.stopping) return
      void this.start().catch((error) => console.error('[codex] restart failed:', error))
    }, wait)
    this.restartTimer.unref?.()
  }
}
