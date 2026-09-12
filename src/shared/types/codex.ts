/**
 * Types shared between the Codex service (main) and the renderer.
 *
 * They describe what the app needs from the `codex app-server` session: which models can be
 * played against, how much of the ChatGPT quota is left, whether the dedicated CODEX_HOME is
 * really isolated, and the outcome of a single turn.
 */

/** One playable model as shown in the new-game dialog and in Settings. */
export interface ModelInfo {
  id: string
  displayName: string
  description: string
  isDefault: boolean
  defaultEffort: string
  efforts: { id: string; description: string }[]
}

/** One quota window; `windowDurationMins`/`resetsAt` are 0 when the server does not report them. */
export interface QuotaWindow {
  usedPercent: number
  windowDurationMins: number
  resetsAt: number
}

/**
 * Snapshot of `account/rateLimits/read`, kept up to date by the sparse
 * `account/rateLimits/updated` notifications.
 */
export interface QuotaSnapshot {
  ordinaryUsageAllowed: boolean
  primary: QuotaWindow | null
  secondary: QuotaWindow | null
  rateLimitReachedType: string | null
  planType: string | null
}

/** Every state the Codex session can be in; the renderer renders one screen per status. */
export type CodexState =
  | { status: 'starting' }
  | { status: 'not-installed'; searched: string[] }
  | { status: 'not-authenticated' }
  | { status: 'not-isolated'; problems: string[] }
  | {
      status: 'ready'
      account: { email: string | null; planType: string }
      cliVersion: string
      versionMismatch: boolean
      models: ModelInfo[]
      quota: QuotaSnapshot | null
    }
  | { status: 'crashed'; message: string }

/** Why a thread exists; the registry keeps it so turns can be routed back to the right feature. */
export type ThreadRole = 'opponent' | 'coach' | 'training'

/** One turn request. `streamId` correlates the delta envelopes pushed to the renderer. */
export interface TurnRequest {
  threadId: string
  text: string
  model: string
  effort: string
  outputSchema?: object
  language: 'it' | 'en'
  timeoutMs?: number
  streamId: string
}

/**
 * Why a turn did not produce a usable final message.
 * - `failed` / `interrupted`: reported by `turn/completed`
 * - `timeout`: the client gave up and sent `turn/interrupt`
 * - `invalid-items`: the turn used a tool (never legitimate in an isolated environment)
 * - `no-message`: the turn completed without any `agentMessage`
 * - `quota`: `turn.error.codexErrorInfo` reports a usage or rate limit
 * - `server-request`: the server asked the client something (approval, elicitation): always denied
 */
export type TurnFailureReason =
  'failed' | 'interrupted' | 'timeout' | 'invalid-items' | 'no-message' | 'quota' | 'server-request'

export type TurnResult =
  | { ok: true; text: string; turnId: string; effectiveModel: string | null; durationMs: number }
  | { ok: false; reason: TurnFailureReason; message: string; turnId: string | null }
