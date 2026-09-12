// @ts-nocheck
/**
 * Fake Codex app-server.
 *
 * Speaks the same NDJSON contract as the real `codex app-server` (one JSON object per line,
 * **no `jsonrpc` field**) and produces shapes taken from the generated bindings in
 * `src/main/codex/protocol`. It never talks to OpenAI, so tests and `CHESSADVISOR_FAKE_CODEX=1`
 * development runs consume no quota.
 *
 * Transport-agnostic: `createFakeServer(io, options)` receives already-decoded messages through
 * `receive()` and pushes outgoing messages to `io.send()`. `test/fake-app-server.mjs` wires it to
 * stdin/stdout; unit tests can wire it to an in-memory pair.
 */

import { randomUUID } from 'node:crypto'
import { Chess } from 'chess.js'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const FAKE_USER_AGENT = 'fake/0.154.0'
/** Fixed instant so quota assertions stay deterministic: 2026-01-01T00:00:00Z. */
const FIXED_RESETS_AT = 1767225600
const DELTA_CHUNK_CHARS = 12

const MODEL_PAGES = [
  {
    nextCursor: 'p2',
    models: [
      {
        id: 'gpt-6-astra',
        displayName: 'GPT-6 Astra',
        description: 'Fake flagship model served by the ChessAdvisor test double.',
        defaultReasoningEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'],
        isDefault: true
      }
    ]
  },
  {
    nextCursor: null,
    models: [
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        description: 'Fake previous-generation model served by the ChessAdvisor test double.',
        defaultReasoningEffort: 'medium',
        efforts: ['low', 'medium', 'high', 'xhigh'],
        isDefault: false
      }
    ]
  }
]

function effortOption(effort) {
  return { reasoningEffort: effort, description: `Fake ${effort} reasoning effort.` }
}

function model(spec) {
  return {
    id: spec.id,
    model: spec.id,
    upgrade: null,
    upgradeInfo: null,
    availabilityNux: null,
    displayName: spec.displayName,
    description: spec.description,
    modelSpecialty: null,
    hidden: false,
    supportedReasoningEfforts: spec.efforts.map(effortOption),
    defaultReasoningEffort: spec.defaultReasoningEffort,
    inputModalities: ['text'],
    supportsPersonality: false,
    multiAgentVersion: null,
    additionalSpeedTiers: [],
    serviceTiers: [],
    defaultServiceTier: null,
    isDefault: spec.isDefault
  }
}

function rateLimitSnapshot() {
  return {
    limitId: 'codex',
    limitName: 'Codex',
    normalModelSlug: 'gpt-6-astra',
    primary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: FIXED_RESETS_AT },
    secondary: null,
    credits: null,
    individualLimit: null,
    spendControlReached: false,
    planType: 'prolite',
    rateLimitReachedType: null
  }
}

/** Text of the `input` array of a `turn/start`, concatenated. */
function inputText(params) {
  const input = Array.isArray(params?.input) ? params.input : []
  return input
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

function fenFrom(text) {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line.toUpperCase().startsWith('FEN:')) {
      const fen = line.slice(4).trim()
      if (fen) return fen
    }
  }
  return START_FEN
}

function forcedMoveFrom(text) {
  const match = /FAKE_FORCE_MOVE:\s*(\S+)/.exec(text)
  return match ? match[1] : null
}

function schemaProperties(params) {
  const schema = params?.outputSchema
  if (!schema || typeof schema !== 'object') return null
  const properties = schema.properties
  return properties && typeof properties === 'object' ? properties : {}
}

