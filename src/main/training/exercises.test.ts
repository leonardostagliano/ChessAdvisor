import { Chess } from 'chess.js'
import { applyMove, epdOf, legalMoves } from '@shared/chess/notation'
import type { Analysis } from '@shared/types/engine'
import type { Game, Move, MoveClassification } from '@shared/types/game'
import type { Exercise } from '@shared/types/training'
import { describe, expect, it } from 'vitest'
import {
  buildExercise,
  extractCandidates,
  judgeAttempt,
  MAX_SOLUTION_PLIES,
  startProgress,
  type ExerciseCandidate,
  type ExerciseEngine
} from './exercises'

const MIDDLEGAME = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'

/**
 * A Stockfish stand-in: at every call it answers with the legal moves of the position, sorted as
 * `legalMoves` sorts them, and with the score and the gaps the test asked for. That keeps the
 * lines playable — the builder really plays them — while the numbers stay under the test's control.
 */
class FakeEngine implements ExerciseEngine {
  readonly calls: string[] = []

  constructor(private readonly plan: { score: number; gaps?: number[] }[]) {}

  async analyze(fen: string): Promise<Analysis> {
    const step = this.plan[Math.min(this.calls.length, this.plan.length - 1)] ?? { score: 0 }
    this.calls.push(fen)
    const moves = legalMoves(fen)
    if (moves.length === 0) return { bestMove: null, lines: [], depth: 20, fen }
    const best = moves[0]!
    const after = applyMove(fen, best.uci)
    const reply = after ? legalMoves(after.fen)[0] : undefined
    const lines = [
      { move: best.uci, pv: reply ? [best.uci, reply.uci] : [best.uci], scoreCp: step.score, depth: 20 },
      ...(step.gaps ?? []).map((gap, index) => {
        const other = moves[index + 1] ?? best
        return { move: other.uci, pv: [other.uci], scoreCp: step.score - gap, depth: 20 }
      })
    ]
    return { bestMove: best.uci, lines, depth: 20, fen }
  }
}

function candidateOf(fen: string, patch: Partial<ExerciseCandidate> = {}): ExerciseCandidate {
  const moves = legalMoves(fen)
  return {
    gameId: 'g1',
    ply: 7,
    fen,
    sideToMove: fen.split(' ')[1] === 'b' ? 'b' : 'w',
    // Anything but the move the engine will answer with, so the exercise is worth playing.
    playedUci: moves[moves.length - 1]!.uci,
    san: moves[moves.length - 1]!.san,
    theme: 'fork',
    lossCp: 250,
    ...patch
  }
}

/** A game whose plies carry exactly the evaluations the test wants to filter on. */
function gameWith(specs: { by: 'user' | 'ai'; classification?: MoveClassification; before?: number; after?: number; mate?: boolean }[]): Game {
  const chess = new Chess()
  const moves: Move[] = specs.map((spec, index) => {
    const played = chess.move(chess.moves()[0]!)
    const move: Move = {
      ply: index + 1,
      san: played.san,
      uci: played.lan,
      fenAfter: chess.fen(),
      epdAfter: epdOf(chess.fen()),
      by: spec.by
    }
    if (spec.classification) {
      move.eval = {
        before: spec.mate ? { mate: 3 } : { cp: spec.before ?? 0 },
        after: spec.mate ? { mate: -2 } : { cp: spec.after ?? 0 },
        cpLoss: (spec.before ?? 0) - (spec.after ?? 0),
        winPercentLoss: 25,
        classification: spec.classification,
        bestMove: 'e2e4',
        bestLine: ['e2e4']
      }
    }
    return move
  })
  return {
    id: 'g1',
    createdAt: '2026-03-01T10:00:00.000Z',
    updatedAt: '2026-03-01T10:30:00.000Z',
    kind: 'match',
    status: 'finished',
    userColor: 'w',
    opponent: { model: 'gpt-6-astra', effort: 'medium', difficulty: { mode: 'fixed', level: 3, targetElo: 1200 } },
    coach: { model: 'gpt-6-astra', effort: 'medium' },
    clock: null,
    language: 'it',
    moves,
    takebacks: 0,
    coachLog: []
  }
}

describe('extractCandidates', () => {
  it('keeps the user mistakes that cost at least 150 internal centipawns', () => {
    const game = gameWith([
      { by: 'user', classification: 'mistake', before: 40, after: -200 },
      { by: 'ai', classification: 'blunder', before: 300, after: -100 },
      { by: 'user', classification: 'inaccuracy', before: 20, after: -160 },
      { by: 'ai' },
      { by: 'user', classification: 'blunder', before: 10, after: -20 }
    ])
    expect(extractCandidates(game).map((candidate) => candidate.ply)).toEqual([1])
  })

  it('drops a mistake played from an already decided position', () => {
    const decided = gameWith([{ by: 'user', classification: 'blunder', before: 900, after: 200 }])
    expect(extractCandidates(decided)).toEqual([])
  })

  it('keeps a decided position when the evaluation speaks of mate', () => {
    const mateSequence = gameWith([{ by: 'user', classification: 'blunder', mate: true }])
    expect(extractCandidates(mateSequence)).toHaveLength(1)
  })

  it('carries the theme of the move and falls back on the taxonomy', () => {
    const game = gameWith([{ by: 'user', classification: 'mistake', before: 0, after: -300 }])
    expect(extractCandidates(game)[0]?.theme).toBe('missed_tactic')
    game.moves[0]!.theme = 'back_rank'
    expect(extractCandidates(game)[0]?.theme).toBe('back_rank')
  })

  it('starts an exercise from the position the move was played in, not from the one it reached', () => {
    const game = gameWith([{ by: 'user', classification: 'mistake', before: 0, after: -300 }])
    expect(extractCandidates(game)[0]?.fen).toBe('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1')
  })
})

