import { epdOf } from '@shared/chess/notation'
import type { Analysis, AnalysisProfile } from '@shared/types/engine'
import type { Eval, Game, Move } from '@shared/types/game'
import { acpl, gameAccuracy } from './accuracy'
import { classify } from './classify'
import { detectOpening, EMPTY_BOOK, MAX_BOOK_PLIES, type OpeningBook } from './openings'
import { internalCp, winPercent, winPercentLoss } from './winPercent'

/**
 * Post-game analysis (spec §3.1, AnalysisPipeline).
 *
 * Every position of the game is analysed once with the `review` profile (depth 20, MultiPV 2), so
 * a move's evaluation *after* is simply the evaluation of the next position: one search per ply
 * plus one, never two. From those searches come the per-move judgement, the accuracy and ACPL of
 * both colours, the key moments (the user's mistakes and blunders) and the opening name.
 *
 * PERSPECTIVES. The engine scores are from the side to move; they are turned into White's point of
 * view to be compared, and each `Move.eval` is finally stored **from the point of view of the
 * player who made that move** — so `before` above zero always means "the mover stood well".
 */

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

/** Plies of the best line saved with a move: enough to show the idea, not a whole game. */
const BEST_LINE_PLIES = 8

/** The slice of `EngineService` the pipeline needs. */
export interface AnalysisEngine {
  analyze(fen: string, profile: AnalysisProfile, opts?: { signal?: AbortSignal }): Promise<Analysis>
}

export interface AnalysisProgress {
  gameId: string
  ply: number
  total: number
}

export interface AnalyzeGameOptions {
  signal?: AbortSignal
  now?: () => number
}

const sideToMove = (fen: string): 'w' | 'b' => (fen.split(/\s+/)[1] === 'b' ? 'b' : 'w')

/** One searched position: the engine's own choice and its score, already White's. */
interface Searched {
  fen: string
  bestUci: string
  bestLine: string[]
  score: Eval
}

function whiteScore(analysis: Analysis, fen: string): Eval {
  const line = analysis.lines[0]
  const flip = sideToMove(fen) === 'b' ? -1 : 1
  if (line && typeof line.scoreMate === 'number') return { mate: flip * line.scoreMate }
  if (line && typeof line.scoreCp === 'number') return { cp: flip * line.scoreCp }
  return { cp: 0 }
}

/** Turns a White-perspective evaluation into `mover`'s own point of view. */
function fromMover(value: Eval, mover: 'w' | 'b'): Eval {
  if (mover === 'w') return { ...value }
  if (typeof value.mate === 'number') return { mate: -value.mate }
  return { cp: -(value.cp ?? 0) }
}

/** Positions of the game, starting position included: index *i* is the position after ply *i*. */
export function positionsOf(game: Game): string[] {
  return [game.startFen ?? START_FEN, ...game.moves.map((move) => move.fenAfter)]
}

/**
 * Fills `game.moves[].eval`, `game.analysis` and `game.opening` in place and returns the same
 * object. It never writes anything to disk: persisting the result is the caller's job.
 */
export async function analyzeGame(game: Game, engine: AnalysisEngine, openings: OpeningBook = EMPTY_BOOK, onProgress?: (p: AnalysisProgress) => void, opts?: AnalyzeGameOptions): Promise<Game> {
  const now = opts?.now ?? Date.now
  const fens = positionsOf(game)
  const total = game.moves.length

  const opening = detectOpening(fens, openings)
  if (opening) game.opening = opening

  /**
   * Rule 5: a move is `book` when the position it *reaches* is itself in the dataset — not when it
   * merely precedes a later recognised position. The dataset has gaps inside well-known lines (the
   * Ruy Lopez Morphy line has none of 4. Ba4 and 4… Nf6 but does have 5. O-O), so a real blunder
   * played inside theory must still be judged and still reach the key moments.
   */
  const inBookAt = (ply: number): boolean => ply <= MAX_BOOK_PLIES && openings.byEpd.has(epdOf(fens[ply] ?? ''))

  const search = async (fen: string): Promise<Searched> => {
    const analysis = await engine.analyze(fen, 'review', opts?.signal ? { signal: opts.signal } : undefined)
    const line = analysis.lines[0]
    const bestUci = analysis.bestMove ?? line?.move ?? ''
    const pv = line && line.pv.length > 0 ? line.pv : bestUci ? [bestUci] : []
    return { fen, bestUci, bestLine: pv.slice(0, BEST_LINE_PLIES), score: whiteScore(analysis, fen) }
  }

  /** Per move, in ply order: what the accuracy and ACPL formulas need. */
  const perMove: { loss: number; winBefore: number; mover: 'w' | 'b' }[] = []
  const losses: { color: 'w' | 'b'; cpLossInternal: number; evalBeforeCp: number }[] = []

  let before = await search(fens[0]!)
  for (let ply = 1; ply <= total; ply += 1) {
    const move = game.moves[ply - 1]!
    const after = await search(fens[ply]!)
    const mover = sideToMove(before.fen)

    const cpLoss = Math.max(0, (mover === 'b' ? -1 : 1) * (internalCp(before.score) - internalCp(after.score)))
    const loss = winPercentLoss(before.score, after.score, mover)
    const evaluation: NonNullable<Move['eval']> = {
      before: fromMover(before.score, mover),
      after: fromMover(after.score, mover),
      cpLoss,
      winPercentLoss: loss,
      classification: classify({ loss, playedUci: move.uci, bestUci: before.bestUci, inBook: inBookAt(ply) }),
      bestMove: before.bestUci,
      bestLine: [...before.bestLine]
    }
    move.eval = evaluation

    perMove.push({ loss, winBefore: winPercent(internalCp(before.score)), mover })
    losses.push({ color: mover, cpLossInternal: cpLoss, evalBeforeCp: internalCp(before.score) })

    onProgress?.({ gameId: game.id, ply, total })
    before = after
  }

  const byColor = (color: 'w' | 'b'): { cpLossInternal: number; evalBeforeCp: number }[] =>
    losses.filter((entry) => entry.color === color).map(({ cpLossInternal, evalBeforeCp }) => ({ cpLossInternal, evalBeforeCp }))

  game.analysis = {
    accuracy: { w: round(gameAccuracy(perMove, 'w'), 1), b: round(gameAccuracy(perMove, 'b'), 1) },
    acpl: { w: Math.round(acpl(byColor('w'))), b: Math.round(acpl(byColor('b'))) },
    // Rule 8: only the user's own mistakes are worth reviewing.
    keyMoments: game.moves.filter((move) => move.by === 'user' && (move.eval?.classification === 'mistake' || move.eval?.classification === 'blunder')).map((move) => move.ply),
    ...(game.analysis?.lesson ? { lesson: game.analysis.lesson } : {}),
    analyzedAt: new Date(now()).toISOString()
  }
  return game
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