export function createFakeServer(io, options = {}) {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const random = options.random ?? Math.random
  const newId = options.newId ?? randomUUID
  const delayMs = options.delayMs ?? (() => 30 + Math.round(random() * 50))
  const schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms))

  const threads = new Map()
  const timers = new Set()
  let failOnceUsed = false
  let rateLimitsPushed = false
  let closed = false

  const loggedOut = env.FAKE_CODEX_LOGGED_OUT === '1'
  const toolItemEveryTurn = env.FAKE_CODEX_TOOL_ITEM === '1'
  const failOnce = env.FAKE_CODEX_FAIL_ONCE === '1'

  function send(message) {
    if (closed) return
    io.send(message)
  }

  function notify(method, params) {
    send({ method, params })
  }

  function later(fn, ms) {
    const timer = schedule(() => {
      timers.delete(timer)
      if (!closed) fn()
    }, ms)
    timer?.unref?.()
    timers.add(timer)
    return timer
  }

  function nowSeconds() {
    return Math.floor(Date.now() / 1000)
  }

  function makeThread(params) {
    const id = newId()
    const modelId = params?.model ?? MODEL_PAGES[0].models[0].id
    const thread = {
      id,
      sessionId: newId(),
      forkedFromId: null,
      parentThreadId: null,
      preview: '',
      ephemeral: params?.ephemeral === true,
      section: null,
      sectionEnteredAt: null,
      projectId: null,
      historyMode: 'persistent',
      modelProvider: 'openai',
      model: modelId,
      reasoningEffort: null,
      createdAt: nowSeconds(),
      updatedAt: nowSeconds(),
      recencyAt: nowSeconds(),
      status: 'idle',
      path: null,
      cwd: params?.cwd ?? cwd,
      cliVersion: '0.154.0',
      originator: 'chessadvisor',
      source: 'appServer',
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: []
    }
    threads.set(id, { thread, model: modelId, items: [], turnCount: 0, currentTurn: null })
    return threads.get(id)
  }

  function finalText(params, state) {
    const text = inputText(params)
    const properties = schemaProperties(params)
    if (properties && 'move' in properties) {
      const fen = fenFrom(text)
      const forced = forcedMoveFrom(text)
      const move = forced ?? randomLegalMove(fen)
      return JSON.stringify({ move, shortComment: 'fake' })
    }
    if (properties && 'accept' in properties) {
      return JSON.stringify({ accept: false, reason: 'fake' })
    }
    if (properties && 'takeaways' in properties) {
      return JSON.stringify({ takeaways: ['a', 'b', 'c'], summary: 'fake' })
    }
    return `Fake coach answer for ply ${state.turnCount}.`
  }

  function randomLegalMove(fen) {
    let chess
    try {
      chess = new Chess(fen)
    } catch {
      chess = new Chess(START_FEN)
    }
    const moves = chess.moves()
    if (moves.length === 0) return 'resign'
    return moves[Math.min(moves.length - 1, Math.floor(random() * moves.length))]
  }

  function turnPayload(run, extra) {
    return {
      id: run.turnId,
      items: extra?.items ?? [],
      itemsView: extra?.itemsView ?? 'full',
      status: extra?.status ?? 'inProgress',
      error: extra?.error ?? null,
      startedAt: run.startedAt,
      completedAt: extra?.completedAt ?? null,
      durationMs: extra?.durationMs ?? null
    }
  }

  function startTurn(state, params) {
    state.turnCount += 1
    const run = {
      turnId: newId(),
      threadId: state.thread.id,
      startedAt: nowSeconds(),
      startedAtMs: Date.now(),
      interrupted: false,
      finished: false
    }
    state.currentTurn = run

    const response = { turn: turnPayload(run) }
    later(() => {
      notify('turn/started', { threadId: state.thread.id, turn: turnPayload(run) })
      streamTurn(state, run, params)
    }, 0)
    return response
  }

  function completeTurn(state, run, { status, items, error }) {
    if (run.finished) return
    run.finished = true
    if (state.currentTurn === run) state.currentTurn = null
    notify('turn/completed', {
      threadId: state.thread.id,
      turn: turnPayload(run, {
        status,
        items: items ?? [],
        itemsView: 'full',
        error: error ?? null,
        completedAt: nowSeconds(),
        durationMs: Date.now() - run.startedAtMs
      })
    })
  }

  function streamTurn(state, run, params) {
    const text = finalText(params, state)
    const reasoningItemId = newId()
    const messageItemId = newId()
    const steps = []

    steps.push(() =>
      notify('item/reasoning/summaryTextDelta', {
        threadId: state.thread.id,
        turnId: run.turnId,
        itemId: reasoningItemId,
        delta: 'Fake reasoning ',
        summaryIndex: 0
      })
    )
    steps.push(() =>
      notify('item/reasoning/summaryTextDelta', {
        threadId: state.thread.id,
        turnId: run.turnId,
        itemId: reasoningItemId,
        delta: 'summary.',
        summaryIndex: 0
      })
    )

    for (let i = 0; i < text.length; i += DELTA_CHUNK_CHARS) {
      const delta = text.slice(i, i + DELTA_CHUNK_CHARS)
      steps.push(() =>
        notify('item/agentMessage/delta', {
          threadId: state.thread.id,
          turnId: run.turnId,
          itemId: messageItemId,
          delta
        })
      )
    }

    const reasoningItem = {
      type: 'reasoning',
      id: reasoningItemId,
      summary: ['Fake reasoning summary.'],
      content: []
    }
    const messageItem = {
      type: 'agentMessage',
      id: messageItemId,
      text,
      phase: 'final_answer',
      memoryCitation: null,
      delivery: null,
      questions: null
    }
    const toolItem = {
      type: 'commandExecution',
      id: newId(),
      pluginId: null,
      scriptPath: null,
      command: 'echo fake',
      cwd,
      processId: null,
      source: 'model',
      status: 'completed',
      commandActions: [],
      aggregatedOutput: 'fake\n',
      exitCode: 0,
      durationMs: 1
    }

    const emitted = [reasoningItem]
    steps.push(() => emitItem(state, run, reasoningItem))
    if (toolItemEveryTurn) {
      emitted.push(toolItem)
      steps.push(() => emitItem(state, run, toolItem))
    }

    const shouldFail = failOnce && !failOnceUsed
    if (shouldFail) failOnceUsed = true

    if (!shouldFail) {
      emitted.push(messageItem)
      steps.push(() => emitItem(state, run, messageItem))
    }

    steps.push(() => {
      if (shouldFail) {
        completeTurn(state, run, {
          status: 'failed',
          items: emitted,
          error: {
            message: 'fake failure',
            codexErrorInfo: null,
            additionalDetails: null,
            misalignment: null
          }
        })
        return
      }
      completeTurn(state, run, { status: 'completed', items: emitted })
    })

    let index = 0
    const runNext = () => {
      if (run.interrupted || run.finished) return
      const step = steps[index++]
      if (!step) return
      step()
      if (index < steps.length) later(runNext, 1)
    }
    later(runNext, delayMs())
  }

  function emitItem(state, run, item) {
    state.items.push({ turnId: run.turnId, item })
    notify('item/completed', {
      item,
      threadId: state.thread.id,
      turnId: run.turnId,
      completedAtMs: Date.now()
    })
  }

  const handlers = {
    initialize(_params) {
      if (!rateLimitsPushed) {
        rateLimitsPushed = true
        later(
          () =>
            notify('account/rateLimits/updated', {
              rateLimits: { primary: { usedPercent: 32 } }
            }),
          1
        )
      }
      return {
        userAgent: FAKE_USER_AGENT,
        codexHome: cwd,
        platformFamily: 'windows',
        platformOs: 'windows'
      }
    },
    'account/read'() {
      if (loggedOut) return { account: null, requiresOpenaiAuth: true }
      return {
        account: { type: 'chatgpt', email: 'fake@example.com', planType: 'prolite' },
        requiresOpenaiAuth: true
      }
    },
    'account/rateLimits/read'() {
      return {
        ordinaryUsageAllowed: true,
        rateLimits: rateLimitSnapshot(),
        rateLimitsByLimitId: { codex: rateLimitSnapshot() },
        rateLimitResetCredits: null,
        accountId: 'fake-account',
        rateLimitUpsell: null
      }
    },
    'model/list'(params) {
      const cursor = params?.cursor ?? null
      const page = cursor === null ? MODEL_PAGES[0] : MODEL_PAGES[1]
      return { data: page.models.map(model), nextCursor: page.nextCursor }
    },
    'hooks/list'() {
      return { data: [{ cwd, hooks: [], warnings: [], errors: [] }] }
    },
    'config/read'() {
      return {
        config: { plugins: {}, mcp_servers: {}, features: { hooks: false }, notify: [] },
        origins: {},
        layers: null
      }
    },
    'thread/start'(params) {
      const state = makeThread(params)
      later(() => notify('thread/started', { thread: state.thread }), 1)
      return {
        thread: state.thread,
        model: state.model,
        modelProvider: 'openai',
        serviceTier: null,
        cwd: state.thread.cwd,
        instructionSources: [],
        approvalPolicy: 'never',
        approvalsReviewer: 'none',
        sandbox: { type: 'readOnly', networkAccess: false },
        reasoningEffort: null
      }
    },
    'thread/unsubscribe'(params) {
      const state = threads.get(params?.threadId)
      return { status: state ? 'unsubscribed' : 'notLoaded' }
    },
    'thread/items/list'(params) {
      const state = threads.get(params?.threadId)
      if (!state) throw rpcFailure(`unknown thread ${params?.threadId}`)
      const turnId = params?.turnId ?? null
      const data = turnId === null ? state.items : state.items.filter((e) => e.turnId === turnId)
      return { data, nextCursor: null, backwardsCursor: null }
    },
    'turn/start'(params) {
      const state = threads.get(params?.threadId)
      if (!state) throw rpcFailure(`unknown thread ${params?.threadId}`)
      return startTurn(state, params)
    },
    'turn/interrupt'(params) {
      const state = threads.get(params?.threadId)
      const run = state?.currentTurn
      if (run && run.turnId === params?.turnId) {
        run.interrupted = true
        later(() => completeTurn(state, run, { status: 'interrupted', items: [] }), 1)
      }
      return {}
    }
  }

  function rpcFailure(message, code = -32602) {
    const error = new Error(message)
    error.rpcCode = code
    return error
  }

  function handleRequest(message) {
    const handler = handlers[message.method]
    if (!handler) {
      send({
        id: message.id,
        error: { code: -32601, message: `method not found: ${message.method}` }
      })
      return
    }
    try {
      const result = handler(message.params ?? {})
      send({ id: message.id, result: result === undefined ? {} : result })
    } catch (error) {
      send({
        id: message.id,
        error: { code: error?.rpcCode ?? -32000, message: error?.message ?? String(error) }
      })
    }
  }

  return {
    /** Feed one decoded incoming message (client request or notification). */
    receive(message) {
      if (closed || !message || typeof message !== 'object') return
      if (typeof message.method !== 'string') return
      if (message.id === undefined || message.id === null) return // client notification: ignored
      handleRequest(message)
    },
    close() {
      closed = true
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
    }
  }
}
