import { gameStatus } from '@shared/chess/notation'
import type { Analysis } from '@shared/types/engine'
import type { Eval, Move } from '@shared/types/game'
import type { AnalysisEngine } from '../analysis/pipeline'
import { classify } from '../analysis/classify'
import { internalCp, winPercent } from '../analysis/winPercent'

/** Shared in-flight searches keep the bar and badges to one 300ms search per position. */
export class LiveMoveEvaluator {
  private cache = new Map<string, Promise<Analysis>>()
  private controller = new AbortController()

  constructor(private readonly engine: AnalysisEngine) {}

  reset(): void {
    this.controller.abort()
    this.controller = new AbortController()
    this.cache.clear()
  }

  analyze(fen: string): Promise<Analysis> {
    const cached = this.cache.get(fen)
    if (cached) return cached
    const request = this.engine.analyze(fen, 'feedback', { signal: this.controller.signal })
    this.cache.set(fen, request)
    void request.catch(() => {
      if (this.cache.get(fen) === request) this.cache.delete(fen)
    })
    while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!)
    return request
  }

  async evaluate(
    beforeFen: string,
    move: Move,
    history: string[],
    now: () => number
  ): Promise<NonNullable<Move['liveEval']> | null> {
    const terminal = gameStatus(move.fenAfter, history)
    const before = await this.analyze(beforeFen)
    const line = before.lines[0]
    const beforeScore = score(line)
    const bestMove = before.bestMove ?? line?.move
    if (!beforeScore || !bestMove) return null
    let afterScore: Eval
    let depth = before.depth
    if (terminal.over) {
      // The mover just delivered mate; mate zero belongs to the winner here.
      afterScore = terminal.reason === 'checkmate' ? { mate: 0 } : { cp: 0 }
    } else {
      const after = await this.analyze(move.fenAfter)
      const raw = score(after.lines[0])
      if (!raw) return null
      afterScore = flipScore(raw)
      depth = Math.min(depth, after.depth)
    }
    const loss = Math.max(
      0,
      winPercent(internalCp(beforeScore)) - winPercent(internalCp(afterScore))
    )
    return {
      before: beforeScore,
      after: afterScore,
      cpLoss: Math.max(0, internalCp(beforeScore) - internalCp(afterScore)),
      winPercentLoss: loss,
      classification: classify({ loss, playedUci: move.uci, bestUci: bestMove, inBook: false }),
      bestMove,
      bestLine: line?.pv.slice(0, 12) ?? [],
      depth,
      assessedAt: new Date(now()).toISOString()
    }
  }
}

function score(line: Analysis['lines'][number] | undefined): Eval | null {
  if (Number.isFinite(line?.scoreMate)) return { mate: line!.scoreMate }
  if (Number.isFinite(line?.scoreCp)) return { cp: line!.scoreCp }
  return null
}

function flipScore(value: Eval): Eval {
  return value.mate !== undefined ? { mate: -value.mate } : { cp: -value.cp! }
}
