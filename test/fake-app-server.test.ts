import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Chess } from 'chess.js'
import { NdjsonParser } from '@main/codex/ndjson'
import { RpcClient, type RpcTransport } from '@main/codex/rpcClient'

const SERVER = resolve('test/fake-app-server.mjs')

interface Model {
  id: string
  isDefault: boolean
  supportedReasoningEfforts: { reasoningEffort: string; description: string }[]
}

interface Harness {
  client: RpcClient
  child: ChildProcessWithoutNullStreams
  notifications: { method: string; params: any }[]
  waitFor(method: string, predicate?: (params: any) => boolean): Promise<any>
  stop(): Promise<void>
}

const running: Harness[] = []

function startServer(env: NodeJS.ProcessEnv = {}): Harness {
  const child = spawn(process.execPath, [SERVER], {
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env }
  }) as ChildProcessWithoutNullStreams

  const notifications: { method: string; params: any }[] = []
  const waiters: { method: string; predicate: (p: any) => boolean; resolve(p: any): void }[] = []
  let lineListener: ((line: string) => void) | null = null

  const parser = new NdjsonParser((message) => {
    lineListener?.(JSON.stringify(message))
  })
  child.stdout.on('data', (chunk: Buffer) => parser.push(chunk))
  child.stderr.on('data', () => {})

  const transport: RpcTransport = {
    write: (line) => child.stdin.write(line),
    onLine: (cb) => {
      lineListener = cb
    }
  }

  const client = new RpcClient(transport, {
    onNotification: (method, params) => {
      notifications.push({ method, params })
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i]!
        if (waiter.method === method && waiter.predicate(params)) {
          waiters.splice(i, 1)
          waiter.resolve(params)
        }
      }
    },
    onServerRequest: async () => {
      throw new Error('server requests are not expected in an isolated environment')
    },
    requestTimeoutMs: 10_000
  })

  const harness: Harness = {
    client,
    child,
    notifications,
    waitFor(method, predicate = () => true) {
      const already = notifications.find((n) => n.method === method && predicate(n.params))
      if (already) return Promise.resolve(already.params)
      return new Promise((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`timed out waiting for ${method}`)), 10_000)
        waiters.push({
          method,
          predicate,
          resolve: (params) => {
            clearTimeout(timer)
            res(params)
          }
        })
      })
    },
    async stop() {
      client.close('test finished')
      child.stdin.end()
      if (child.exitCode === null) {
        await new Promise<void>((res) => {
          child.once('exit', () => res())
          setTimeout(() => {
            child.kill()
            res()
          }, 2000).unref?.()
        })
      }
    }
  }
  running.push(harness)
  return harness
}

const MOVE_SCHEMA = {
  type: 'object',
  properties: {
    move: { type: 'string' },
    shortComment: { type: ['string', 'null'] }
  },
  required: ['move', 'shortComment'],
  additionalProperties: false
}

const OPENING_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'

function turnText(fen: string, extra = ''): string {
  return `You are playing a game.\nFEN: ${fen}\n${extra}\nRispondi in italiano`
}

async function listAllModels(harness: Harness): Promise<{ models: Model[]; pages: number }> {
  const models: Model[] = []
  let cursor: string | null = null
  let pages = 0
  do {
    const page = await harness.client.request<{ data: Model[]; nextCursor: string | null }>(
      'model/list',
      { cursor, includeHidden: false }
    )
    pages += 1
    models.push(...page.data)
    cursor = page.nextCursor
  } while (cursor !== null)
  return { models, pages }
}

async function startThread(harness: Harness): Promise<string> {
  const started = await harness.client.request<{
    thread: { id: string }
    instructionSources: string[]
    approvalPolicy: string
    sandbox: { type: string }
  }>('thread/start', {
    model: 'gpt-6-astra',
    ephemeral: true,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    baseInstructions: 'You are a chess opponent.'
  })
  expect(started.instructionSources).toEqual([])
  expect(started.approvalPolicy).toBe('never')
  expect(started.sandbox.type).toBe('readOnly')
  return started.thread.id
}

