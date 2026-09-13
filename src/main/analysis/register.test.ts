import { join, resolve } from 'node:path'
import { Chess } from 'chess.js'
import { epdOf, legalMoves } from '@shared/chess/notation'
import type { ModelInfo, TurnRequest, TurnResult } from '@shared/types/codex'
import type { Analysis, AnalysisProfile, EngineState } from '@shared/types/engine'
import type { Game, Move } from '@shared/types/game'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import type { SessionCodex, SessionEngine } from '../game/gameSession'
import { GameStore } from '../store/gameStore'
import { SettingsStore } from '../store/settingsStore'
import { AnalysisManager, MAX_KEY_MOMENT_COMMENTS } from './register'

const DATASET = resolve(__dirname, '../../../resources/data/openings.json')

class FakeCodex implements SessionCodex {
  readonly started: { role: string; model: string; baseInstructions: string; gameId?: string }[] =
    []
  readonly requests: TurnRequest[] = []
  readonly interrupted: string[] = []
  readonly closed: string[] = []
  script: TurnResult[] = []
  deltas: string[] = []
  private threads = 0

  async startThread(
    role: 'opponent' | 'coach' | 'training',
    opts: { model: string; baseInstructions: string; gameId?: string }
  ): Promise<string> {
    this.started.push({ role, ...opts })
    this.threads += 1
    return `thread-${this.threads}`
  }

