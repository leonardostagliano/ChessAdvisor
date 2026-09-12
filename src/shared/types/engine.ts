/**
 * Stockfish analysis contract shared by main and renderer.
 *
 * SCORE SIGN: every `scoreCp`/`scoreMate` here is in UCI convention, i.e. from the point of
 * view of the side to move in `Analysis.fen`. The AnalysisPipeline (M3) and the eval bar are
 * responsible for converting to White's perspective; the engine layer never flips a sign.
 */
export interface EngineLine {
  /** First move of the principal variation, UCI (`e2e4`, `e7e8q`). */
  move: string
  /** Principal variation in UCI, `move` included. */
  pv: string[]
  scoreCp?: number
  scoreMate?: number
  depth: number
}

export interface Analysis {
  /** `bestmove` reported by the engine; `null` when the engine answered `bestmove (none)`. */
  bestMove: string | null
  /** One entry per MultiPV slot, sorted by multipv ascending (line 1 first). */
  lines: EngineLine[]
  /** Deepest depth reached by any line. */
  depth: number
  fen: string
}

export type AnalysisProfile = 'live' | 'coach' | 'review'

export interface EngineState {
  available: boolean
  binary: 'avx2' | 'popcnt' | 'none'
  version: string | null
  /** Why the engine is unavailable, or a note about the probe; `null` when all is well. */
  message: string | null
}