describe('buildExercise', () => {
  it('builds a line of four plies when the move is unique and the evaluation holds', async () => {
    const engine = new FakeEngine([{ score: 320, gaps: [250] }])
    const exercise = await buildExercise(candidateOf(MIDDLEGAME), engine, { now: () => 0 })
    expect(exercise).not.toBeNull()
    expect(exercise!.solution).toHaveLength(MAX_SOLUTION_PLIES)
    expect(exercise!.alternatives).toBeUndefined()
    expect(exercise!.id).toBe('og-g1-7')
    expect(exercise!.kind).toBe('own_game')
    expect(exercise!.sourcePly).toBe(7)
    expect(exercise!.status).toBe('new')
  })

  it('records an equally good second line as an alternative', async () => {
    const engine = new FakeEngine([{ score: 300, gaps: [40] }, { score: 300, gaps: [400] }])
    const exercise = await buildExercise(candidateOf(MIDDLEGAME), engine, { now: () => 0 })
    expect(exercise!.alternatives).toHaveLength(1)
    expect(exercise!.alternatives![0]).toHaveLength(1)
    expect(exercise!.alternatives![0]![0]).not.toBe(exercise!.solution[0])
  })

  it('discards a position with more than two equally good moves', async () => {
    const engine = new FakeEngine([{ score: 300, gaps: [10, 20, 30] }])
    expect(await buildExercise(candidateOf(MIDDLEGAME), engine, { now: () => 0 })).toBeNull()
  })

  it('stops the solution when the evaluation drifts between two user plies', async () => {
    const engine = new FakeEngine([
      { score: 300, gaps: [250] },
      { score: 360, gaps: [250] }
    ])
    const exercise = await buildExercise(candidateOf(MIDDLEGAME), engine, { now: () => 0 })
    expect(exercise!.solution).toHaveLength(2)
  })

  it('answers null when the engine has nothing to say', async () => {
    const engine: ExerciseEngine = { analyze: async (fen) => ({ bestMove: null, lines: [], depth: 0, fen }) }
    expect(await buildExercise(candidateOf(MIDDLEGAME), engine, { now: () => 0 })).toBeNull()
  })

  it('answers null when the solution is the move the user actually played', async () => {
    const best = legalMoves(MIDDLEGAME)[0]!
    const engine = new FakeEngine([{ score: 300, gaps: [250] }])
    expect(await buildExercise(candidateOf(MIDDLEGAME, { playedUci: best.uci }), engine, { now: () => 0 })).toBeNull()
  })
})

describe('judgeAttempt', () => {
  const exercise = (patch: Partial<Exercise> = {}): Exercise => ({
    id: 'og-g1-7',
    kind: 'own_game',
    fen: MIDDLEGAME,
    sideToMove: 'w',
    solution: buildLine(MIDDLEGAME, 4),
    theme: 'fork',
    status: 'new',
    attempts: 0,
    createdAt: '2026-03-01T10:00:00.000Z',
    ...patch
  })

  it('plays the reply automatically after a correct move', () => {
    const current = exercise()
    const { result, progress } = judgeAttempt(current, startProgress(current), current.solution[0]!)
    expect(result.correct).toBe(true)
    expect(result.done).toBe(false)
    expect(result.reply).toBe(current.solution[1])
    expect(progress.index).toBe(2)
    expect(result.fen).toBe(progress.fen)
  })

  it('leaves the position where it was after a wrong move', () => {
    const current = exercise()
    const other = legalMoves(MIDDLEGAME).find((move) => move.uci !== current.solution[0])!
    const { result, progress } = judgeAttempt(current, startProgress(current), other.uci)
    expect(result).toEqual({ correct: false, done: false, fen: MIDDLEGAME, alternativesAccepted: false })
    expect(progress.index).toBe(0)
  })

  it('refuses a move that is not legal at all', () => {
    const current = exercise()
    expect(judgeAttempt(current, startProgress(current), 'not-a-move').result.correct).toBe(false)
  })

  it('is done when the last user move of the line has been played', () => {
    const current = exercise()
    const first = judgeAttempt(current, startProgress(current), current.solution[0]!)
    const second = judgeAttempt(current, first.progress, current.solution[2]!)
    expect(second.result.correct).toBe(true)
    expect(second.result.done).toBe(true)
  })

  it('accepts an alternative at its own ply and ends the exercise there', () => {
    const alternative = legalMoves(MIDDLEGAME).find((move) => move.uci !== buildLine(MIDDLEGAME, 1)[0])!
    const current = exercise({ alternatives: [[alternative.uci]] })
    const { result, progress } = judgeAttempt(current, startProgress(current), alternative.uci)
    expect(result.correct).toBe(true)
    expect(result.done).toBe(true)
    expect(result.alternativesAccepted).toBe(true)
    expect(progress.index).toBe(current.solution.length)
  })

  it('does not accept an alternative meant for another ply', () => {
    const line = buildLine(MIDDLEGAME, 4)
    const alternative = ['a2a3', 'a7a6', 'b2b3']
    const current = exercise({ solution: line, alternatives: [alternative] })
    expect(judgeAttempt(current, startProgress(current), 'b2b3').result.correct).toBe(false)
  })
})

/** The first legal move of every position in a row: a playable line, whatever it is worth. */
function buildLine(fen: string, plies: number): string[] {
  const line: string[] = []
  let current = fen
  for (let i = 0; i < plies; i += 1) {
    const move = legalMoves(current)[0]
    if (!move) break
    line.push(move.uci)
    const played = applyMove(current, move.uci)
    if (!played) break
    current = played.fen
  }
  return line
}
