import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Game } from '@shared/types/game'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { GameStore, type GameInit } from './gameStore'

const init = (patch: Partial<GameInit> = {}): GameInit => ({
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
  ...patch
})

describe('GameStore', () => {
  let root: string
  let dir: string
  let store: GameStore

  beforeEach(async () => {
    root = await makeTmpDir()
    dir = join(root, 'games')
    store = new GameStore(dir)
    await store.load()
  })

  afterEach(async () => {
    await removeTmpDir(root)
    vi.restoreAllMocks()
  })

  it('creates a game with the defaults the caller must not provide', async () => {
    const game = await store.create(init())
    expect(game.id).toMatch(/[0-9a-f-]{36}/)
    expect(game.status).toBe('in_progress')
    expect(game.moves).toEqual([])
    expect(game.takebacks).toBe(0)
    expect(game.coachLog).toEqual([])
    expect(game.createdAt).toBe(game.updatedAt)
    expect(await readdir(dir)).toEqual([`${game.id}.json`])
  })

  it('reads a created game back from disk', async () => {
    const game = await store.create(
      init({ userColor: 'b', startFen: '8/8/8/8/8/8/8/K6k w - - 0 1' })
    )
    const loaded = await store.get(game.id)
    expect(loaded).toEqual(game)
    expect(await store.get('missing')).toBeNull()
  })

  it('lists summaries newest first and exposes the ply count', async () => {
    const clock = vi.fn(() => 1_000)
    const timed = new GameStore(dir, clock)
    await timed.load()
    clock.mockReturnValue(1_000)
    const first = await timed.create(init())
    clock.mockReturnValue(2_000)
    const second = await timed.create(init({ kind: 'endgame_drill' }))
    clock.mockReturnValue(3_000)
    first.moves.push({ ply: 1, san: 'e4', uci: 'e2e4', fenAfter: 'x', epdAfter: 'x', by: 'user' })
    await timed.save(first)

    expect(timed.list().map((s) => s.id)).toEqual([first.id, second.id])
    expect(timed.list()[0]).toMatchObject({ plies: 1, kind: 'match', status: 'in_progress' })
    expect(timed.list({ kind: 'endgame_drill' }).map((s) => s.id)).toEqual([second.id])
    expect(timed.list({ status: 'finished' })).toEqual([])
  })

  it('save stamps updatedAt and keeps the index in sync', async () => {
    const clock = vi.fn(() => 5_000)
    const timed = new GameStore(dir, clock)
    await timed.load()
    const game = await timed.create(init())
    clock.mockReturnValue(9_000)
    game.status = 'finished'
    game.result = { outcome: '1-0', reason: 'checkmate' }
    await timed.save(game)

    expect(game.updatedAt).toBe(new Date(9_000).toISOString())
    expect(timed.list({ status: 'finished' })).toHaveLength(1)
    expect(timed.list()[0].result).toEqual({ outcome: '1-0', reason: 'checkmate' })
    const onDisk = JSON.parse(await readFile(join(dir, `${game.id}.json`), 'utf8')) as Game
    expect(onDisk.updatedAt).toBe(game.updatedAt)
  })

  it('exposes the analysis accuracy in the summary', async () => {
    const game = await store.create(init())
    game.analysis = {
      accuracy: { w: 88.5, b: 71 },
      acpl: { w: 20, b: 55 },
      keyMoments: [7],
      analyzedAt: new Date(0).toISOString()
    }
    await store.save(game)
    expect(store.list()[0].accuracy).toEqual({ w: 88.5, b: 71 })
  })

  it('merges stale finished-game coach and analysis snapshots in either save order', async () => {
    for (const order of ['analysis-first', 'coach-first'] as const) {
      const game = await store.create(init())
      game.moves.push({
        ply: 1,
        san: 'e4',
        uci: 'e2e4',
        fenAfter: 'after-e4',
        epdAfter: 'after-e4',
        by: 'user',
        liveEvalStatus: 'pending'
      })
      game.status = 'finished'
      game.result = { outcome: '1-0', reason: 'checkmate' }
      game.coachLog.push({
        id: 'existing-' + order,
        ply: 0,
        kind: 'question',
        text: 'existing',
        language: 'it',
        createdAt: '2026-01-01T00:00:00.000Z'
      })
      await store.save(game)

      const base = (await store.get(game.id))!
      const analysed = structuredClone(base)
      analysed.moves[0]!.eval = {
        before: { cp: 20 },
        after: { cp: 10 },
        cpLoss: 10,
        winPercentLoss: 1,
        classification: 'excellent',
        bestMove: 'e2e4',
        bestLine: ['e2e4']
      }
      analysed.moves[0]!.liveEval = {
        ...analysed.moves[0]!.eval!,
        depth: 16,
        assessedAt: '2026-01-01T00:00:01.000Z'
      }
      delete analysed.moves[0]!.liveEvalStatus
      analysed.moves[0]!.theme = 'development'
      analysed.analysis = {
        accuracy: { w: 99, b: 98 },
        acpl: { w: 10, b: 12 },
        keyMoments: [1],
        lesson: { takeaways: ['Develop'], summary: 'Sound play.', language: 'en' },
        analyzedAt: '2026-01-01T00:00:02.000Z'
      }
      analysed.opening = { eco: 'C20', name: "King's Pawn Game", lastBookPly: 1 }

      const commented = structuredClone(base)
      commented.moves[0]!.coachComment = 'Una mossa centrale.'
      commented.moves[0]!.coachCommentLanguage = 'it'
      commented.coachLog.push({
        id: 'comment-' + order,
        ply: 1,
        kind: 'comment',
        text: 'Una mossa centrale.',
        move: 'e4',
        language: 'it',
        createdAt: '2026-01-01T00:00:03.000Z'
      })

      const snapshots = order === 'analysis-first' ? [analysed, commented] : [commented, analysed]
      await Promise.all(snapshots.map((snapshot) => store.save(snapshot)))

      const saved = (await store.get(game.id))!
      expect(saved.analysis).toEqual(analysed.analysis)
      expect(saved.opening).toEqual(analysed.opening)
      expect(saved.moves[0]).toMatchObject({
        eval: analysed.moves[0]!.eval,
        liveEval: analysed.moves[0]!.liveEval,
        theme: 'development',
        coachComment: 'Una mossa centrale.',
        coachCommentLanguage: 'it'
      })
      expect(saved.moves[0]!.liveEvalStatus).toBeUndefined()
      expect(saved.coachLog.map((entry) => entry.id)).toEqual([
        'existing-' + order,
        'comment-' + order
      ])
      expect(store.list().find((entry) => entry.id === game.id)?.accuracy).toEqual({
        w: 99,
        b: 98
      })
    }
  })

  it('deletes a game from disk and from the index', async () => {
    const game = await store.create(init())
    await store.delete(game.id)
    expect(store.list()).toEqual([])
    expect(await store.get(game.id)).toBeNull()
    expect(await readdir(dir)).toEqual([])
    await expect(store.delete(game.id)).resolves.toBeUndefined()
  })

  it('does not let a stale async owner recreate a deleted game', async () => {
    const game = await store.create(init())
    const staleSnapshot = structuredClone(game)

    await store.delete(game.id)

    await expect(store.save(staleSnapshot)).resolves.toBe(false)
    expect(store.list()).toEqual([])
    expect(await store.get(game.id)).toBeNull()
    expect(await readdir(dir)).toEqual([])
  })

  it('rebuilds the index from disk on load and skips unusable files with a warning', async () => {
    const good = await store.create(init())
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.json'), '{ not json', 'utf8')
    await writeFile(join(dir, 'alien.json'), JSON.stringify({ hello: 'world' }), 'utf8')
    await writeFile(join(dir, 'notes.txt'), 'ignored', 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const fresh = new GameStore(dir)
    await fresh.load()

    expect(fresh.list().map((s) => s.id)).toEqual([good.id])
    expect(warn).toHaveBeenCalledTimes(2)
    // The unusable files are left alone: the user can still recover them by hand.
    expect((await readdir(dir)).sort()).toEqual(
      [`${good.id}.json`, 'alien.json', 'broken.json', 'notes.txt'].sort()
    )
  })

  it('removes stale tmp files left by an interrupted write on load', async () => {
    await mkdir(dir, { recursive: true })
    const stale = join(dir, 'game.json.abc.tmp')
    await writeFile(stale, '{}', 'utf8')
    const { utimes } = await import('node:fs/promises')
    const old = new Date(Date.now() - 600_000)
    await utimes(stale, old, old)

    const fresh = new GameStore(dir)
    await fresh.load()
    expect(await readdir(dir)).toEqual([])
  })

  it('works on a directory that does not exist yet', async () => {
    const missing = join(dir, 'nested', 'games')
    const fresh = new GameStore(missing)
    await expect(fresh.load()).resolves.toBeUndefined()
    expect(fresh.list()).toEqual([])
  })
})
