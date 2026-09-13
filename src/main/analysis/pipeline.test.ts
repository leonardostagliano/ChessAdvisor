import { Chess } from 'chess.js'
import { epdOf, legalMoves } from '@shared/chess/notation'
import type { Analysis, AnalysisProfile } from '@shared/types/engine'
import type { Game, Move } from '@shared/types/game'
import { describe, expect, it } from 'vitest'
import { loadOpenings, type OpeningBook } from './openings'
import { analyzeGame, positionsOf, START_FEN, type AnalysisProgress } from './pipeline'
import { resolve } from 'node:path'

const DATASET = resolve(__dirname, '../../../resources/data/openings.json')

/** Builds a finished game out of SAN moves; the user has White, so odd plies are theirs. */
function gameOf(sans: string[], patch: Partial<Game> = {}): Game {
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
    id: 'g1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'match',
    status: 'finished',
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
  }
}

/**
 * Engine whose verdict on each position is scripted by index (White's point of view, centipawns);
 * it answers in the engine's own convention, i.e. from the side to move.
 */
interface FakeEngine {
  calls: { fen: string; profile: AnalysisProfile }[]
  /** Must be called with the positions of the game, in order, before analysing. */
  script(fens: string[]): void
  analyze(fen: string, profile: AnalysisProfile): Promise<Analysis>
}

function fakeEngine(scores: number[], bestBy?: (fen: string, index: number) => string): FakeEngine {
  const calls: { fen: string; profile: AnalysisProfile }[] = []
  const index = new Map<string, number>()
  return {
    calls,
    script(fens: string[]): void {
      fens.forEach((fen, position) => index.set(fen, position))
    },
    analyze: async (fen: string, profile: AnalysisProfile): Promise<Analysis> => {
      calls.push({ fen, profile })
      const position = index.get(fen) ?? 0
      const white = scores[position] ?? 0
      const flip = fen.split(/\s+/)[1] === 'b' ? -1 : 1
      const best = bestBy ? bestBy(fen, position) : (legalMoves(fen)[0]?.uci ?? '')
      return {
        bestMove: best,
        lines: [
          { move: best, pv: [best], scoreCp: flip * white, depth: 20 },
          { move: best, pv: [best], scoreCp: flip * white - 30, depth: 20 }
        ],
        depth: 20,
        fen
      }
    }
  }
}

const openings = (): OpeningBook => loadOpenings(DATASET)

