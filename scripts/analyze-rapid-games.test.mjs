import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Chess } from 'chess.js'
import { choosePlayers } from './collect-rapid-games.mjs'
import {
  analyze,
  buildProfiles,
  cpLoss,
  eloAnchor,
  lossBucket,
  observePosition,
  parseGame,
  playerSplit,
  quantiles,
  selectGames,
  selectPositions
} from './analyze-rapid-games.mjs'

function exampleGame(white, black, rating = 1200, number = 0) {
  const board = new Chess()
  board.header('Result', '1-0')
  for (let i = 0; i < 5; i++) {
    board.move('Nf3')
    board.move('Nf6')
    board.move('Ng1')
    board.move('Ng8')
  }
  return {
    uuid: `game-${number}`,
    url: `https://www.chess.com/game/live/${number}`,
    pgn: board.pgn(),
    white: { username: white, rating },
    black: { username: black, rating }
  }
}
function identity(split) {
  for (let i = 0; i < 1000; i++) {
    const name = `player${i}`
    if (playerSplit(name, 'test-seed') === split) return name
  }
  throw new Error('No identity in split')
}

describe('rapid analysis', () => {
  it('uses a split hash independent of collector account ranking', () => {
    const seed = 'rapid-2026-09'
    const accounts = choosePlayers(
      Array.from({ length: 10_000 }, (_, i) => `account${i}`),
      seed,
      400
    )
    const train = accounts.filter((name) => playerSplit(name, seed) === 'train').length
    expect(train).toBeGreaterThan(200)
    expect(train).toBeLessThan(390)
  })
  it('clamps ratings, uses ordered buckets and keeps mate scores separate', () => {
    expect(eloAnchor(100)).toBe(600)
    expect(eloAnchor(2600)).toBe(2400)
    expect(eloAnchor(1050)).toBe(900)
    expect(lossBucket(20)).toBe(0)
    expect(lossBucket(21)).toBe(1)
    expect(lossBucket(1200)).toBe(5)
    expect(lossBucket(1201)).toBe(6)
    expect(quantiles([0, 100])).toEqual([0, 50, 75, 90, 95, 99, 100])
    expect(cpLoss({ type: 'cp', value: 70 }, { type: 'cp', value: -20 }, 'e2e4', 'd2d4')).toEqual({
      cpLoss: 50,
      mateTransition: false
    })
    expect(cpLoss({ type: 'cp', value: 70 }, { type: 'cp', value: -20 }, 'd2d4', 'd2d4')).toEqual({
      cpLoss: 0,
      mateTransition: false
    })
    expect(cpLoss({ type: 'mate', value: 2 }, { type: 'cp', value: -20 }, 'e2e4', 'd2d4')).toEqual({
      cpLoss: null,
      mateTransition: true
    })
  })

  it('splits both players, rejects broken and short PGN, caps games, and samples deterministically', () => {
    const train = identity('train')
    const test = identity('test')
    const game = exampleGame(train, train, 1200, 1)
    expect(parseGame(game)).toHaveLength(20)
    expect(parseGame({ ...game, pgn: '[Result "*"]\n\n1. e4 *' })).toBeNull()
    expect(parseGame({ ...game, pgn: '[Variant "Chess960"]\n\n1. e4 e5 1-0' })).toBeNull()
    expect(() => playerSplit(undefined, 'test-seed')).toThrow('Missing player identity')
    const input = [
      game,
      exampleGame(train, test, 1200, 2),
      exampleGame(train, train, 1200, 3),
      { ...game, uuid: 'broken', pgn: 'invalid' }
    ]
    const chosen = selectGames(input, 'test-seed', 20, 2)
    expect(chosen.selected).toHaveLength(2)
    expect(chosen.skipped.crossSplit).toBe(1)
    expect(chosen.skipped.invalidPgn).toBe(1)
    const sample = selectPositions(chosen.selected, 'sample', 2)
    expect(sample.positions).toHaveLength(4)
    expect(sample.positions.map((p) => p.key)).toEqual(
      selectPositions([...chosen.selected].reverse(), 'sample', 2).positions.map((p) => p.key)
    )
  })

  it('excludes out-of-range mover ratings while retaining the other side', () => {
    const train = identity('train')
    const game = exampleGame(train, train, 1200, 50)
    game.white.rating = 400
    const { selected } = selectGames([game], 'test-seed', 1)
    const sample = selectPositions(selected, 'test-seed', 2)
    expect(sample.outOfRangePositions).toEqual({ train: 10, test: 0 })
    expect(sample.positions).toHaveLength(4)
    expect(sample.positions.every((p) => p.rating === 1200 && p.elo === 1200)).toBe(true)
  })

  it('forms only finite train profiles and measures conditional counts', () => {
    const base = {
      split: 'train',
      elo: 1200,
      phase: 'middlegame',
      player: 'a',
      gameKey: 'g',
      rootWithinRange: true,
      inCheck: false,
      hasCapture: true
    }
    const profiles = buildProfiles([
      { ...base, cpLoss: 0 },
      { ...base, cpLoss: 70, inCheck: true },
      { ...base, samplePhase: 'all', cpLoss: 0 },
      { ...base, cpLoss: null },
      { ...base, cpLoss: 900, rootWithinRange: false },
      { ...base, cpLoss: 80, split: 'test' }
    ])
    expect(profiles).toHaveLength(2)
    expect(profiles[0]).toMatchObject({
      elo: 1200,
      phase: 'middlegame',
      count: 2,
      players: 1,
      games: 1,
      lossCounts: [1, 0, 1, 0, 0, 0, 0],
      inCheck: { count: 1 },
      hasCapture: { count: 2 }
    })
  })

  it('counts a played checkmate without searching a terminal child', async () => {
    const board = new Chess('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1')
    const beforeFen = board.fen()
    const move = board.move('Qg7#')
    const engine = {
      searches: 0,
      async search() {
        this.searches++
        return { score: { type: 'mate', value: 1 }, bestUci: 'f7g7' }
      }
    }
    const result = await observePosition(
      { beforeFen, afterFen: board.fen(), playedUci: move.from + move.to },
      engine
    )
    expect(engine.searches).toBe(1)
    expect(result).toMatchObject({
      cpLoss: null,
      mateTransition: true,
      childScore: { type: 'mate', value: 0 }
    })
  })

  it('runs an end-to-end pilot with an injected deterministic engine', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rapid-analysis-'))
    try {
      const train = identity('train')
      const games = Array.from({ length: 8 }, (_, i) => exampleGame(train, train, 1200, i))
      let searches = 0
      const options = {
        input: '',
        out: join(directory, 'calibration.json'),
        observations: join(directory, 'observations.jsonl'),
        nodes: 1000,
        positionsPerCell: 2,
        seed: 'test-seed',
        workers: 4,
        maxGames: 20
      }
      const artifact = await analyze(options, {
        games,
        cacheDir: join(directory, 'cache'),
        engineFactory: () => ({
          name: 'FakeEngine',
          searches: 0,
          async search() {
            this.searches++
            searches++
            await new Promise((r) => setTimeout(r, 5))
            return this.searches % 2
              ? { score: { type: 'cp', value: 50 }, bestUci: 'a2a3' }
              : { score: { type: 'cp', value: -20 }, bestUci: 'a2a3' }
          },
          close() {}
        })
      })
      expect(artifact.coverage.acceptedGames).toBe(8)
      expect(artifact.coverage.profilePositions).toBe(4)
      expect(searches).toBe(4)
      expect(artifact.coverage.reusedPositions).toBeGreaterThan(0)
      expect(artifact.profiles.find((p) => p.phase === 'all')).toMatchObject({
        count: 2,
        quantilesCp: [30, 30, 30, 30, 30, 30, 30]
      })
      expect(artifact.openings.some((o) => o.count >= 8)).toBe(true)
      expect(JSON.parse(await readFile(options.out, 'utf8')).schemaVersion).toBe(1)
      expect(await readFile(options.out, 'utf8')).not.toContain(train)
      expect((await readFile(options.observations, 'utf8')).trim().split('\n')).toHaveLength(4)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
