import { applyMove, normalizeMove } from '@shared/chess/notation'
import type { Analysis, AnalysisProfile } from '@shared/types/engine'
import type { Game } from '@shared/types/game'
import type { AttemptResult, Exercise, Side } from '@shared/types/training'
import { START_FEN } from '../analysis/pipeline'
import { internalCp } from '../analysis/winPercent'
import { normalizeTheme } from '../profile/themes'

/**
 * Exercises carved out of the user's own games (spec §6.4).
 *
 * The idea is narrow on purpose: a position the user actually had on the board, one move they got
 * wrong, and a short line that proves what they missed. Everything here is about earning that
 * claim — the engine has to agree that the move is *the* move (uniqueness), and the line has to
 * stay flat enough that the point is one idea and not a long calculation.
 *
 * SIGNS. `Move.eval` is stored from the point of view of the player who made the move, and the
 * engine scores of a search are from the side to move — which, at every user ply of a solution,
 * is the user. So every number in this file is already "good for the user when positive" and no
 * perspective is ever flipped.
 */

/** How much the mistake must have cost, in internal centipawns (spec §6.4). */
export const MIN_CANDIDATE_LOSS_CP = 150
/** Positions already decided are not lessons: beyond this the candidate is dropped (spec §6.4). */
export const MAX_CANDIDATE_EVAL_CP = 600
/** How much worse the second engine line must be for the solution to be unique (spec §6.4). */
export const UNIQUE_MARGIN_CP = 100
/** How much the evaluation may drift between two user plies before the line stops (spec §6.4). */
export const SOLUTION_DRIFT_CP = 30
/** Plies of a solution, replies included (spec §6.4). */
export const MAX_SOLUTION_PLIES = 4
/** Beyond this many equally good moves the position is not an exercise at all (spec §6.4). */
export const MAX_ALTERNATIVES = 2

/** The slice of `EngineService` the builder needs. */
export interface ExerciseEngine {
  analyze(fen: string, profile: AnalysisProfile, opts?: { signal?: AbortSignal }): Promise<Analysis>
}

/** One user mistake worth turning into an exercise, before the engine has verified anything. */
export interface ExerciseCandidate {
  gameId: string
  /** Ply of the mistake, 1-based, as in `Move.ply`. */
  ply: number
  /** Position the mistake was played from: the position the exercise starts at. */
  fen: string
  sideToMove: Side
  /** What the user played there, UCI. */
  playedUci: string
  san: string
  /** Theme of the fixed taxonomy: the label of the move, or the fallback (spec §6.3). */
  theme: string
  /** How much the move cost, in internal centipawns. */
  lossCp: number
}

const sideToMove = (fen: string): Side => (fen.split(/\s+/)[1] === 'b' ? 'b' : 'w')

/** Deterministic id: re-analysing a game updates its exercises instead of duplicating them. */
export const ownGameExerciseId = (gameId: string, ply: number): string => `og-${gameId}-${ply}`

/**
 * The user's mistakes and blunders that are worth an exercise (spec §6.4).
 *
 * Two filters beyond the classification: the move must have cost at least
 * {@link MIN_CANDIDATE_LOSS_CP}, and the position must still have been undecided — unless the
 * evaluation speaks of mate, which is precisely the sequence worth practising.
 */
export function extractCandidates(game: Game): ExerciseCandidate[] {
  const candidates: ExerciseCandidate[] = []
  let fen = game.startFen ?? START_FEN
  for (const move of game.moves) {
    const from = fen
    fen = move.fenAfter
    if (move.by !== 'user') continue
    const evaluation = move.eval
    if (!evaluation) continue
    if (evaluation.classification !== 'mistake' && evaluation.classification !== 'blunder') continue

    const before = internalCp(evaluation.before)
    const lossCp = before - internalCp(evaluation.after)
    if (lossCp < MIN_CANDIDATE_LOSS_CP) continue
    const mateSequence = typeof evaluation.before.mate === 'number' || typeof evaluation.after.mate === 'number'
    if (!mateSequence && Math.abs(before) > MAX_CANDIDATE_EVAL_CP) continue

    candidates.push({
      gameId: game.id,
      ply: move.ply,
      fen: from,
      sideToMove: sideToMove(from),
      playedUci: move.uci,
      san: move.san,
      theme: normalizeTheme(move.theme),
      lossCp
    })
  }
  return candidates
}