describe('analyzeGame', () => {
  it('fills every ply, names the opening and reports its progress', async () => {
    const game = gameOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5'])
    const engine = fakeEngine([20, 25, 20, 30, 25, 30])
    engine.script(positionsOf(game))
    const progress: AnalysisProgress[] = []

    await analyzeGame(game, engine, openings(), (event) => progress.push(event), {
      now: () => Date.parse('2026-02-02T10:00:00.000Z')
    })

    expect(game.moves.every((move) => move.eval !== undefined)).toBe(true)
    expect(game.opening).toEqual({ eco: 'C60', name: 'Ruy Lopez', lastBookPly: 5 })
    expect(game.analysis?.analyzedAt).toBe('2026-02-02T10:00:00.000Z')
    expect(progress.map((event) => event.ply)).toEqual([1, 2, 3, 4, 5])
    expect(progress.every((event) => event.total === 5 && event.gameId === 'g1')).toBe(true)
    // One search per position, never two for the same one.
    expect(engine.calls).toHaveLength(6)
    expect(engine.calls.every((call) => call.profile === 'review')).toBe(true)
  })

  it('stores each evaluation from the point of view of the player who moved', async () => {
    // White is +100 all along; after Black's first move White is +300.
    const game = gameOf(['e4', 'e5'])
    const engine = fakeEngine([100, 100, 300])
    engine.script(positionsOf(game))

    await analyzeGame(game, engine, openings())

    const white = game.moves[0]!.eval!
    const black = game.moves[1]!.eval!
    expect(white.before).toEqual({ cp: 100 })
    expect(white.after).toEqual({ cp: 100 })
    expect(white.cpLoss).toBe(0)
    // Black stood at −100 and ended at −300: the loss is Black's own.
    expect(black.before).toEqual({ cp: -100 })
    expect(black.after).toEqual({ cp: -300 })
    expect(black.cpLoss).toBe(200)
    expect(black.winPercentLoss).toBeGreaterThan(10)
  })

  it('keeps the book moves out of the judgement and classifies the rest', async () => {
    // 1. e4 e5 2. Nf3 is theory; 3… Qh4 (not in the book) throws the game away.
    const game = gameOf(['e4', 'e5', 'Nf3', 'Qh4'])
    const engine = fakeEngine([0, 0, 0, 0, 900], (fen) => legalMoves(fen)[0]?.uci ?? '')
    engine.script(positionsOf(game))

    await analyzeGame(game, engine, openings())

    expect(game.opening?.eco).toBe('C40')
    expect(game.moves.slice(0, 3).map((move) => move.eval?.classification)).toEqual([
      'book',
      'book',
      'book'
    ])
    expect(game.moves[3]!.eval?.classification).toBe('blunder')
    expect(game.moves[3]!.eval?.bestMove).toBe(legalMoves(game.moves[2]!.fenAfter)[0]?.uci)
    expect(game.moves[3]!.eval?.bestLine.length).toBeGreaterThan(0)
  })

  it('judges a move that leaves the dataset even when a later position of the line is book', async () => {
    // The Ruy Lopez Morphy line has gaps: 4. Ba4 (ply 7) and 4… Nf6 (ply 8) are absent from the
    // dataset, 5. O-O (ply 9) is back in it. A blunder played in the gap must still be judged.
    const game = gameOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6', 'Ba4', 'Nf6', 'O-O'])
    const book = openings()
    const bookPlies = positionsOf(game)
      .map((fen, ply) => (ply > 0 && book.byEpd.has(epdOf(fen)) ? ply : 0))
      .filter((ply) => ply > 0)
    expect(bookPlies).toEqual([1, 2, 3, 4, 5, 6, 9])

    // Even at +20, White throws the game away with 4. Ba4 (ply 7): the score collapses to −900.
    const engine = fakeEngine(
      [20, 20, 20, 20, 20, 20, 20, -900, -900, -900],
      (fen, index) => legalMoves(fen).find((move) => move.uci !== game.moves[index]?.uci)?.uci ?? ''
    )
    engine.script(positionsOf(game))

    await analyzeGame(game, engine, book)

    expect(game.opening?.lastBookPly).toBe(9)
    expect(game.moves.map((move) => move.eval?.classification)).toEqual([
      'book',
      'book',
      'book',
      'book',
      'book',
      'book',
      'blunder',
      'excellent',
      'book'
    ])
    expect(game.moves[6]!.eval!.winPercentLoss).toBeGreaterThan(30)
    expect(game.analysis?.keyMoments).toEqual([7])
  })

  it('marks only the user’s own mistakes as key moments', async () => {
    const game = gameOf(['h4', 'e5', 'a4', 'Qh4'])
    // Ply 3 (the user's) and ply 4 (the AI's) both lose a lot; only the user's is a key moment.
    const engine = fakeEngine([0, 0, 0, -600, 600])
    engine.script(positionsOf(game))

    // No book here: every ply must be judged on its own merits.
    await analyzeGame(game, engine, { byEpd: new Map() })

    expect(game.moves[2]!.eval?.classification).toBe('blunder')
    expect(game.moves[3]!.eval?.classification).toBe('blunder')
    expect(game.analysis?.keyMoments).toEqual([3])
  })

  it('computes accuracy and ACPL for both colours', async () => {
    const game = gameOf(['e4', 'e5', 'Nf3', 'Nc6'])
    // White keeps a steady edge, Black gives away 150 cp with its second move.
    const engine = fakeEngine([20, 20, 20, 20, 170])
    engine.script(positionsOf(game))

    await analyzeGame(game, engine, openings())

    const analysis = game.analysis!
    expect(analysis.accuracy.w).toBeGreaterThan(analysis.accuracy.b)
    expect(analysis.acpl.w).toBe(0)
    expect(analysis.acpl.b).toBe(75)
    expect(analysis.accuracy.w).toBeLessThanOrEqual(100)
    expect(analysis.accuracy.b).toBeGreaterThanOrEqual(0)
  })

  it('is idempotent: the same game analysed twice gives the same numbers', async () => {
    const game = gameOf(['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'])
    const scores = [10, 15, 12, 40, 35, 300, 290]
    const first = fakeEngine(scores)
    first.script(positionsOf(game))
    await analyzeGame(game, first, openings(), undefined, { now: () => 0 })
    const snapshot = JSON.parse(JSON.stringify(game))

    const second = fakeEngine(scores)
    second.script(positionsOf(game))
    await analyzeGame(game, second, openings(), undefined, { now: () => 0 })

    expect(JSON.parse(JSON.stringify(game))).toEqual(snapshot)
  })

  it('analyses a game that never left the starting position without crying', async () => {
    const game = gameOf([])
    const engine = fakeEngine([0])
    engine.script([START_FEN])

    await analyzeGame(game, engine, openings())

    expect(game.analysis?.keyMoments).toEqual([])
    expect(game.analysis?.accuracy).toEqual({ w: 100, b: 100 })
    expect(game.opening).toBeUndefined()
  })
})
