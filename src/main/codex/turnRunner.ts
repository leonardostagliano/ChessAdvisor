import type { TurnRequest, TurnResult } from '@shared/types/codex'
import type { RpcClient } from './rpcClient'

/**
 * One turn, from `turn/start` to the final assistant message.
 *
 * The rules come from spec §3.1 ("Estrazione del testo finale"): streaming deltas are a live
 * preview only, `item/completed` is the truth for a single item, and the final message is picked
 * from the items of `turn/completed` (fetched with `thread/items/list` when the turn payload is
 * only a summary). A turn that used a tool, that produced no assistant message, that failed, that
 * was interrupted or that timed out yields a typed failure instead of text: the caller decides
 * whether to retry or to fall back (opponent → Stockfish, coach → error card).
 */

/** Fan-out of the app-server notifications; {@link CodexService} feeds every one of them in. */
export interface NotificationBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(method: string, cb: (params: any) => void): () => void
}

export interface TurnEvents {
  onDelta(kind: 'text' | 'reasoning', itemId: string, delta: string): void
}

export interface TurnRunnerOptions {
  /** `thread/items/list` for this turn, used when `turn.itemsView !== 'full'`. */
  itemsList(threadId: string, turnId: string): Promise<unknown[]>
}

/**
 * Synthetic notification the service pushes on the bus when the app-server sends a client request
 * (approval, elicitation, user input). Those are always denied, and the turn they belong to is
 * void: in an isolated CODEX_HOME they should never happen at all.
 */
export const SERVER_REQUEST_METHOD = 'chessadvisor/serverRequest'

export const DEFAULT_TURN_TIMEOUT_MS = 180_000

/** A turn that touched any of these is not a chess answer, whatever text it produced. */
export const INVALID_ITEM_TYPES = [
  'commandExecution',
  'mcpToolCall',
  'dynamicToolCall',
  'webSearch',
  'collabAgentToolCall',
  'fileChange'
] as const

/** Appended to every turn text so a language change takes effect from the next turn. */
export function languageLine(language: 'it' | 'en'): string {
  return language === 'it' ? 'Rispondi in italiano.' : 'Answer in English.'
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Params = any

interface ThreadItemLike {
  type?: string
  id?: string
  text?: string
  phase?: string | null
}

type Outcome =
  { kind: 'completed'; turn: Params } | { kind: 'timeout' } | { kind: 'server-request' }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `thread/items/list` returns `{ turnId, item }` entries; `turn.items` returns bare items. */
function normalizeItems(items: unknown[]): ThreadItemLike[] {
  return items
    .map((entry) => {
      if (!isRecord(entry)) return null
      if (isRecord(entry.item)) return entry.item as ThreadItemLike
      return entry as ThreadItemLike
    })
    .filter((item): item is ThreadItemLike => item !== null)
}

function quotaRelated(codexErrorInfo: unknown): boolean {
  const text =
    typeof codexErrorInfo === 'string' ? codexErrorInfo : JSON.stringify(codexErrorInfo ?? '')
  return /usagelimit|ratelimit/i.test(text)
}

function pickFinalMessage(items: ThreadItemLike[]): ThreadItemLike | null {
  const messages = items.filter((item) => item.type === 'agentMessage')
  if (messages.length === 0) return null
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]!.phase === 'final_answer') return messages[i]!
  }
  return messages[messages.length - 1]!
}

