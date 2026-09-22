import { join } from 'node:path'
import { Chess } from 'chess.js'
import { epdOf } from '@shared/chess/notation'
import type { ModelInfo, TurnRequest, TurnResult } from '@shared/types/codex'
import type { Game, Move } from '@shared/types/game'
import type { Profile } from '@shared/types/profile'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import type { SessionCodex } from '../game/gameSession'
import { GameStore } from '../store/gameStore'
import { ProfileStore } from '../store/profileStore'
import { SettingsStore } from '../store/settingsStore'
import { ProfileService, QUALITATIVE_EVERY } from './profileService'
import { THEMES } from './themes'

/** Answers by the shape of the schema, exactly as the fake app-server does. */
class FakeCodex implements SessionCodex {
  readonly started: { role: string; model: string; baseInstructions: string; gameId?: string }[] =
    []
  readonly requests: TurnRequest[] = []
  readonly closed: string[] = []
  /** Themes handed back by the labelling call, cycled over the plies found in the prompt. */
  themes: string[] = ['fork']
  /** Plies dropped from the answer, to exercise the fallback of a forgotten moment. */
  skipPlies: number[] = []
  failNext = false
  holdQualitative = false
  qualitativePending = false
  private releaseQualitative: ((result: TurnResult) => void) | null = null
  private threads = 0

