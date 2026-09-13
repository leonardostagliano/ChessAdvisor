import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Chess } from 'chess.js'
import type { StreamEnvelope } from '@shared/types/api'
import type { CodexState } from '@shared/types/codex'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { SettingsStore } from '../store/settingsStore'
import { CodexService } from './codexService'

const FAKE_SERVER = resolve('test/fake-app-server.mjs')
const OPENING_FEN = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1'

const MOVE_SCHEMA = {
  type: 'object',
  properties: { move: { type: 'string' }, shortComment: { type: ['string', 'null'] } },
  required: ['move', 'shortComment'],
  additionalProperties: false
}

interface Harness {
  service: CodexService
  codexHome: string
  userHome: string
  emitted: { channel: string; payload: unknown }[]
  states(): CodexState[]
  streams(): StreamEnvelope[]
}

const dirs: string[] = []
const services: CodexService[] = []

async function harness(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const root = await makeTmpDir('chessadvisor-codex-')
  dirs.push(root)
  const codexHome = join(root, 'codex-home')
  const userHome = join(root, 'user-codex')
  const settings = new SettingsStore(join(root, 'settings.json'))
  await settings.load()

  const emitted: { channel: string; payload: unknown }[] = []
  const service = new CodexService({
    settings,
    codexHomeDir: codexHome,
    userHome,
    dataDir: root,
    emit: (channel, payload) => emitted.push({ channel, payload }),
    env: { ...process.env, ...env },
    fake: { exe: process.execPath, args: [FAKE_SERVER] }
  })
  services.push(service)
  return {
    service,
    codexHome,
    userHome,
    emitted,
    states: () =>
      emitted.filter((e) => e.channel === 'codex:state').map((e) => e.payload as CodexState),
    streams: () =>
      emitted.filter((e) => e.channel === 'stream').map((e) => e.payload as StreamEnvelope)
  }
}

async function ready(env: NodeJS.ProcessEnv = {}): Promise<Harness> {
  const h = await harness(env)
  await h.service.start()
  return h
}

async function playMove(
  h: Harness,
  extra = ''
): Promise<{ threadId: string; result: Awaited<ReturnType<CodexService['runTurn']>> }> {
  const threadId = await h.service.startThread('opponent', {
    model: 'gpt-6-astra',
    baseInstructions: 'You are a chess opponent.',
    gameId: 'game-1'
  })
  const deltas: string[] = []
  const result = await h.service.runTurn(
    {
      threadId,
      text: `Tocca a te.\nFEN: ${OPENING_FEN}\n${extra}`,
      model: 'gpt-6-astra',
      effort: 'low',
      outputSchema: MOVE_SCHEMA,
      language: 'it',
      streamId: 'stream-1',
      timeoutMs: 10_000
    },
    (kind, delta) => deltas.push(`${kind}:${delta}`)
  )
  expect(deltas.length).toBeGreaterThan(0)
  return { threadId, result }
}

afterEach(async () => {
  while (services.length > 0) await services.pop()!.shutdown()
  while (dirs.length > 0) await removeTmpDir(dirs.pop()!)
})