export async function runTurn(
  rpc: RpcClient,
  bus: NotificationBus,
  req: TurnRequest,
  events: TurnEvents,
  opts: TurnRunnerOptions
): Promise<TurnResult> {
  const startedAt = Date.now()
  const buffers = new Map<string, string>()
  const queued: { method: string; params: Params }[] = []
  let turnId: string | null = null
  let effectiveModel: string | null = null
  let outcome: Outcome | null = null
  let resolveOutcome: ((value: Outcome) => void) | null = null

  const settle = (value: Outcome): void => {
    if (outcome) return
    outcome = value
    resolveOutcome?.(value)
  }

  const handle = (method: string, params: Params): void => {
    if (params?.threadId !== undefined && params.threadId !== req.threadId) return
    if (turnId === null) {
      // The response of `turn/start` has not arrived yet: keep the order and replay below.
      queued.push({ method, params })
      return
    }
    // Interrupted turns keep emitting for a while: anything from another turn is not ours.
    if (
      method !== SERVER_REQUEST_METHOD &&
      params?.turnId !== undefined &&
      params.turnId !== turnId
    ) {
      return
    }
    switch (method) {
      case 'item/agentMessage/delta': {
        if (typeof params?.delta !== 'string' || typeof params?.itemId !== 'string') return
        buffers.set(params.itemId, (buffers.get(params.itemId) ?? '') + params.delta)
        events.onDelta('text', params.itemId, params.delta)
        return
      }
      case 'item/reasoning/summaryTextDelta': {
        if (typeof params?.delta !== 'string' || typeof params?.itemId !== 'string') return
        events.onDelta('reasoning', params.itemId, params.delta)
        return
      }
      case 'item/completed': {
        const item = params?.item as ThreadItemLike | undefined
        if (item?.type === 'agentMessage' && typeof item.id === 'string') {
          buffers.set(
            item.id,
            typeof item.text === 'string' ? item.text : (buffers.get(item.id) ?? '')
          )
        }
        return
      }
      case 'model/rerouted': {
        if (typeof params?.toModel === 'string') effectiveModel = params.toModel
        return
      }
      case 'turn/completed': {
        if (params?.turn?.id !== turnId) return
        settle({ kind: 'completed', turn: params.turn })
        return
      }
      case SERVER_REQUEST_METHOD: {
        settle({ kind: 'server-request' })
        return
      }
    }
  }

  const methods = [
    'item/agentMessage/delta',
    'item/reasoning/summaryTextDelta',
    'item/completed',
    'model/rerouted',
    'turn/completed',
    SERVER_REQUEST_METHOD
  ]
  const unsubscribe = methods.map((method) =>
    bus.on(method, (params: Params) => handle(method, params))
  )
  const completion = new Promise<Outcome>((resolve) => {
    resolveOutcome = resolve
    if (outcome) resolve(outcome)
  })

  const params: Record<string, unknown> = {
    threadId: req.threadId,
    input: [
      { type: 'text', text: `${req.text}\n\n${languageLine(req.language)}`, text_elements: [] }
    ],
    model: req.model,
    effort: req.effort
  }
  if (req.outputSchema) params.outputSchema = req.outputSchema

  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    let started: { turn?: { id?: string } }
    try {
      started = await rpc.request<{ turn?: { id?: string } }>('turn/start', params)
    } catch (error) {
      return {
        ok: false,
        reason: 'failed',
        message: error instanceof Error ? error.message : String(error),
        turnId: null
      }
    }
    if (typeof started?.turn?.id !== 'string') {
      return {
        ok: false,
        reason: 'failed',
        message: 'turn/start returned no turn id',
        turnId: null
      }
    }
    turnId = started.turn.id
    for (const entry of queued.splice(0, queued.length)) handle(entry.method, entry.params)

    const timeoutMs = req.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs)
    timer.unref?.()

    const result = await completion

    if (result.kind === 'timeout' || result.kind === 'server-request') {
      // The turn is still running on the server: stop it before giving the caller a failure.
      await rpc.request('turn/interrupt', { threadId: req.threadId, turnId }).catch(() => undefined)
      return result.kind === 'timeout'
        ? { ok: false, reason: 'timeout', message: `turn timed out after ${timeoutMs} ms`, turnId }
        : {
            ok: false,
            reason: 'server-request',
            message: 'the app-server requested client input; the turn is void',
            turnId
          }
    }

    const turn = result.turn
    if (turn?.status !== 'completed') {
      const message =
        typeof turn?.error?.message === 'string' ? turn.error.message : `turn ${turn?.status}`
      if (turn?.status === 'interrupted') {
        return { ok: false, reason: 'interrupted', message, turnId }
      }
      const reason = quotaRelated(turn?.error?.codexErrorInfo) ? 'quota' : 'failed'
      return { ok: false, reason, message, turnId }
    }

    const rawItems: unknown[] =
      turn.itemsView === 'full'
        ? Array.isArray(turn.items)
          ? turn.items
          : []
        : await opts.itemsList(req.threadId, turnId).catch(() => [])
    const items = normalizeItems(rawItems)

    const invalid = items.find((item) =>
      (INVALID_ITEM_TYPES as readonly string[]).includes(item.type ?? '')
    )
    if (invalid) {
      return {
        ok: false,
        reason: 'invalid-items',
        message: `the turn used a tool (${invalid.type}), which never happens in an isolated environment`,
        turnId
      }
    }

    const message = pickFinalMessage(items)
    if (!message) {
      return {
        ok: false,
        reason: 'no-message',
        message: 'the turn produced no assistant message',
        turnId
      }
    }
    const text =
      typeof message.text === 'string' && message.text.length > 0
        ? message.text
        : (buffers.get(message.id ?? '') ?? '')

    return {
      ok: true,
      text,
      turnId,
      effectiveModel,
      durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : Date.now() - startedAt
    }
  } finally {
    if (timer) clearTimeout(timer)
    for (const off of unsubscribe) off()
  }
}
