import { describe, expect, it, vi } from 'vitest'
import type { TurnRequest } from '@shared/types/codex'
import { RpcClient, type RpcTransport } from './rpcClient'
import {
  SERVER_REQUEST_METHOD,
  type NotificationBus,
  type TurnEvents,
  languageLine,
  runTurn
} from './turnRunner'

const THREAD = 'thread-1'
const TURN = 'turn-1'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Params = any

interface Harness {
  rpc: RpcClient
  bus: NotificationBus
  sent: Params[]
  events: TurnEvents
  deltas: { kind: string; itemId: string; delta: string }[]
  emit(method: string, params: Params): void
  respond(method: string, result: unknown): Promise<void>
  request(method: string): Promise<Params>
}

function harness(): Harness {
  const sent: Params[] = []
  let feed: ((line: string) => void) | null = null
  const transport: RpcTransport = {
    write(line) {
      sent.push(JSON.parse(line))
      return true
    },
    onLine(cb) {
      feed = cb
    }
  }
  const rpc = new RpcClient(transport, {
    onNotification: () => undefined,
    onServerRequest: async () => {
      throw new Error('denied by ChessAdvisor')
    },
    requestTimeoutMs: 5000
  })

  const listeners = new Map<string, Set<(params: Params) => void>>()
  const bus: NotificationBus = {
    on(method, cb) {
      const set = listeners.get(method) ?? new Set()
      set.add(cb)
      listeners.set(method, set)
      return () => set.delete(cb)
    }
  }

  const deltas: { kind: string; itemId: string; delta: string }[] = []
  const events: TurnEvents = {
    onDelta: (kind, itemId, delta) => deltas.push({ kind, itemId, delta })
  }

  async function request(method: string): Promise<Params> {
    await vi.waitFor(() => {
      if (!sent.some((m) => m.method === method)) throw new Error(`no ${method} yet`)
    })
    return sent.find((m) => m.method === method)
  }

  return {
    rpc,
    bus,
    sent,
    events,
    deltas,
    emit(method, params) {
      for (const cb of listeners.get(method) ?? []) cb(params)
    },
    async respond(method, result) {
      const message = await request(method)
      feed?.(JSON.stringify({ id: message.id, result }))
    },
    request
  }
}

function req(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    threadId: THREAD,
    text: 'FEN: 8/8/8/8/8/8/8/K6k w - - 0 1',
    model: 'gpt-6-astra',
    effort: 'low',
    language: 'it',
    streamId: 'stream-1',
    ...overrides
  }
}

const agentMessage = (id: string, text: string, phase: string | null): Params => ({
  type: 'agentMessage',
  id,
  text,
  phase
})

const turn = (extra: Params): Params => ({
  id: TURN,
  items: [],
  itemsView: 'full',
  status: 'completed',
  error: null,
  startedAt: 0,
  completedAt: 1,
  durationMs: 1234,
  ...extra
})

const startedTurn = { turn: { id: TURN, status: 'inProgress', items: [], itemsView: 'full' } }

const noItems = { itemsList: async () => [] }

describe('languageLine', () => {
  it('asks for the UI language', () => {
    expect(languageLine('it')).toBe('Rispondi in italiano.')
    expect(languageLine('en')).toBe('Answer in English.')
  })
})