describe('CodexService', () => {
  it('boots the app-server in the dedicated CODEX_HOME and reaches ready', async () => {
    const h = await ready()

    const state = h.service.state()
    expect(state.status).toBe('ready')
    if (state.status !== 'ready') return
    expect(state.account).toEqual({ email: 'fake@example.com', planType: 'prolite' })
    expect(state.cliVersion).toBe('0.154.0')
    expect(state.versionMismatch).toBe(false)
    // Both pages of model/list are merged, efforts and the default model included.
    expect(state.models.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.5'])
    expect(state.models[0]!.isDefault).toBe(true)
    expect(state.models[0]!.defaultEffort).toBe('medium')
    expect(state.models[0]!.efforts.map((e) => e.id)).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'ultra'
    ])
    expect(state.models[0]!.efforts[0]!.description).toBeTruthy()
    expect(state.quota?.primary?.usedPercent).toBe(31)
    expect(state.quota?.ordinaryUsageAllowed).toBe(true)
    expect(h.service.models()).toEqual(state.models)

    const config = await readFile(join(h.codexHome, 'config.toml'), 'utf8')
    expect(config).toContain('hooks = false')
    // The placeholder written before the handshake is replaced by the catalogue default.
    expect(config).toContain('model = "gpt-6-astra"')
    expect(h.states()[0]).toEqual({ status: 'starting' })
  })

  it('keeps the full quota snapshot whatever the order of the sparse update', async () => {
    const h = await ready()
    // The fake answers `account/rateLimits/read` with 31 % and pushes a sparse
    // `account/rateLimits/updated` with 32 %: whichever lands last, the window metadata of the
    // full read must survive, because a sparse patch never clears what it does not carry.
    const quota = h.service.quota()
    expect([31, 32]).toContain(quota?.primary?.usedPercent)
    expect(quota?.primary?.windowDurationMins).toBe(10080)
    expect(quota?.primary?.resetsAt).toBe(1767225600)
    expect(quota?.ordinaryUsageAllowed).toBe(true)
    expect(quota?.planType).toBe('prolite')
    expect(h.states().at(-1)?.status).toBe('ready')
  })

  it('reports a logged-out Codex session', async () => {
    const h = await harness({ FAKE_CODEX_LOGGED_OUT: '1' })
    await h.service.start()
    expect(h.service.state()).toEqual({ status: 'not-authenticated' })
  })

  it('reports the searched paths when the CLI is not installed', async () => {
    const empty = await makeTmpDir('chessadvisor-nopath-')
    dirs.push(empty)
    // No `fake` and an environment where no codex.exe can be found: nothing is ever spawned.
    const service = new CodexService({
      settings: new SettingsStore(join(empty, 'settings.json')),
      codexHomeDir: join(empty, 'codex-home'),
      userHome: join(empty, 'user-codex'),
      emit: () => undefined,
      env: { PATH: empty, LOCALAPPDATA: empty, CODEX_APP_PATH: '' }
    })
    services.push(service)
    await service.start()
    const state = service.state()
    expect(state.status).toBe('not-installed')
    if (state.status !== 'not-installed') return
    expect(state.searched.some((path) => path.endsWith('codex.exe'))).toBe(true)
  })

  it('runs a turn with an output schema and returns a legal move', async () => {
    const h = await ready()
    const { result } = await playMove(h)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const parsed = JSON.parse(result.text) as { move: string; shortComment: string | null }
    expect(() => new Chess(OPENING_FEN).move(parsed.move)).not.toThrow()
    expect(result.turnId).toBeTruthy()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    const streams = h.streams()
    expect(streams.length).toBeGreaterThan(0)
    expect(streams.every((s) => s.streamId === 'stream-1')).toBe(true)
    expect(streams.some((s) => s.kind === 'text')).toBe(true)
    expect(streams.some((s) => s.kind === 'reasoning')).toBe(true)
    expect(streams.every((s) => s.turnId === result.turnId)).toBe(true)
  })

  it('surfaces a failed turn without retrying it', async () => {
    const h = await ready({ FAKE_CODEX_FAIL_ONCE: '1' })
    const { threadId, result } = await playMove(h)
    expect(result).toEqual(
      expect.objectContaining({ ok: false, reason: 'failed', message: 'fake failure' })
    )

    const second = await h.service.runTurn({
      threadId,
      text: `FEN: ${OPENING_FEN}`,
      model: 'gpt-6-astra',
      effort: 'low',
      outputSchema: MOVE_SCHEMA,
      language: 'en',
      streamId: 'stream-2',
      timeoutMs: 10_000
    })
    expect(second.ok).toBe(true)
  })

  it('rejects a turn that used a tool', async () => {
    const h = await ready({ FAKE_CODEX_TOOL_ITEM: '1' })
    const { result } = await playMove(h)
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'invalid-items' }))
  })

  it('refuses to run a turn on an unknown thread', async () => {
    const h = await ready()
    const result = await h.service.runTurn({
      threadId: 'nope',
      text: 'hello',
      model: 'gpt-6-astra',
      effort: 'low',
      language: 'it',
      streamId: 'stream-x'
    })
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'failed', turnId: null }))
  })

  it('closes a thread and forgets it', async () => {
    const h = await ready()
    const threadId = await h.service.startThread('coach', {
      model: 'gpt-6-astra',
      baseInstructions: 'You are a chess coach.'
    })
    await h.service.closeThread(threadId)
    const result = await h.service.runTurn({
      threadId,
      text: 'hello',
      model: 'gpt-6-astra',
      effort: 'low',
      language: 'it',
      streamId: 'stream-y'
    })
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: 'failed' }))
  })
})