/** Internal centipawns of one engine line, from the point of view of the side to move. */
function lineScore(line: { scoreCp?: number; scoreMate?: number } | undefined): number | null {
  if (!line) return null
  if (typeof line.scoreMate === 'number') return internalCp({ mate: line.scoreMate })
  if (typeof line.scoreCp === 'number') return internalCp({ cp: line.scoreCp })
  return null
}

/**
 * Turns one candidate into a playable exercise, or answers `null` when the engine does not back
 * it up (spec §6.4).
 *
 * At every user ply the position is searched with the `review` profile (MultiPV 2): the first line
 * is the solution's move, and the second one either is far enough behind — the move is unique — or
 * becomes an *alternative*, a line of the exercise whose last move is an equally good answer at
 * that ply. More than {@link MAX_ALTERNATIVES} of those and the position is simply not sharp
 * enough to be an exercise. The line then grows as long as the evaluation stays inside
 * {@link SOLUTION_DRIFT_CP} from one user ply to the next, up to {@link MAX_SOLUTION_PLIES}
 * plies; the opponent replies come from the principal variation and are played automatically.
 */
export async function buildExercise(
  candidate: ExerciseCandidate,
  engine: ExerciseEngine,
  opts?: { now?: () => number; signal?: AbortSignal }
): Promise<Exercise | null> {
  const signal = opts?.signal ? { signal: opts.signal } : undefined
  const solution: string[] = []
  const alternatives: string[][] = []
  let fen = candidate.fen
  let previousScore: number | null = null

  while (solution.length < MAX_SOLUTION_PLIES) {
    const analysis = await engine.analyze(fen, 'review', signal)
    const best = analysis.lines[0]
    const bestUci = best?.move || analysis.bestMove || ''
    if (!best || !bestUci) break

    const score = lineScore(best)
    // A search that says nothing cannot prove anything: the line stops where it is.
    if (score === null) break
    // Spec §6.4: the line is one idea, so the evaluation must hold from one user ply to the next.
    if (previousScore !== null && Math.abs(score - previousScore) >= SOLUTION_DRIFT_CP) break
    previousScore = score

    // The `review` profile searches two lines, so in practice this looks at the second one; an
    // engine that answers with more simply has every one of them judged by the same rule.
    for (const other of analysis.lines.slice(1)) {
      const otherScore = lineScore(other)
      if (otherScore === null || score - otherScore >= UNIQUE_MARGIN_CP) continue
      if (!other.move || other.move === bestUci) continue
      alternatives.push([...solution, other.move])
      if (alternatives.length > MAX_ALTERNATIVES) return null
    }

    const played = applyMove(fen, bestUci)
    const playedUci = normalizeMove(fen, bestUci)?.uci
    if (!played || !playedUci) break
    solution.push(playedUci)
    fen = played.fen
    if (solution.length >= MAX_SOLUTION_PLIES) break

    // The reply is the second move of the principal variation; a search answers when the line
    // was too short, and nothing at all means the position is over — the exercise ends here.
    const reply = await resolveReply(fen, best.pv[1], engine, signal)
    if (!reply) break
    solution.push(reply.uci)
    fen = reply.fen
  }

  if (solution.length === 0) return null
  // An exercise whose answer is the move the user actually played teaches nothing.
  if (solution[0] === candidate.playedUci) return null

  const now = opts?.now ?? Date.now
  return {
    id: ownGameExerciseId(candidate.gameId, candidate.ply),
    kind: 'own_game',
    fen: candidate.fen,
    sideToMove: candidate.sideToMove,
    solution,
    ...(alternatives.length > 0 ? { alternatives } : {}),
    theme: candidate.theme,
    sourceGameId: candidate.gameId,
    sourcePly: candidate.ply,
    status: 'new',
    attempts: 0,
    createdAt: new Date(now()).toISOString()
  }
}

