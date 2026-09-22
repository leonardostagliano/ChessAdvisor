import { describe, expect, it, vi } from 'vitest'
import { applyMove } from '@shared/chess/notation'
import type { Analysis } from '@shared/types/engine'
import type { Move } from '@shared/types/game'
import { LiveMoveEvaluator } from './liveMoveEvaluator'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
function moved(fen: string, uci: string): Move {
  const result = applyMove(fen, uci)!
  return { ply: 1, san: result.san, uci, fenAfter: result.fen, epdAfter: '', by: 'user' }
}
function analysis(fen: string, cp: number, bestMove = 'd2d4'): Analysis {
  return {
    fen,
    bestMove,
    depth: 16,
    lines: [{ move: bestMove, pv: [bestMove], scoreCp: cp, depth: 16 }]
  }
}

describe('LiveMoveEvaluator', () => {
  it('shares pending searches with the bar and measures loss from the white mover', async () => {
    const move = moved(START, 'e2e4')
    const analyze = vi.fn(async (fen: string) => analysis(fen, fen === START ? 20 : 500))
    const evaluator = new LiveMoveEvaluator({ analyze })
    const prewarm = evaluator.analyze(START)
    const result = await evaluator.evaluate(START, move, [START, move.fenAfter], () => 0)
    await prewarm
    expect(analyze).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      before: { cp: 20 },
      after: { cp: -500 },
      cpLoss: 520,
      classification: 'blunder',
      depth: 16
    })
  })

  it('measures loss from black without reversing the quality', async () => {
    const before = moved(START, 'e2e4').fenAfter
    const move = moved(before, 'e7e5')
    const evaluator = new LiveMoveEvaluator({
      analyze: async (fen) => analysis(fen, fen === before ? 20 : 500, 'c7c5')
    })
    const result = await evaluator.evaluate(before, move, [before, move.fenAfter], () => 0)
    expect(result).toMatchObject({
      before: { cp: 20 },
      after: { cp: -500 },
      cpLoss: 520,
      classification: 'blunder'
    })
  })

  it('recognises the best move without reporting search noise as a mistake', async () => {
    const move = moved(START, 'e2e4')
    const evaluator = new LiveMoveEvaluator({ analyze: async (fen) => analysis(fen, 0, 'e2e4') })
    expect(await evaluator.evaluate(START, move, [START, move.fenAfter], () => 0)).toMatchObject({
      classification: 'best'
    })
  })

  it('does not invent a score when the engine has no scored line', async () => {
    const move = moved(START, 'e2e4')
    const evaluator = new LiveMoveEvaluator({
      analyze: async (fen) => ({ fen, lines: [], bestMove: null, depth: 0 })
    })
    expect(await evaluator.evaluate(START, move, [START, move.fenAfter], () => 0)).toBeNull()
  })

  it('evaluates checkmate as winning for the mover without searching an empty position', async () => {
    const before = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1'
    const move = moved(before, 'f7g7')
    const analyze = vi.fn(async (fen: string) => analysis(fen, 1000, 'f7g7'))
    const evaluator = new LiveMoveEvaluator({ analyze })
    const result = await evaluator.evaluate(before, move, [before, move.fenAfter], () => 0)
    expect(result).toMatchObject({ after: { mate: 0 }, cpLoss: 0, classification: 'best' })
    expect(analyze).toHaveBeenCalledTimes(1)
  })

  it('cancels obsolete searches and clears their cache on undo', async () => {
    const signals: AbortSignal[] = []
    const analyze = vi.fn(
      async (fen: string, _profile: unknown, opts?: { signal?: AbortSignal }) => {
        signals.push(opts!.signal!)
        return analysis(fen, 0)
      }
    )
    const evaluator = new LiveMoveEvaluator({ analyze })
    await evaluator.analyze(START)
    evaluator.reset()
    await evaluator.analyze(START)
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    expect(analyze).toHaveBeenCalledTimes(2)
  })
})
