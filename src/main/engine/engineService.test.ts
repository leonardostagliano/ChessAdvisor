import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Analysis } from '@shared/types/engine'
import { SettingsStore } from '../store/settingsStore'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { EngineService, PROFILES } from './engineService'

const FAKE_ENGINE = resolve('test/fake-uci-engine.mjs')
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const MATE_FEN = '8/8/8/8/8/8/8/K6k w - - 0 1'

interface Harness {
  service: EngineService
  settings: SettingsStore
  emit: ReturnType<typeof vi.fn>
  dir: string
}

const open: Harness[] = []

/** Attaches a handler immediately so a rejection that lands before the assertion is not "unhandled". */
const captured = <T>(promise: Promise<T>): Promise<T | Error> =>
  promise.catch((error: Error) => error)

async function makeService(
  opts: { args?: string[]; override?: boolean; searchTimeoutMs?: number } = {}
): Promise<Harness> {
  const dir = await makeTmpDir('chessadvisor-engine-')
  const settings = new SettingsStore(join(dir, 'settings.json'))
  await settings.load()
  const emit = vi.fn()
  // Without an override the service looks for the bundled binaries, which do not exist here.
  const engineDir = join(dir, 'resources')
  const service = new EngineService({
    settings,
    resourcePath: (...segs: string[]) => join(engineDir, ...segs),
    emit,
    override:
      opts.override === false
        ? undefined
        : { exe: process.execPath, args: [FAKE_ENGINE, ...(opts.args ?? [])] },
    probeTimeoutMs: 1500,
    ...(opts.searchTimeoutMs === undefined ? {} : { searchTimeoutMs: opts.searchTimeoutMs })
  })
  const harness: Harness = { service, settings, emit, dir }
  open.push(harness)
  return harness
}

afterEach(async () => {
  while (open.length > 0) {
    const harness = open.pop()!
    await harness.service.shutdown().catch(() => undefined)
    await removeTmpDir(harness.dir)
  }
})

describe('EngineService probe', () => {
  it('starts the engine, reports the version and emits the state', async () => {
    const { service, emit } = await makeService()
    const state = await service.start()
    expect(state.available).toBe(true)
    expect(state.binary).toBe('avx2')
    expect(state.version).toBe('FakeFish 1.0')
    expect(state.message).toBeNull()
    expect(service.state()).toEqual(state)
    expect(emit).toHaveBeenCalledWith('engine:state', state)
  })

  it('marks the engine unavailable when the binary dies during the probe', async () => {
    const { service } = await makeService({ args: ['--exit'] })
    const state = await service.start()
    expect(state.available).toBe(false)
    expect(state.binary).toBe('none')
    expect(state.version).toBeNull()
    expect(state.message).toBeTruthy()
  })

  it('gives up when the binary never answers uciok', async () => {
    const { service } = await makeService({ args: ['--no-uciok'] })
    const state = await service.start()
    expect(state.available).toBe(false)
    expect(state.binary).toBe('none')
  })

  it('reports every path it searched when no bundled binary exists', async () => {
    const { service, settings } = await makeService({ override: false })
    const state = await service.start()
    expect(state.available).toBe(false)
    expect(state.binary).toBe('none')
    expect(state.message).toContain('stockfish-avx2.exe')
    expect(state.message).toContain('stockfish-popcnt.exe')
    // A failed probe is never remembered: the next start must try again.
    expect(settings.get().engineBinary).toBeNull()
  })

  it('re-probes despite a cached engineBinary of none left by an older build', async () => {
    const { service, settings } = await makeService()
    await settings.save({ engineBinary: 'none' })
    const state = await service.start()
    expect(state.available).toBe(true)
    expect(settings.get().engineBinary).toBe('avx2')
  })

  it('persists the probed binary and reuses it on the next start', async () => {
    const { service, settings } = await makeService()
    await service.start()
    expect(settings.get().engineBinary).toBe('avx2')
    // start() is idempotent: a second call does not re-probe.
    const again = await service.start()
    expect(again.available).toBe(true)
  })
})