async function resolveReply(
  fen: string,
  fromPv: string | undefined,
  engine: ExerciseEngine,
  signal: { signal: AbortSignal } | undefined
): Promise<{ uci: string; fen: string } | null> {
  const fromLine = fromPv ? normalizeMove(fen, fromPv) : null
  const chosen = fromLine ?? (await searchReply(fen, engine, signal))
  if (!chosen) return null
  const played = applyMove(fen, chosen.uci)
  return played ? { uci: chosen.uci, fen: played.fen } : null
}

async function searchReply(fen: string, engine: ExerciseEngine, signal: { signal: AbortSignal } | undefined): Promise<{ uci: string } | null> {
  try {
    const analysis = await engine.analyze(fen, 'review', signal)
    const uci = analysis.lines[0]?.move || analysis.bestMove || ''
    const normalized = uci ? normalizeMove(fen, uci) : null
    return normalized ? { uci: normalized.uci } : null
  } catch {
    return null
  }
}

// ────────────────────────────────────────────────────────── playing an exercise

/** How far an exercise has been played: the index of the next move of `solution`. */
export interface ExerciseProgress {
  /** Index into `Exercise.solution`; even indices are the user's own moves. */
  index: number
  /** Position on the board right now. */
  fen: string
}

/** The position an exercise starts from, with nothing played yet. */
export function startProgress(exercise: Exercise): ExerciseProgress {
  return { index: 0, fen: exercise.fen }
}

/**
 * One move played inside an exercise (spec §6.4).
 *
 * The main line is the truth; an *alternative* — an equally good move the builder recorded at that
 * very ply — is accepted too, and ends the exercise, because past the point where the line forked
 * the app has no verified continuation to answer with. A wrong move leaves the position where it
 * was, so the user simply tries again.
 */
export function judgeAttempt(exercise: Exercise, progress: ExerciseProgress, uci: string): { result: AttemptResult; progress: ExerciseProgress } {
  const stay = (result: AttemptResult): { result: AttemptResult; progress: ExerciseProgress } => ({ result, progress })
  const wrong: AttemptResult = { correct: false, done: false, fen: progress.fen, alternativesAccepted: false }

  const expected = exercise.solution[progress.index]
  if (!expected) {
    // Nothing left to play: the exercise is already over, whatever the move was.
    return stay({ correct: false, done: true, fen: progress.fen, alternativesAccepted: false })
  }
  const normalized = normalizeMove(progress.fen, uci)
  if (!normalized) return stay(wrong)

  if (normalized.uci !== expected) {
    if (!acceptsAlternative(exercise, progress.index, normalized.uci)) return stay(wrong)
    const played = applyMove(progress.fen, normalized.uci)
    if (!played) return stay(wrong)
    return {
      result: { correct: true, done: true, fen: played.fen, alternativesAccepted: true },
      progress: { index: exercise.solution.length, fen: played.fen }
    }
  }

  const played = applyMove(progress.fen, normalized.uci)
  if (!played) return stay(wrong)
  let index = progress.index + 1
  let fen = played.fen

  const reply = exercise.solution[index]
  const replied = reply ? applyMove(fen, reply) : null
  if (reply && replied) {
    fen = replied.fen
    index += 1
  }

  return {
    result: {
      correct: true,
      done: index >= exercise.solution.length,
      ...(reply && replied ? { reply } : {}),
      fen,
      alternativesAccepted: false
    },
    progress: { index, fen }
  }
}

/** True when `uci` is one of the equally good moves recorded for this very ply. */
function acceptsAlternative(exercise: Exercise, index: number, uci: string): boolean {
  for (const line of exercise.alternatives ?? []) {
    if (line.length !== index + 1) continue
    if (line[index] !== uci) continue
    // The alternative has to branch off the line that was actually played up to here.
    if (line.slice(0, index).every((move, i) => move === exercise.solution[i])) return true
  }
  return false
}