  async startThread(
    role: 'opponent' | 'coach' | 'training',
    opts: { model: string; baseInstructions: string; gameId?: string }
  ): Promise<string> {
    this.started.push({ role, ...opts })
    this.threads += 1
    return `thread-${this.threads}`
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    this.requests.push(req)
    if (this.failNext) {
      this.failNext = false
      return { ok: false, reason: 'failed', message: 'fake failure', turnId: null }
    }
    const properties =
      (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
    if ('labels' in properties) {
      const plies = [...req.text.matchAll(/^-\s*(\d+)\./gm)].map((match) => Number(match[1]))
      const labels = plies
        .filter((ply) => !this.skipPlies.includes(ply))
        .map((ply, index) => ({
          ply,
          theme: this.themes[index % this.themes.length],
          note: 'fake'
        }))
      return {
        ok: true,
        text: JSON.stringify({ labels }),
        turnId: 't',
        effectiveModel: null,
        durationMs: 1
      }
    }
    if ('strengths' in properties) {
      const answer: TurnResult = {
        ok: true,
        text: JSON.stringify({
          strengths: ['forte uno', 'forte due'],
          weaknesses: ['debole uno', 'debole due']
        }),
        turnId: 't',
        effectiveModel: null,
        durationMs: 1
      }
      if (!this.holdQualitative) return answer
      this.qualitativePending = true
      return new Promise<TurnResult>((resolve) => {
        this.releaseQualitative = resolve
      })
    }
    return { ok: true, text: '{}', turnId: 't', effectiveModel: null, durationMs: 1 }
  }

  releaseHeldQualitative(): void {
    this.qualitativePending = false
    const release = this.releaseQualitative
    this.releaseQualitative = null
    release?.({
      ok: true,
      text: JSON.stringify({ strengths: ['forte uno'], weaknesses: ['debole uno'] }),
      turnId: 't',
      effectiveModel: null,
      durationMs: 1
    })
  }

  readonly interrupted: string[] = []

  async interrupt(threadId: string): Promise<void> {
    this.interrupted.push(threadId)
  }

  async closeThread(threadId: string): Promise<void> {
    this.closed.push(threadId)
  }

  models(): ModelInfo[] {
    return []
  }
}

/** One game with real moves, an analysis and evaluations on the user's plies. */
function gameInit(
  sans: string[],
  patch: Partial<Game> = {}
): Omit<Game, 'id' | 'createdAt' | 'updatedAt' | 'status'> {
  const chess = new Chess()
  const moves: Move[] = sans.map((san, index) => {
    const played = chess.move(san)
    const by: 'user' | 'ai' = index % 2 === 0 ? 'user' : 'ai'
    return {
      ply: index + 1,
      san: played.san,
      uci: played.lan,
      fenAfter: chess.fen(),
      epdAfter: epdOf(chess.fen()),
      by,
      eval: {
        before: { cp: 10 },
        after: { cp: -10 },
        cpLoss: 20,
        winPercentLoss: by === 'user' ? 12 : 4,
        classification: by === 'user' ? 'mistake' : 'good',
        bestMove: 'e2e4',
        bestLine: ['e2e4']
      }
    }
  })
  return {
    kind: 'match',
    userColor: 'w',
    opponent: {
      model: 'gpt-6-astra',
      effort: 'medium',
      difficulty: { mode: 'fixed', level: 3, targetElo: 1200 }
    },
    coach: { model: 'gpt-6-astra', effort: 'medium' },
    clock: null,
    language: 'it',
    moves,
    takebacks: 0,
    coachLog: [],
    result: { outcome: '1-0', reason: 'resign' },
    analysis: {
      accuracy: { w: 80, b: 70 },
      acpl: { w: 45, b: 60 },
      keyMoments: [1, 3],
      analyzedAt: '2026-03-03T12:00:00.000Z'
    },
    opening: { eco: 'C40', name: "King's Knight Opening", lastBookPly: 3 },
    ...patch
  } as Omit<Game, 'id' | 'createdAt' | 'updatedAt' | 'status'>
}

describe('ProfileService', () => {
  let root: string
  let games: GameStore
  let profile: ProfileStore
  let settings: SettingsStore
  let codex: FakeCodex
  let events: Profile[]
  let service: ProfileService
  let clock: number

  beforeEach(async () => {
    root = await makeTmpDir()
    games = new GameStore(join(root, 'games'))
    await games.load()
    profile = new ProfileStore(join(root, 'profile.json'))
    await profile.load()
    settings = new SettingsStore(join(root, 'settings.json'))
    await settings.load()
    await settings.save({ defaultModel: 'gpt-6-astra', defaultEffort: 'low' })
    codex = new FakeCodex()
    events = []
    clock = Date.parse('2026-03-03T13:00:00.000Z')
    service = new ProfileService({
      codex,
      settings,
      profile,
      games,
      emit: (_channel, payload) => events.push(payload),
      now: () => clock
    })
  })

  afterEach(async () => {
    await service.waitForIdle()
    await removeTmpDir(root)
  })

  /** A finished, analysed game on disk: the shape the pipeline hands to the profile. */
  const saved = async (sans: string[], patch: Partial<Game> = {}): Promise<Game> => {
    const init = gameInit(sans, patch)
    const game = await games.create(init)
    Object.assign(game, {
      status: 'finished',
      moves: init.moves,
      result: init.result,
      analysis: init.analysis,
      opening: init.opening,
      takebacks: init.takebacks
    })
    await games.save(game)
    return game
  }

  it('labels the key moments, writes the themes on the moves and counts them', async () => {
    codex.themes = ['fork', 'pin']
    const game = await saved(['e4', 'e5', 'Nf3', 'Nc6'])

    await service.onGameAnalyzed(game)
    await service.waitForIdle()

    expect(codex.started[0]?.role).toBe('training')
    const labelling = codex.requests[0]!
    expect(labelling.text).toContain('- 1. e4')
    expect(labelling.text).toContain('- 3. Nf3')
    const onDisk = await games.get(game.id)
    expect(onDisk?.moves[0]?.theme).toBe('fork')
    expect(onDisk?.moves[2]?.theme).toBe('pin')
    const stats = service.get().themeStats
    expect(stats.fork).toEqual({ occurrences: 1, lastSeen: '2026-03-03T12:00:00.000Z' })
    expect(stats.pin?.occurrences).toBe(1)
    // The thread of a one-shot call never stays open.
    expect(codex.closed).toEqual(['thread-1', 'thread-2'])
  })

  it('remaps a theme outside the taxonomy and fills in a moment the model forgot', async () => {
    codex.themes = ['zugzwang']
    codex.skipPlies = [3]
    const game = await saved(['e4', 'e5', 'Nf3', 'Nc6'])

    await service.onGameAnalyzed(game)
    await service.waitForIdle()

    const onDisk = await games.get(game.id)
    expect(onDisk?.moves[0]?.theme).toBe('missed_tactic')
    expect(onDisk?.moves[2]?.theme).toBe('missed_tactic')
    expect(service.get().themeStats.missed_tactic?.occurrences).toBe(2)
    expect(THEMES).toContain('missed_tactic')
  })

  it('writes the history, the level and the counter of the study plan, and announces the profile', async () => {
    const game = await saved(['e4', 'e5'])

    await service.onGameAnalyzed(game)

    const updated = service.get()
    expect(updated.history).toEqual([
      { gameId: game.id, date: '2026-03-03T12:00:00.000Z', accuracy: 80, acpl: 45 }
    ])
    // ACPL 45 → 1600, accuracy 80 → 1600; one game out of a window of ten: confidence 0.1.
    expect(updated.level).toEqual({
      band: 'advanced',
      estimate: 1600,
      confidence: 0.1,
      updatedAt: '2026-03-03T13:00:00.000Z'
    })
    expect(updated.gamesSincePlan).toBe(1)
    expect(events.at(-1)?.level.estimate).toBe(1600)
  })

  it('aggregates the openings with a running accuracy over the first ten plies', async () => {
    const first = await saved(['e4', 'e5', 'Nf3'])
    await service.onGameAnalyzed(first)
    await service.waitForIdle()
    const second = await saved(['e4', 'e5', 'Nf3'], {
      result: { outcome: '0-1', reason: 'checkmate' }
    })
    await service.onGameAnalyzed(second)
    await service.waitForIdle()

    const stats = service.get().openingStats.C40!
    expect(stats).toMatchObject({
      eco: 'C40',
      name: "King's Knight Opening",
      games: 2,
      wins: 1,
      draws: 0,
      losses: 1
    })
    // Every user move loses 12 points of winning chance (accuracy ≈ 58): the mean never moves.
    expect(stats.avgAccuracyFirst10).toBeCloseTo(58, 0)
  })

  it('never counts the same game twice when it is analysed again', async () => {
    const game = await saved(['e4', 'e5', 'Nf3'])
    await service.onGameAnalyzed(game)
    await service.waitForIdle()
    const calls = codex.requests.length

    await service.onGameAnalyzed(game)
    await service.waitForIdle()

    const updated = service.get()
    expect(updated.history).toHaveLength(1)
    expect(updated.gamesSincePlan).toBe(1)
    expect(updated.openingStats.C40?.games).toBe(1)
    // Two key moments, both labelled once: a second analysis adds nothing.
    expect(updated.themeStats.fork?.occurrences).toBe(2)
    expect(codex.requests).toHaveLength(calls)
  })

  it('does not learn from a retired game when it is analysed again', async () => {
    const game = await saved(['e4', 'e5', 'Nf3'])
    await profile.update({ retiredGameIds: [game.id] })

    await service.onGameAnalyzed(game)

    expect(service.get().history).toEqual([])
    expect(service.get().themeStats).toEqual({})
    expect(service.get().openingStats).toEqual({})
    expect(codex.requests).toHaveLength(0)
  })
  it('ignores an endgame drill and a game that was never analysed (spec §6.7)', async () => {
    const drill = await saved(['e4'], { kind: 'endgame_drill' })
    await service.onGameAnalyzed(drill)
    await service.onGameAnalyzed({ ...(await saved(['e4'])), analysis: undefined })

    expect(service.get().history).toEqual([])
    expect(codex.requests).toHaveLength(0)
  })

  it('rewrites the qualitative assessment after every newly analysed match', async () => {
    expect(QUALITATIVE_EVERY).toBe(1)
    await service.onGameAnalyzed(await saved(['e4', 'e5']))
    await service.waitForIdle()
    await service.onGameAnalyzed(await saved(['e4', 'e5']))
    await service.waitForIdle()

    expect(
      codex.requests.filter((request) =>
        Object.hasOwn(
          (request.outputSchema as { properties?: Record<string, unknown> }).properties ?? {},
          'strengths'
        )
      )
    ).toHaveLength(2)
    expect(service.get().qualitative?.strengths).toEqual(['forte uno', 'forte due'])
  })

  it('keeps qualitative prose and theme timestamps on a no-op reconciliation', async () => {
    const game = await saved(['e4', 'e5'])
    game.moves[0]!.theme = 'fork'
    await games.save(game)
    await service.reconcileArchive()
    await profile.update({
      qualitative: {
        strengths: ['solido'],
        weaknesses: ['da verificare'],
        updatedAt: '2026-03-03T13:00:00.000Z'
      }
    })
    const snapshot = service.get()
    const emitted = events.length
    clock += 86_400_000

    await service.reconcileArchive()

    expect(service.get()).toEqual(snapshot)
    expect(events).toHaveLength(emitted)
  })

  it('does not save a qualitative answer made stale by deletion and reconciliation', async () => {
    const game = await saved(['e4', 'e5'])
    await service.reconcileArchive()
    codex.holdQualitative = true
    const refresh = service.refreshQualitative()
    await vi.waitFor(() => expect(codex.qualitativePending).toBe(true))

    await games.delete(game.id)
    await service.reconcileArchive()
    codex.releaseHeldQualitative()
    await refresh

    expect(service.get().qualitative).toBeUndefined()
  })

  it('refreshes the assessment on demand and announces it', async () => {
    const updated = await service.refreshQualitative()

    expect(updated.qualitative?.strengths).toHaveLength(2)
    expect(events.at(-1)?.qualitative?.weaknesses).toHaveLength(2)
    const request = codex.requests.at(-1)!
    expect(request.text).toContain('Livello stimato')
    expect(request.model).toBe('gpt-6-astra')
    expect(request.effort).toBe('low')
  })

  it('keeps the statistics when the labelling turn fails', async () => {
    codex.failNext = true
    const game = await saved(['e4', 'e5'])

    await service.onGameAnalyzed(game)

    const updated = service.get()
    expect(updated.themeStats).toEqual({})
    expect(updated.history).toHaveLength(1)
    expect(updated.level.estimate).toBe(1600)
    expect((await games.get(game.id))?.moves[0]?.theme).toBeUndefined()
  })

  it('uses the separate coach model when Settings asks for one', async () => {
    await settings.save({ separateCoach: true, coachModel: 'gpt-5.5', coachEffort: 'high' })

    await service.refreshQualitative()

    expect(codex.started.at(-1)?.model).toBe('gpt-5.5')
    expect(codex.requests.at(-1)?.effort).toBe('high')
  })

  it('excludes a game the AI lost on time from the level window (spec §6.1)', async () => {
    const flagged = await saved(['e4', 'e5'], {
      result: { outcome: '1-0', reason: 'timeout' },
      analysis: {
        accuracy: { w: 45, b: 40 },
        acpl: { w: 150, b: 160 },
        keyMoments: [],
        analyzedAt: '2026-03-02T12:00:00.000Z'
      }
    })
    await service.onGameAnalyzed(flagged)
    // The flagged game is in the history (it was played) but never in the estimate.
    expect(service.get().level).toEqual({
      band: 'beginner',
      estimate: 0,
      confidence: 0,
      updatedAt: '2026-03-03T13:00:00.000Z'
    })

    await service.onGameAnalyzed(await saved(['e4', 'e5']))

    expect(service.get().level.estimate).toBe(1600)
    expect(service.get().level.confidence).toBe(0.1)
    expect(service.get().history).toHaveLength(2)
  })
})