describe('EngineService analysis', () => {
  it('bounds automatic comment preparation while comparing five candidate lines', async () => {
    expect(PROFILES.comment).toEqual({ depth: 18, movetimeMs: 900, multipv: 5 })
    const { service } = await makeService()
    await service.start()
    const analysis = await service.analyze(START_FEN, 'comment')
    expect(analysis.lines).toHaveLength(3) // The fake engine emits three slots.
    expect(analysis.depth).toBe(18)
  })

  it('reuses a completed analysis of the same position and profile', async () => {
    const { service } = await makeService()
    await service.start()
    const first = await service.analyze(START_FEN, 'live')
    const second = await service.analyze(START_FEN, 'live')
    expect(second).toBe(first)
  })

  it('returns the deepest line per multipv, sorted by multipv', async () => {
    const { service } = await makeService()
    await service.start()
    const analysis = await service.analyze(START_FEN, 'coach')
    expect(analysis.fen).toBe(START_FEN)
    expect(analysis.bestMove).toBe('e2e4')
    expect(PROFILES.coach).toEqual({ depth: 20, movetimeMs: 2500, multipv: 5 })
    expect(analysis.lines).toHaveLength(3) // The fixture emits only three candidate slots.
    expect(analysis.lines.map((line) => line.move)).toEqual(['e2e4', 'd2d4', 'g1f3'])
    expect(analysis.lines.map((line) => line.scoreCp)).toEqual([35, 20, 10])
    expect(analysis.lines[0]!.pv).toEqual(['e2e4', 'e7e5', 'g1f3'])
    // Only the deepest pass survives: the fake engine also emits a depth-8 pass.
    expect(analysis.lines.every((line) => line.depth === PROFILES.coach.depth)).toBe(true)
    expect(analysis.depth).toBe(PROFILES.coach.depth)
  })

  it('keeps mate scores in the side-to-move convention', async () => {
    const { service } = await makeService()
    await service.start()
    const analysis = await service.analyze(MATE_FEN, 'live')
    expect(analysis.lines[0]!.scoreMate).toBe(3)
    expect(analysis.lines[0]!.scoreCp).toBeUndefined()
    expect(analysis.lines).toHaveLength(1)
  })

  it('aborts the running live request when a new live request arrives', async () => {
    const { service } = await makeService()
    await service.start()
    const first = captured(service.analyze(START_FEN, 'live'))
    const second = service.analyze(MATE_FEN, 'live')
    expect(await first).toMatchObject({ name: 'AbortError' })
    const analysis = await second
    expect(analysis.fen).toBe(MATE_FEN)
  })

  it('drops a queued live request when a newer live request replaces it', async () => {
    const { service } = await makeService()
    await service.start()
    const review = service.analyze(START_FEN, 'review')
    const stale = captured(service.analyze(START_FEN, 'live'))
    const fresh = service.analyze(MATE_FEN, 'live')
    expect(await stale).toMatchObject({ name: 'AbortError' })
    expect((await review).lines).toHaveLength(PROFILES.review.multipv)
    expect((await fresh).lines[0]!.scoreMate).toBe(3)
  })

  it('never pre-empts a running coach or review request', async () => {
    const { service } = await makeService()
    await service.start()
    const review = service.analyze(START_FEN, 'review')
    const live = service.analyze(START_FEN, 'live')
    const results = await Promise.all([review, live])
    expect(results[0]!.lines).toHaveLength(PROFILES.review.multipv)
    expect(results[1]!.lines).toHaveLength(PROFILES.live.multipv)
  })

  it('runs requests serially in arrival order', async () => {
    const { service } = await makeService()
    await service.start()
    const done: string[] = []
    const track = (label: string) => (analysis: Analysis) => {
      done.push(label)
      return analysis
    }
    await Promise.all([
      service.analyze(START_FEN, 'coach').then(track('coach')),
      service.analyze(START_FEN, 'review').then(track('review'))
    ])
    expect(done).toEqual(['coach', 'review'])
  })

  it('rejects with AbortError when the caller signal aborts', async () => {
    const { service } = await makeService()
    await service.start()
    const controller = new AbortController()
    const running = captured(service.analyze(START_FEN, 'review', { signal: controller.signal }))
    controller.abort()
    expect(await running).toMatchObject({ name: 'AbortError' })
    // The queue recovers: the engine is still usable afterwards.
    expect((await service.analyze(START_FEN, 'live')).bestMove).toBe('e2e4')
  })

  it('rejects immediately for an already aborted signal', async () => {
    const { service } = await makeService()
    await service.start()
    await expect(
      service.analyze(START_FEN, 'live', { signal: AbortSignal.abort() })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('tears the engine down when a search never reports bestmove', async () => {
    const { service } = await makeService({ args: ['--hang-go'], searchTimeoutMs: 300 })
    await service.start()
    const running = captured(service.analyze(START_FEN, 'coach'))
    const queued = captured(service.analyze(START_FEN, 'review'))
    expect(await running).toMatchObject({ code: 'ENGINE_TIMEOUT' })
    expect(await queued).toMatchObject({ code: 'ENGINE_STOPPED' })
    // A hung engine is never reused: a late bestmove would belong to the wrong request.
    expect(service.state().available).toBe(false)
    expect(service.alive).toBe(false)
    await expect(service.analyze(START_FEN, 'live')).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE'
    })
  })

  it('refuses to analyze when no engine is available', async () => {
    const { service } = await makeService({ override: false })
    await service.start()
    await expect(service.analyze(START_FEN, 'live')).rejects.toMatchObject({
      code: 'ENGINE_UNAVAILABLE'
    })
  })
})

describe('EngineService shutdown', () => {
  it('quits the child process and leaves nothing alive', async () => {
    const { service } = await makeService()
    await service.start()
    expect(service.alive).toBe(true)
    await service.shutdown()
    expect(service.alive).toBe(false)
    expect(service.state().available).toBe(false)
  })

  it('rejects the requests still in flight', async () => {
    const { service } = await makeService()
    await service.start()
    const running = captured(service.analyze(START_FEN, 'review'))
    const queued = captured(service.analyze(START_FEN, 'coach'))
    await service.shutdown()
    expect(await running).toMatchObject({ code: 'ENGINE_STOPPED' })
    expect(await queued).toMatchObject({ code: 'ENGINE_STOPPED' })
  })
})