describe('runTurn', () => {
  it('streams deltas and returns the last final_answer message', async () => {
    const h = harness()
    const promise = runTurn(h.rpc, h.bus, req(), h.events, noItems)

    const start = await h.request('turn/start')
    expect(start.params.input[0].text).toContain('Rispondi in italiano.')
    expect(start.params.input[0].text_elements).toEqual([])
    expect(start.params.model).toBe('gpt-6-astra')
    expect(start.params.effort).toBe('low')
    expect(start).not.toHaveProperty('jsonrpc')
    await h.respond('turn/start', startedTurn)

    h.emit('item/reasoning/summaryTextDelta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'r1',
      delta: 'thinking'
    })
    h.emit('item/agentMessage/delta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'm2',
      delta: '{"mo'
    })
    h.emit('item/completed', {
      threadId: THREAD,
      turnId: TURN,
      item: agentMessage('m2', '{"move":"e4"}', 'final_answer')
    })
    h.emit('model/rerouted', { threadId: THREAD, turnId: TURN, fromModel: 'a', toModel: 'gpt-5.5' })
    h.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({
        items: [
          agentMessage('m1', 'thinking out loud', 'commentary'),
          agentMessage('m2', '{"move":"e4"}', 'final_answer')
        ]
      })
    })

    const result = await promise
    expect(result).toEqual({
      ok: true,
      text: '{"move":"e4"}',
      turnId: TURN,
      effectiveModel: 'gpt-5.5',
      durationMs: 1234
    })
    expect(h.deltas).toEqual([
      { kind: 'reasoning', itemId: 'r1', delta: 'thinking' },
      { kind: 'text', itemId: 'm2', delta: '{"mo' }
    ])
  })

  it('falls back to the last agentMessage when no phase is final_answer', async () => {
    const h = harness()
    const promise = runTurn(h.rpc, h.bus, req(), h.events, noItems)
    await h.respond('turn/start', startedTurn)
    h.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({ items: [agentMessage('m1', 'first', null), agentMessage('m2', 'second', null)] })
    })
    const result = await promise
    expect(result).toEqual(expect.objectContaining({ ok: true, text: 'second' }))
  })

  it('loads the items when the turn payload is only a summary', async () => {
    const h = harness()
    const itemsList = vi.fn(async () => [
      { turnId: TURN, item: agentMessage('m1', 'from items/list', 'final_answer') }
    ])
    const promise = runTurn(h.rpc, h.bus, req(), h.events, { itemsList })
    await h.respond('turn/start', startedTurn)
    h.emit('turn/completed', { threadId: THREAD, turn: turn({ itemsView: 'summary', items: [] }) })

    const result = await promise
    expect(itemsList).toHaveBeenCalledWith(THREAD, TURN)
    expect(result).toEqual(expect.objectContaining({ ok: true, text: 'from items/list' }))
  })

  // The real app-server (0.154.0) answers `itemsView: 'summary'` while the payload already carries
  // the final agentMessage: it must be used as is, without a round trip to thread/items/list.
  it('uses the summary payload when it already holds the final message', async () => {
    const h = harness()
    const itemsList = vi.fn(async () => [])
    const promise = runTurn(h.rpc, h.bus, req(), h.events, { itemsList })
    await h.respond('turn/start', startedTurn)
    h.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({ itemsView: 'summary', items: [agentMessage('m1', '{"move":"c5"}', 'final_answer')] })
    })
    const result = await promise
    expect(itemsList).not.toHaveBeenCalled()
    expect(result).toEqual(expect.objectContaining({ ok: true, text: '{"move":"c5"}' }))
  })

  it('falls back to the items completed during the turn when the list call fails', async () => {
    const h = harness()
    const itemsList = vi.fn(async () => { throw new Error('unsupported') })
    const promise = runTurn(h.rpc, h.bus, req(), h.events, { itemsList })
    await h.respond('turn/start', startedTurn)
    h.emit('item/completed', { threadId: THREAD, turnId: TURN, item: agentMessage('m1', '{"move":"e5"}', 'final_answer') })
    h.emit('turn/completed', { threadId: THREAD, turn: turn({ itemsView: 'notLoaded', items: [] }) })
    const result = await promise
    expect(result).toEqual(expect.objectContaining({ ok: true, text: '{"move":"e5"}' }))
  })

  it('still rejects a tool call that only shows up among the completed items', async () => {
    const h = harness()
    const promise = runTurn(h.rpc, h.bus, req(), h.events, noItems)
    await h.respond('turn/start', startedTurn)
    h.emit('item/completed', { threadId: THREAD, turnId: TURN, item: { type: 'commandExecution', id: 'c1' } })
    h.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({ itemsView: 'summary', items: [agentMessage('m1', '{"move":"c5"}', 'final_answer')] })
    })
    const result = await promise
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'invalid-items' }))
  })

  it('rejects a turn that used a tool', async () => {
    const h = harness()
    const promise = runTurn(h.rpc, h.bus, req(), h.events, noItems)
    await h.respond('turn/start', startedTurn)
    h.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({
        items: [
          { type: 'commandExecution', id: 'c1', command: 'echo' },
          agentMessage('m1', 'ignored', 'final_answer')
        ]
      })
    })
    const result = await promise
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: 'invalid-items', turnId: TURN })
    )
  })

  it('reports a turn without any assistant message', async () => {
    const h = harness()
    const promise = runTurn(h.rpc, h.bus, req(), h.events, noItems)
    await h.respond('turn/start', startedTurn)
    h.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({ items: [{ type: 'reasoning', id: 'r1', summary: [] }] })
    })
    expect(await promise).toEqual(expect.objectContaining({ ok: false, reason: 'no-message' }))
  })

  it('maps interrupted, failed and quota outcomes', async () => {
    const interrupted = harness()
    const first = runTurn(interrupted.rpc, interrupted.bus, req(), interrupted.events, noItems)
    await interrupted.respond('turn/start', startedTurn)
    interrupted.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({ status: 'interrupted', error: null })
    })
    expect(await first).toEqual(expect.objectContaining({ ok: false, reason: 'interrupted' }))

    const failed = harness()
    const second = runTurn(failed.rpc, failed.bus, req(), failed.events, noItems)
    await failed.respond('turn/start', startedTurn)
    failed.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({ status: 'failed', error: { message: 'boom', codexErrorInfo: null } })
    })
    expect(await second).toEqual(
      expect.objectContaining({ ok: false, reason: 'failed', message: 'boom' })
    )

    const quota = harness()
    const third = runTurn(quota.rpc, quota.bus, req(), quota.events, noItems)
    await quota.respond('turn/start', startedTurn)
    quota.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({
        status: 'failed',
        error: { message: 'limit', codexErrorInfo: 'usageLimitExceeded' }
      })
    })
    expect(await third).toEqual(expect.objectContaining({ ok: false, reason: 'quota' }))
  })

  it('interrupts the turn when it runs out of time', async () => {
    const h = harness()
    const promise = runTurn(h.rpc, h.bus, req({ timeoutMs: 20 }), h.events, noItems)
    await h.respond('turn/start', startedTurn)

    const interrupt = await h.request('turn/interrupt')
    expect(interrupt.params).toEqual({ threadId: THREAD, turnId: TURN })
    // The server answers the interrupt; the caller must not wait for it.
    await h.respond('turn/interrupt', {})
    expect(await promise).toEqual(
      expect.objectContaining({ ok: false, reason: 'timeout', turnId: TURN })
    )
  })

  it('voids the turn when the server asks the client something', async () => {
    const h = harness()
    const promise = runTurn(h.rpc, h.bus, req(), h.events, noItems)
    await h.respond('turn/start', startedTurn)
    h.emit(SERVER_REQUEST_METHOD, { threadId: THREAD })
    await h.respond('turn/interrupt', {})
    expect(await promise).toEqual(expect.objectContaining({ ok: false, reason: 'server-request' }))
  })

  it('ignores notifications of other turns and other threads', async () => {
    const h = harness()
    const promise = runTurn(h.rpc, h.bus, req(), h.events, noItems)
    await h.respond('turn/start', startedTurn)

    h.emit('item/agentMessage/delta', {
      threadId: THREAD,
      turnId: 'stale-turn',
      itemId: 'x',
      delta: 'stale'
    })
    h.emit('item/agentMessage/delta', {
      threadId: 'other-thread',
      turnId: TURN,
      itemId: 'y',
      delta: 'other'
    })
    h.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({ id: 'stale-turn', status: 'failed' })
    })
    h.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({ items: [agentMessage('m1', 'mine', 'final_answer')] })
    })

    expect(await promise).toEqual(expect.objectContaining({ ok: true, text: 'mine' }))
    expect(h.deltas).toEqual([])
  })

  it('replays the notifications that arrive before the turn id is known', async () => {
    const h = harness()
    const promise = runTurn(h.rpc, h.bus, req(), h.events, noItems)
    await h.request('turn/start')

    h.emit('item/agentMessage/delta', {
      threadId: THREAD,
      turnId: TURN,
      itemId: 'm1',
      delta: 'early'
    })
    h.emit('turn/completed', {
      threadId: THREAD,
      turn: turn({ items: [agentMessage('m1', 'early answer', 'final_answer')] })
    })
    await h.respond('turn/start', startedTurn)

    expect(await promise).toEqual(expect.objectContaining({ ok: true, text: 'early answer' }))
    expect(h.deltas).toEqual([{ kind: 'text', itemId: 'm1', delta: 'early' }])
  })

  it('fails without a turn id when turn/start is rejected', async () => {
    const h = harness()
    const promise = runTurn(h.rpc, h.bus, req(), h.events, noItems)
    const start = await h.request('turn/start')
    h.rpc.close('transport gone')
    void start
    expect(await promise).toEqual(
      expect.objectContaining({ ok: false, reason: 'failed', turnId: null })
    )
  })
})
