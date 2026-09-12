import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcClient, RpcError, type RpcMessage, type RpcTransport } from './rpcClient'

class MemoryTransport implements RpcTransport {
  readonly sent: string[] = []
  private listener: ((line: string) => void) | null = null

  write(line: string): boolean {
    this.sent.push(line)
    return true
  }

  onLine(cb: (line: string) => void): void {
    this.listener = cb
  }

  /** Simulate a line arriving from the peer. */
  deliver(message: RpcMessage | string): void {
    const line = typeof message === 'string' ? message : JSON.stringify(message)
    this.listener?.(line)
  }

  parsed(): RpcMessage[] {
    return this.sent.map((line) => JSON.parse(line) as RpcMessage)
  }

  last(): RpcMessage {
    return JSON.parse(this.sent[this.sent.length - 1]!) as RpcMessage
  }
}

function makeClient(
  overrides: Partial<{
    onNotification(method: string, params: unknown): void
    onServerRequest(method: string, params: unknown): Promise<unknown>
    requestTimeoutMs: number
  }> = {}
): { client: RpcClient; transport: MemoryTransport; notifications: [string, unknown][] } {
  const transport = new MemoryTransport()
  const notifications: [string, unknown][] = []
  const client = new RpcClient(transport, {
    onNotification: overrides.onNotification ?? ((m, p) => notifications.push([m, p])),
    onServerRequest: overrides.onServerRequest ?? (async () => ({})),
    ...(overrides.requestTimeoutMs === undefined
      ? {}
      : { requestTimeoutMs: overrides.requestTimeoutMs })
  })
  return { client, transport, notifications }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('RpcClient', () => {
  it('writes framed messages without a jsonrpc field', async () => {
    const { client, transport } = makeClient()
    const pending = client.request('initialize', { clientInfo: { name: 'chessadvisor' } })
    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]!.endsWith('\n')).toBe(true)
    const sent = transport.last()
    expect(sent).toEqual({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'chessadvisor' } }
    })
    expect('jsonrpc' in sent).toBe(false)

    transport.deliver({ id: 1, result: { userAgent: 'fake' } })
    await expect(pending).resolves.toEqual({ userAgent: 'fake' })
  })

  it('omits params when none are given', async () => {
    const { client, transport } = makeClient()
    const pending = client.request('account/read')
    expect(transport.last()).toEqual({ id: 1, method: 'account/read' })
    transport.deliver({ id: 1, result: null })
    await expect(pending).resolves.toBeNull()
  })

  it('correlates responses interleaved with notifications', async () => {
    const { client, transport, notifications } = makeClient()
    const first = client.request('model/list', { cursor: null })
    const second = client.request('account/read')

    transport.deliver({ method: 'thread/started', params: { thread: { id: 't1' } } })
    transport.deliver({ id: 2, result: { account: null } })
    transport.deliver({ method: 'turn/started', params: { threadId: 't1' } })
    transport.deliver({ id: 1, result: { data: [], nextCursor: null } })

    await expect(second).resolves.toEqual({ account: null })
    await expect(first).resolves.toEqual({ data: [], nextCursor: null })
    expect(notifications.map(([m]) => m)).toEqual(['thread/started', 'turn/started'])
  })

  it('rejects with the peer error code', async () => {
    const { client, transport } = makeClient()
    const pending = client.request('turn/start', { threadId: 't1' })
    transport.deliver({ id: 1, error: { code: -32602, message: 'bad params' } })
    await expect(pending).rejects.toBeInstanceOf(RpcError)
    await pending.catch((error: RpcError) => {
      expect(error.code).toBe(-32602)
      expect(error.message).toBe('bad params')
      expect(error.method).toBe('turn/start')
    })
  })

  it('sends notifications with no id', () => {
    const { client, transport } = makeClient()
    client.notify('initialized')
    expect(transport.last()).toEqual({ method: 'initialized' })
    client.notify('ping', { a: 1 })
    expect(transport.last()).toEqual({ method: 'ping', params: { a: 1 } })
    expect(transport.parsed().every((m) => m.id === undefined)).toBe(true)
  })

  it('answers a server request with a result', async () => {
    const handled: [string, unknown][] = []
    const { client, transport } = makeClient({
      onServerRequest: async (method, params) => {
        handled.push([method, params])
        return { decision: 'denied' }
      }
    })
    void client
    transport.deliver({ id: 'srv-1', method: 'execCommandApproval', params: { command: 'ls' } })
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
    expect(transport.last()).toEqual({ id: 'srv-1', result: { decision: 'denied' } })
    expect(handled).toEqual([['execCommandApproval', { command: 'ls' }]])
  })

  it('answers a server request with an error when the handler throws', async () => {
    const { client, transport } = makeClient({
      onServerRequest: async () => {
        throw new Error('not supported')
      }
    })
    void client
    transport.deliver({ id: 7, method: 'item/tool/requestUserInput', params: {} })
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1))
    expect(transport.last()).toEqual({
      id: 7,
      error: { code: -32000, message: 'not supported' }
    })
  })

  it('rejects with TIMEOUT when no response arrives', async () => {
    vi.useFakeTimers()
    const { client } = makeClient({ requestTimeoutMs: 50 })
    const pending = client.request('turn/start', {})
    const assertion = expect(pending).rejects.toMatchObject({
      code: 'TIMEOUT',
      method: 'turn/start'
    })
    await vi.advanceTimersByTimeAsync(60)
    await assertion
  })

  it('honours a per-call timeout override', async () => {
    vi.useFakeTimers()
    const { client, transport } = makeClient({ requestTimeoutMs: 10_000 })
    const pending = client.request('turn/start', {}, 30)
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(40)
    await assertion
    expect(transport.sent).toHaveLength(1)
  })

  it('ignores a late response for a timed-out request', async () => {
    vi.useFakeTimers()
    const { client, transport } = makeClient({ requestTimeoutMs: 20 })
    const pending = client.request('account/read')
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' })
    await vi.advanceTimersByTimeAsync(30)
    await assertion
    expect(() => transport.deliver({ id: 1, result: {} })).not.toThrow()
  })

  it('rejects pending requests on close and refuses new ones', async () => {
    const { client } = makeClient()
    const pending = client.request('model/list')
    client.close('process exited')
    await expect(pending).rejects.toMatchObject({ code: 'CLOSED', message: 'process exited' })
    await expect(client.request('account/read')).rejects.toMatchObject({ code: 'CLOSED' })
  })

  it('stops writing after close', () => {
    const { client, transport } = makeClient()
    client.close('bye')
    client.notify('initialized')
    expect(transport.sent).toEqual([])
  })

  it('ignores malformed lines from the peer', async () => {
    const { client, transport, notifications } = makeClient()
    const pending = client.request('account/read')
    expect(() => transport.deliver('this is not json')).not.toThrow()
    expect(() => transport.deliver('42')).not.toThrow()
    transport.deliver({ id: 1, result: 'ok' })
    await expect(pending).resolves.toBe('ok')
    expect(notifications).toEqual([])
  })
})