async function runMoveTurn(
  harness: Harness,
  threadId: string,
  fen: string,
  extra = ''
): Promise<{ turnId: string; turn: any; text: string }> {
  const response = await harness.client.request<{ turn: { id: string; status: string } }>(
    'turn/start',
    {
      threadId,
      input: [{ type: 'text', text: turnText(fen, extra), text_elements: [] }],
      model: 'gpt-6-astra',
      effort: 'low',
      outputSchema: MOVE_SCHEMA
    }
  )
  expect(response.turn.status).toBe('inProgress')
  const turnId = response.turn.id
  const completed = await harness.waitFor('turn/completed', (p) => p.turn.id === turnId)
  const message = [...completed.turn.items]
    .reverse()
    .find((item: any) => item.type === 'agentMessage' && item.phase === 'final_answer')
  return { turnId, turn: completed.turn, text: message?.text ?? '' }
}

/** The coach's hint schema (spec §4.2): the only one carrying both `move` and `reason`. */
const HINT_SCHEMA = {
  type: 'object',
  properties: {
    move: { type: 'string' },
    reason: { type: 'string' }
  },
  required: ['move', 'reason'],
  additionalProperties: false
}

/** One turn with an arbitrary text and an optional schema; returns the final message. */
async function runTextTurn(harness: Harness, threadId: string, text: string, outputSchema?: object): Promise<string> {
  const response = await harness.client.request<{ turn: { id: string } }>('turn/start', {
    threadId,
    input: [{ type: 'text', text, text_elements: [] }],
    model: 'gpt-6-astra',
    effort: 'low',
    ...(outputSchema ? { outputSchema } : {})
  })
  const completed = await harness.waitFor('turn/completed', (p) => p.turn.id === response.turn.id)
  const message = [...completed.turn.items].reverse().find((item: any) => item.type === 'agentMessage')
  return message?.text ?? ''
}

afterEach(async () => {
  while (running.length > 0) await running.pop()!.stop()
})