  async runTurn(
    req: TurnRequest,
    onDelta?: (kind: 'text' | 'reasoning', delta: string) => void
  ): Promise<TurnResult> {
    this.requests.push(req)
    for (const delta of this.deltas) onDelta?.('text', delta)
    const scripted = this.script.shift()
    if (scripted) return scripted
    const text = req.outputSchema
      ? JSON.stringify({ takeaways: ['uno', 'due', 'tre', 'quattro'], summary: 'riepilogo finto' })
      : 'Commento finto in revisione.'
    return {
      ok: true,
      text,
      turnId: `t-${this.requests.length}`,
      effectiveModel: null,
      durationMs: 4
    }
  }

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

/** Engine that always sees a small edge for the side to move and picks the first legal move. */
function fakeEngine(
  available = true,
  scoreCp = 20
): SessionEngine & { calls: { fen: string; profile: AnalysisProfile }[] } {
  const calls: { fen: string; profile: AnalysisProfile }[] = []
  return {
    calls,
    state: (): EngineState => ({
      available,
      binary: available ? 'avx2' : 'none',
      version: 'fake 17',
      message: available ? null : 'no binary'
    }),
    analyze: async (fen: string, profile: AnalysisProfile): Promise<Analysis> => {
      calls.push({ fen, profile })
      const best = legalMoves(fen)[0]?.uci ?? ''
      return {
        bestMove: best,
        lines: [{ move: best, pv: [best], scoreCp, depth: 20 }],
        depth: 20,
        fen
      }
    }
  } as SessionEngine & { calls: { fen: string; profile: AnalysisProfile }[] }
}

function gameOf(
  sans: string[],
  patch: Partial<Game> = {}
): Omit<Game, 'id' | 'createdAt' | 'updatedAt' | 'status'> {
  const chess = new Chess()
  const moves: Move[] = sans.map((san, index) => {
    const played = chess.move(san)
    return {
      ply: index + 1,
      san: played.san,
      uci: played.lan,
      fenAfter: chess.fen(),
      epdAfter: epdOf(chess.fen()),
      by: index % 2 === 0 ? 'user' : 'ai'
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
    ...patch
  } as Omit<Game, 'id' | 'createdAt' | 'updatedAt' | 'status'>
}

describe('AnalysisManager', () => {
  let root: string
  let store: GameStore
  let settings: SettingsStore
  let codex: FakeCodex
  let engine: ReturnType<typeof fakeEngine>
  let events: { channel: string; payload: unknown }[]
  let manager: AnalysisManager

  const build = (over?: { engine?: SessionEngine }): AnalysisManager => {
    manager = new AnalysisManager({
      codex,
      engine: over?.engine ?? engine,
      store,
      settings,
      emit: (channel, payload) => events.push({ channel, payload }),
      openingsPath: () => DATASET,
      now: () => Date.parse('2026-03-03T12:00:00.000Z')
    })
    return manager
  }

  beforeEach(async () => {
    root = await makeTmpDir()
    store = new GameStore(join(root, 'games'))
    await store.load()
    settings = new SettingsStore(join(root, 'settings.json'))
    await settings.load()
    codex = new FakeCodex()
    engine = fakeEngine()
    events = []
    build()
  })

  afterEach(async () => {
    await removeTmpDir(root)
  })

  /** `GameStore.create` always starts an empty game: the history is written in right after. */
  const saved = async (sans: string[], patch: Partial<Game> = {}): Promise<Game> => {
    const init = gameOf(sans, patch)
    const game = await store.create(init)
    Object.assign(game, {
      moves: init.moves,
      result: init.result,
      analysis: patch.analysis,
      opening: patch.opening
    })
    await store.save(game)
    return game
  }

  it('analyses a game, saves it and reports its progress', async () => {
    const game = await saved(['e4', 'e5', 'Nf3'])

    const analysed = await manager.run(game.id)

    expect(analysed.analysis?.analyzedAt).toBe('2026-03-03T12:00:00.000Z')
    expect(analysed.opening?.eco).toBe('C40')
    const onDisk = await store.get(game.id)
    expect(onDisk?.moves.every((move) => move.eval !== undefined)).toBe(true)
    const progress = events.filter((event) => event.channel === 'analysis:progress')
    expect(progress).toHaveLength(4)
    expect(progress[0]!.payload).toEqual({ gameId: game.id, ply: 0, total: 3 })
    expect(await manager.status(game.id)).toEqual({ state: 'done', ply: 3, total: 3 })
  })

  it('never analyses the same game twice at the same time', async () => {
    const game = await saved(['e4', 'e5'])
    const first = manager.run(game.id)
    const second = manager.run(game.id)
    expect(second).toBe(first)
    await first
    // Three positions, one search each: a second run would have doubled them.
    expect(engine.calls).toHaveLength(3)
  })

  it('reports an unavailable engine instead of pretending to analyse', async () => {
    build({ engine: fakeEngine(false) })
    const game = await saved(['e4'])
    await expect(manager.run(game.id)).rejects.toMatchObject({ code: 'ANALYSIS_UNAVAILABLE' })
    expect(await manager.status(game.id)).toEqual({ state: 'unavailable' })
  })

  it('is idle for a game that has never been analysed, and refuses an unknown one', async () => {
    const game = await saved(['e4'])
    expect(await manager.status(game.id)).toEqual({ state: 'idle' })
    await expect(manager.run('nope')).rejects.toMatchObject({ code: 'GAME_NOT_FOUND' })
  })

  it('analyses a finished match by itself when the game session says so', async () => {
    const game = await saved(['e4', 'e5'])
    manager.onGameFinished({ ...game, status: 'finished' })
    // The hook is fire-and-forget: `run` joins the analysis it has just started.
    await manager.run(game.id)
    expect((await store.get(game.id))?.analysis).toBeTruthy()
    expect(engine.calls).toHaveLength(3)
  })

  it('leaves an endgame drill alone: only matches are analysed', async () => {
    const drill = await saved(['e4'], { kind: 'endgame_drill' })
    manager.onGameFinished({ ...drill, kind: 'endgame_drill', status: 'finished' })
    expect(await manager.status(drill.id)).toEqual({ state: 'idle' })
    expect(engine.calls).toHaveLength(0)
  })

  it('comments a past ply on a `training` thread and saves the text on the move', async () => {
    const game = await saved(['e4', 'e5', 'Nf3'])
    await manager.run(game.id)

    const text = await manager.commentMove(game.id, 3)

    expect(text).toBe('Commento finto in revisione.')
    expect(codex.started).toHaveLength(1)
    expect(codex.started[0]).toMatchObject({
      role: 'training',
      model: 'gpt-6-astra',
      gameId: game.id
    })
    expect(codex.requests[0]!.text).toContain('Rivedi la mossa 3')
    // The numbers already saved by the pipeline are reused: no extra search for the comment.
    expect(engine.calls.filter((call) => call.profile !== 'review')).toHaveLength(0)
    const onDisk = await store.get(game.id)
    expect(onDisk?.moves[2]?.coachComment).toBe('Commento finto in revisione.')
    expect(onDisk?.moves[2]?.coachCommentLanguage).toBe('it')

    // The activity event announces the stream id before the turn and clears it afterwards.
    const activity = events.filter((event) => event.channel === 'review:activity')
    expect(activity).toHaveLength(2)
    expect(activity[0]!.payload).toMatchObject({ kind: 'move', ply: 3, busy: true })
    expect(activity[1]!.payload).toMatchObject({ streamId: null, busy: false })
  })

  it('streams the whole answer when the turn produced no delta at all', async () => {
    const game = await saved(['e4'])
    await manager.commentMove(game.id, 1)
    const stream = events.filter((event) => event.channel === 'stream')
    expect(stream).toHaveLength(1)
    expect(stream[0]!.payload).toMatchObject({
      kind: 'text',
      chunk: 'Commento finto in revisione.'
    })
  })

  it('keeps the review thread for the same game and replaces it for another', async () => {
    const first = await saved(['e4'])
    const second = await saved(['d4'])
    await manager.commentMove(first.id, 1)
    await manager.commentMove(first.id, 1)
    expect(codex.started).toHaveLength(1)

    await manager.commentMove(second.id, 1)
    expect(codex.started).toHaveLength(2)
    expect(codex.closed).toEqual(['thread-1'])

    await manager.close()
    expect(codex.closed).toEqual(['thread-1', 'thread-2'])
  })

  it('comments the key moments, one call each, capped at eight', async () => {
    const sans = [
      'e4',
      'e5',
      'Nf3',
      'Nc6',
      'Bb5',
      'a6',
      'Ba4',
      'Nf6',
      'O-O',
      'Be7',
      'Re1',
      'b5',
      'Bb3',
      'd6',
      'c3',
      'O-O',
      'h3',
      'Nb8',
      'd4',
      'Nbd7'
    ]
    const keyMoments = [1, 3, 5, 7, 9, 11, 13, 15, 17, 19]
    const game = await saved(sans, {
      analysis: {
        accuracy: { w: 70, b: 70 },
        acpl: { w: 40, b: 40 },
        keyMoments,
        analyzedAt: '2026-03-03T00:00:00.000Z'
      }
    })

    const comments = await manager.commentKeyMoments(game.id)

    expect(comments).toHaveLength(MAX_KEY_MOMENT_COMMENTS)
    expect(comments.map((entry) => entry.ply)).toEqual(keyMoments.slice(0, MAX_KEY_MOMENT_COMMENTS))
    expect(codex.requests).toHaveLength(MAX_KEY_MOMENT_COMMENTS)
    expect(codex.requests[0]!.text).toContain('momento chiave 1 di 8')
    const onDisk = await store.get(game.id)
    expect(onDisk?.moves[0]?.coachComment).toBe('Commento finto in revisione.')
  })

  it('clamps the lesson to three takeaways and saves it in the analysis', async () => {
    const game = await saved(['e4', 'e5'])
    await manager.run(game.id)

    const lesson = await manager.lesson(game.id)

    expect(lesson.takeaways).toEqual(['uno', 'due', 'tre'])
    expect(lesson.summary).toBe('riepilogo finto')
    expect(lesson.language).toBe('it')
    expect(codex.requests[0]!.outputSchema).toMatchObject({ required: ['takeaways', 'summary'] })
    expect((await store.get(game.id))?.analysis?.lesson?.takeaways).toHaveLength(3)
  })

  it('still answers a lesson for a game that was never analysed, without inventing an analysis', async () => {
    const game = await saved(['e4', 'e5'])
    const lesson = await manager.lesson(game.id)
    expect(lesson.takeaways).toHaveLength(3)
    expect((await store.get(game.id))?.analysis).toBeUndefined()
  })

  it('refuses a lesson that did not come back as the requested JSON', async () => {
    const game = await saved(['e4'])
    codex.script = [
      { ok: true, text: 'non è JSON', turnId: 't1', effectiveModel: null, durationMs: 1 }
    ]
    await expect(manager.lesson(game.id)).rejects.toMatchObject({ code: 'LESSON_INVALID' })
  })

  it('turns a failed review turn into a typed error', async () => {
    const game = await saved(['e4'])
    codex.script = [{ ok: false, reason: 'quota', message: 'weekly limit', turnId: null }]
    await expect(manager.commentMove(game.id, 1)).rejects.toMatchObject({
      code: 'REVIEW_TURN_FAILED'
    })
  })

  it('refuses a ply the game does not have', async () => {
    const game = await saved(['e4'])
    await expect(manager.commentMove(game.id, 9)).rejects.toMatchObject({ code: 'BAD_PLY' })
  })

  it('uses the separate coach model when Settings ask for it', async () => {
    await settings.save({ separateCoach: true, coachModel: 'gpt-5.5', coachEffort: 'low' })
    const game = await saved(['e4'])
    await manager.commentMove(game.id, 1)
    expect(codex.started[0]!.model).toBe('gpt-5.5')
    expect(codex.requests[0]).toMatchObject({ model: 'gpt-5.5', effort: 'low' })
  })

  it('works without an engine, in the oracle-less mode', async () => {
    build({ engine: fakeEngine(false) })
    const game = await saved(['e4'])
    const text = await manager.commentMove(game.id, 1)
    expect(text).toBe('Commento finto in revisione.')
    expect(codex.started[0]!.baseInstructions).toMatch(/senza oracolo/)
    expect(codex.requests[0]!.text).toMatch(/senza oracolo/)
  })
})