describe('fake app-server', () => {
  it('answers initialize, paginates models and plays a legal move', async () => {
    const harness = startServer()

    const initialized = await harness.client.request<{
      userAgent: string
      platformOs: string
    }>('initialize', {
      clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: '0.1.0' },
      capabilities: null
    })
    expect(initialized.userAgent).toBe('fake/0.154.0')
    expect(initialized.platformOs).toBe('windows')
    harness.client.notify('initialized')

    const account = await harness.client.request<{ account: { type: string; email: string } }>(
      'account/read'
    )
    expect(account.account.type).toBe('chatgpt')

    const quota = await harness.client.request<{
      ordinaryUsageAllowed: boolean
      rateLimits: { primary: { usedPercent: number; windowDurationMins: number } }
    }>('account/rateLimits/read')
    expect(quota.ordinaryUsageAllowed).toBe(true)
    expect(quota.rateLimits.primary.usedPercent).toBe(31)
    expect(quota.rateLimits.primary.windowDurationMins).toBe(10080)

    const { models, pages } = await listAllModels(harness)
    expect(pages).toBe(2)
    expect(models.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.5'])
    expect(models[0]!.isDefault).toBe(true)
    expect(models[0]!.supportedReasoningEfforts.map((e) => e.reasoningEffort)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'ultra'
    ])
    expect(models[0]!.supportedReasoningEfforts[0]!.description).toBeTruthy()

    const hooks = await harness.client.request<{ data: { hooks: unknown[] }[] }>('hooks/list')
    expect(hooks.data[0]!.hooks).toEqual([])
    const config = await harness.client.request<{
      config: { plugins: object; mcp_servers: object; features: { hooks: boolean } }
    }>('config/read')
    expect(config.config.plugins).toEqual({})
    expect(config.config.mcp_servers).toEqual({})
    expect(config.config.features.hooks).toBe(false)

    const threadId = await startThread(harness)
    await harness.waitFor('thread/started', (p) => p.thread.id === threadId)

    const { turnId, turn, text } = await runMoveTurn(harness, threadId, OPENING_FEN)
    expect(turn.status).toBe('completed')
    expect(turn.itemsView).toBe('full')

    const parsed = JSON.parse(text) as { move: string; shortComment: string }
    expect(Object.keys(parsed).sort()).toEqual(['move', 'shortComment'])
    const chess = new Chess(OPENING_FEN)
    expect(() => chess.move(parsed.move)).not.toThrow()

    // Streaming deltas concatenate to the final text for the same item.
    const deltas = harness.notifications.filter(
      (n) => n.method === 'item/agentMessage/delta' && n.params.turnId === turnId
    )
    expect(deltas.length).toBeGreaterThan(0)
    expect(deltas.map((d) => d.params.delta).join('')).toBe(text)
    expect(new Set(deltas.map((d) => d.params.itemId)).size).toBe(1)
    expect(
      harness.notifications.some(
        (n) => n.method === 'item/reasoning/summaryTextDelta' && n.params.turnId === turnId
      )
    ).toBe(true)

    const items = await harness.client.request<{ data: { turnId: string; item: any }[] }>(
      'thread/items/list',
      { threadId, turnId }
    )
    expect(items.data.some((entry) => entry.item.type === 'agentMessage')).toBe(true)

    const unsubscribed = await harness.client.request<{ status: string }>('thread/unsubscribe', {
      threadId
    })
    expect(unsubscribed.status).toBe('unsubscribed')
  })

  it('emits a sparse rate-limit update after initialize', async () => {
    const harness = startServer()
    await harness.client.request('initialize', {
      clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: '0.1.0' },
      capabilities: null
    })
    const update = await harness.waitFor('account/rateLimits/updated')
    expect(update.rateLimits.primary.usedPercent).toBe(32)
    expect(update.rateLimits.secondary).toBeUndefined()
  })

  it('never puts a jsonrpc field on the wire', async () => {
    const child = spawn(process.execPath, [SERVER], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const lines: string[] = []
    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) if (line.trim()) lines.push(line)
    })
    child.stdin.write('{"id":1,"method":"initialize","params":{}}\n')
    // Two lines: the initialize response and the sparse account/rateLimits/updated notification.
    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(2), {
      timeout: 10_000,
      interval: 20
    })
    child.stdin.end()
    expect(lines.some((line) => line.includes('jsonrpc'))).toBe(false)
    const first = JSON.parse(lines[0]!) as { id: number; result: { userAgent: string } }
    expect(first.id).toBe(1)
    expect(first.result.userAgent).toBe('fake/0.154.0')
  })

  it('returns the forced move verbatim so the retry loop can be exercised', async () => {
    const harness = startServer()
    await harness.client.request('initialize', {
      clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: '0.1.0' },
      capabilities: null
    })
    const threadId = await startThread(harness)
    const { text } = await runMoveTurn(harness, threadId, OPENING_FEN, 'FAKE_FORCE_MOVE: Qh9')
    expect(JSON.parse(text).move).toBe('Qh9')
  })

  it('answers a coach turn without schema as plain text', async () => {
    const harness = startServer()
    await harness.client.request('initialize', {
      clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: '0.1.0' },
      capabilities: null
    })
    const threadId = await startThread(harness)
    const response = await harness.client.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'Explain the position.', text_elements: [] }],
      model: 'gpt-6-astra',
      effort: 'low'
    })
    const completed = await harness.waitFor('turn/completed', (p) => p.turn.id === response.turn.id)
    const message = completed.turn.items.find((item: any) => item.type === 'agentMessage')
    expect(message.text).toBe('Fake coach answer for ply 1.')
  })

  it('emits a commandExecution item when FAKE_CODEX_TOOL_ITEM=1', async () => {
    const harness = startServer({ FAKE_CODEX_TOOL_ITEM: '1' })
    await harness.client.request('initialize', {
      clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: '0.1.0' },
      capabilities: null
    })
    const threadId = await startThread(harness)
    const { turn } = await runMoveTurn(harness, threadId, OPENING_FEN)
    expect(turn.items.some((item: any) => item.type === 'commandExecution')).toBe(true)
  })

  it('fails the first turn when FAKE_CODEX_FAIL_ONCE=1 and succeeds afterwards', async () => {
    const harness = startServer({ FAKE_CODEX_FAIL_ONCE: '1' })
    await harness.client.request('initialize', {
      clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: '0.1.0' },
      capabilities: null
    })
    const threadId = await startThread(harness)
    const first = await runMoveTurn(harness, threadId, OPENING_FEN)
    expect(first.turn.status).toBe('failed')
    expect(first.turn.error.message).toBe('fake failure')
    expect(first.text).toBe('')

    const second = await runMoveTurn(harness, threadId, OPENING_FEN)
    expect(second.turn.status).toBe('completed')
    expect(JSON.parse(second.text).move).toBeTruthy()
  })

  it('interrupts a running turn', async () => {
    const harness = startServer()
    await harness.client.request('initialize', {
      clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: '0.1.0' },
      capabilities: null
    })
    const threadId = await startThread(harness)
    const response = await harness.client.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text: turnText(OPENING_FEN), text_elements: [] }],
      model: 'gpt-6-astra',
      effort: 'low',
      outputSchema: MOVE_SCHEMA
    })
    await harness.client.request('turn/interrupt', { threadId, turnId: response.turn.id })
    const completed = await harness.waitFor('turn/completed', (p) => p.turn.id === response.turn.id)
    expect(completed.turn.status).toBe('interrupted')
  })

  it('answers the coach hint schema with a legal move and a reason', async () => {
    const harness = startServer()
    await harness.client.request('initialize', {
      clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: '0.1.0' },
      capabilities: null
    })
    const threadId = await startThread(harness)
    const text = await runTextTurn(harness, threadId, `Suggerisci una mossa.
FEN: ${OPENING_FEN}`, HINT_SCHEMA)
    const hint = JSON.parse(text) as { move: string; reason: string }
    expect(hint.reason).toBe('fake hint')
    expect(new Chess(OPENING_FEN).moves()).toContain(hint.move)
    // The hint schema must not be mistaken for the opponent's move schema.
    expect(text).not.toContain('shortComment')
  })

  it('recognises a comment turn and a question turn by their text', async () => {
    const harness = startServer()
    await harness.client.request('initialize', {
      clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: '0.1.0' },
      capabilities: null
    })
    const threadId = await startThread(harness)
    expect(await runTextTurn(harness, threadId, 'Commenta la mossa appena giocata.')).toBe('Commento finto sulla mossa 1.')
    expect(await runTextTurn(harness, threadId, 'Domanda: che piano ho?')).toBe('Risposta finta.')
  })

  it('recognises a review turn and answers the lesson schema', async () => {
    const harness = startServer()
    await harness.client.request('initialize', {
      clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: '0.1.0' },
      capabilities: null
    })
    const threadId = await startThread(harness)
    // A review turn is recognised even though its text also asks to comment (spec §4.4).
    expect(await runTextTurn(harness, threadId, 'Rivedi la mossa 7 di una partita già conclusa.')).toBe('Commento finto in revisione.')

    const lesson = JSON.parse(
      await runTextTurn(harness, threadId, 'Ricava la lezione di questa partita.', {
        type: 'object',
        required: ['takeaways', 'summary'],
        additionalProperties: false,
        properties: { takeaways: { type: 'array', items: { type: 'string' } }, summary: { type: 'string' } }
      })
    ) as { takeaways: string[]; summary: string }
    expect(lesson.takeaways).toHaveLength(3)
    expect(lesson.summary).toBe('fake')
  })

  it('labels the key moments and writes a qualitative assessment (spec §6.1, §6.3)', async () => {
    const harness = startServer()
    await harness.client.request('initialize', {
      clientInfo: { name: 'chessadvisor', title: 'ChessAdvisor', version: '0.1.0' },
      capabilities: null
    })
    const threadId = await startThread(harness)

    const labelled = JSON.parse(
      await runTextTurn(harness, threadId, ['Etichetta i momenti chiave.', '- 7. Nxe5 (f3e5)', '- 12. Qh5 (d1h5)'].join('\n'), {
        type: 'object',
        required: ['labels'],
        additionalProperties: false,
        properties: {
          labels: {
            type: 'array',
            items: {
              type: 'object',
              required: ['ply', 'theme', 'note'],
              additionalProperties: false,
              properties: { ply: { type: 'number' }, theme: { type: 'string' }, note: { type: 'string' } }
            }
          }
        }
      })
    ) as { labels: { ply: number; theme: string; note: string }[] }
    expect(labelled.labels.map((label) => label.ply)).toEqual([7, 12])
    expect(labelled.labels[0]!.theme).toBe('fork')
    expect(labelled.labels[1]!.theme).toBe('pin')

    const assessment = JSON.parse(
      await runTextTurn(harness, threadId, 'Valuta il gioco della persona che alleni.', {
        type: 'object',
        required: ['strengths', 'weaknesses'],
        additionalProperties: false,
        properties: { strengths: { type: 'array', items: { type: 'string' } }, weaknesses: { type: 'array', items: { type: 'string' } } }
      })
    ) as { strengths: string[]; weaknesses: string[] }
    expect(assessment.strengths).toHaveLength(2)
    expect(assessment.weaknesses).toHaveLength(2)
  })

  it('reports a logged-out account when FAKE_CODEX_LOGGED_OUT=1', async () => {
    const harness = startServer({ FAKE_CODEX_LOGGED_OUT: '1' })
    const account = await harness.client.request<{
      account: null
      requiresOpenaiAuth: boolean
    }>('account/read')
    expect(account.account).toBeNull()
    expect(account.requiresOpenaiAuth).toBe(true)
  })
})
