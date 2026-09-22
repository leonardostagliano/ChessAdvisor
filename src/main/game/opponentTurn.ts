import {
  applyMove,
  gameStatus,
  legalMoves,
  normalizeMove,
  type LegalMove
} from '@shared/chess/notation'
import type { TurnFailureReason, TurnResult } from '@shared/types/codex'
import type { Analysis, AnalysisProfile, EngineLine } from '@shared/types/engine'
import type { OpeningBook } from '../analysis/openings'
import { nearestLevel, type DifficultyLevel, type OpponentDifficulty } from '@shared/types/session'
import type { CodexService } from '../codex/codexService'
import type { EngineService } from '../engine/engineService'
import {
  contextLines,
  difficultyPolicy,
  lineUtility,
  sampledCandidate,
  shouldAdjustModelMove
} from './difficultyPolicy'
import { opponentBookContext } from './opponentBook'
import { OPPONENT_MOVE_SCHEMA, opponentTurnText } from './prompts'

/**
 * One opponent move, retries and fallback included (spec §4.1).
 *
 * The model answers with structured JSON, the move is validated locally against chess.js, and an
 * answer that is not a legal move — or a turn that failed, timed out or used a tool — buys one
 * more attempt with the error quoted back. After three attempts the move comes from Stockfish
 * (`fallback:'engine'`) or, with no engine available, from a random legal move
 * (`fallback:'random'`): the game never stalls on a model that cannot follow the schema.
 *
 * Quota and interruption are different in kind: they are not the model's mistake and retrying
 * makes them worse, so they surface as {@link OpponentTurnError} for the session to handle.
 */

/** Maximum attempts of spec §4.1: the first try plus two retries. */
export const MAX_ATTEMPTS = 3
/** How much of the offending answer is quoted back to the model in the retry text. */
const RAW_QUOTE_CHARS = 200

/** A failure the retry loop must not swallow: the session decides what happens next. */
export class OpponentTurnError extends Error {
  constructor(
    readonly reason: 'quota' | 'interrupted',
    message: string
  ) {
    super(message)
    this.name = 'OpponentTurnError'
  }
}

export interface OpponentDeps {
  codex: Pick<CodexService, 'runTurn'>
  engine: Pick<EngineService, 'analyze' | 'state'>
  now(): number
}

export interface OpponentTurnParams {
  threadId: string
  model: string
  effort: string
  language: 'it' | 'en'
  difficulty: OpponentDifficulty
  /** Optional local opening archive used only as non-binding context. */
  openingBook?: OpeningBook
  fen: string
  pgn: string
  lastUserMove: string | null
  takebackNotice: number | null
  timeoutMs: number
  streamId: string
  /** Match opponents may resign; drills keep playing the position out. */
  allowResign?: boolean
  /** The preceding opponent turn was already evaluated as hopeless. */
  previousHopeless?: boolean
  /** Cancels preparatory/verification searches when this turn becomes stale. */
  signal?: AbortSignal
  /** Stable per-game entropy for controlled candidate sampling. */
  difficultySeed?: string
  onDelta(kind: 'text' | 'reasoning', delta: string): void
  onRetry(attempt: number, why: string): void
}

export interface OpponentMove {
  san: string
  uci: string
  shortComment: string | null
  /** Set when the opponent adjudicates its own position as hopeless instead of moving. */
  resign?: true
  fallback?: 'engine' | 'random'
  effectiveModel: string | null
  /** Wall time of the attempt that produced the move. */
  thinkingMs: number
  /** Wall time burned by the attempts that had to be thrown away. */
  overheadMs: number
  attempts: number
  /** A calculated multi-PV reference was included in the model prompt. */
  engineAssisted?: boolean
  /** The selected continuation was independently checked before it was accepted. */
  engineVerified?: boolean
}

/** More difficult opponents receive progressively deeper and broader calculated context. */
export const OPPONENT_PROFILE: Record<DifficultyLevel, AnalysisProfile> = {
  1: 'opponent-beginner',
  2: 'opponent-easy',
  3: 'opponent-medium',
  4: 'opponent-challenging',
  5: 'opponent-strong',
  6: 'opponent'
}

/** Maximum tolerated loss against the best calculated continuation, in centipawns. */
export const MAX_MOVE_LOSS_CP: Record<DifficultyLevel, number> = {
  1: 1200,
  2: 700,
  3: 350,
  4: 200,
  5: 100,
  6: 50
}

const RESIGN_BELOW_CP: Record<DifficultyLevel, number> = {
  1: -2400,
  2: -1800,
  3: -1400,
  4: -1100,
  5: -900,
  6: -700
}

const MIN_CONFIDENT_DEPTH: Record<DifficultyLevel, number> = {
  1: 8,
  2: 10,
  3: 13,
  4: 16,
  5: 18,
  6: 20
}

const MATE_SCORE = 100_000

function resolvedLevel(difficulty: OpponentDifficulty): DifficultyLevel {
  return difficulty.mode === 'adaptive'
    ? nearestLevel(difficulty.targetElo ?? 1200)
    : difficulty.level
}

function abortIfRequested(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('opponent turn aborted')
  error.name = 'AbortError'
  throw error
}

function lineScore(line: EngineLine | undefined): number | null {
  return lineUtility(line)
}

function bestLine(analysis: Analysis): EngineLine | undefined {
  return analysis.lines.find((line) => line.move === analysis.bestMove) ?? analysis.lines[0]
}

async function analyze(
  deps: OpponentDeps,
  fen: string,
  profile: AnalysisProfile,
  signal?: AbortSignal
): Promise<Analysis | null> {
  abortIfRequested(signal)
  if (!deps.engine.state().available) return null
  try {
    const result = await deps.engine.analyze(fen, profile, { signal })
    abortIfRequested(signal)
    return result
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    console.error('[opponent] ' + profile + ' analysis failed:', error)
    return null
  }
}

function materialBalance(fen: string): number {
  const fields = fen.trim().split(/\s+/)
  const side = fields[1]
  const board = fields[0] ?? ''
  const value: Record<string, number> = { p: 100, n: 320, b: 330, r: 500, q: 900 }
  let white = 0
  let black = 0
  for (const piece of board) {
    const points = value[piece.toLowerCase()] ?? 0
    if (piece >= 'A' && piece <= 'Z') white += points
    else black += points
  }
  return side === 'b' ? black - white : white - black
}

function plyOf(fen: string): number {
  const fields = fen.trim().split(/\s+/)
  const fullmove = Number(fields[5])
  return Number.isFinite(fullmove)
    ? Math.max(0, (fullmove - 1) * 2 + (fields[1] === 'b' ? 1 : 0))
    : 0
}

/** Conservative adjudication: forced mate, or a sustained/severe disadvantage with deep evidence. */
export function shouldOpponentResign(
  fen: string,
  analysis: Analysis,
  level: DifficultyLevel,
  previousHopeless = false
): boolean {
  const best = bestLine(analysis)
  if (!best || best.depth < MIN_CONFIDENT_DEPTH[level]) return false
  if (typeof best.scoreMate === 'number') return best.scoreMate < 0
  const score = lineScore(best)
  if (score === null || score > RESIGN_BELOW_CP[level] || plyOf(fen) < 10) return false
  return previousHopeless || materialBalance(fen) <= -900
}

/** Models like to wrap JSON in ``` fences even when the schema forbids prose. */
function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  return trimmed
    .replace(/^```[a-zA-Z]*\s*/, '')
    .replace(/```\s*$/, '')
    .trim()
}

function parseAnswer(text: string): { move: string; shortComment: string | null } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(text))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (typeof record.move !== 'string' || record.move.trim().length === 0) return null
  const comment = record.shortComment
  return {
    move: record.move,
    shortComment: typeof comment === 'string' && comment.length > 0 ? comment : null
  }
}

function retryText(previous: string, raw: string, language: 'it' | 'en'): string {
  const quoted = raw.replace(/\s+/g, ' ').trim().slice(0, RAW_QUOTE_CHARS)
  const notice =
    language === 'it'
      ? `ERRORE: la risposta precedente ("${quoted}") non è una mossa legale o non è JSON valido. Rispondi SOLO con il JSON richiesto e scegli una mossa dalla lista.`
      : `ERROR: the previous answer ("${quoted}") is not a legal move or is not valid JSON. Answer ONLY with the requested JSON and pick a move from the list.`
  return `${previous}\n\n${notice}`
}

/** Failures that are worth another attempt; `quota` and `interrupted` never are. */
const RETRYABLE: readonly TurnFailureReason[] = [
  'failed',
  'timeout',
  'invalid-items',
  'no-message',
  'server-request'
]

function describeFailure(result: Extract<TurnResult, { ok: false }>): string {
  return `${result.reason}: ${result.message}`
}

/** Picks the same policy-controlled candidate used for a model fallback. */
async function engineMove(
  deps: OpponentDeps,
  fen: string,
  profile: AnalysisProfile,
  prepared: Analysis | null,
  policy: ReturnType<typeof difficultyPolicy>,
  seed: string,
  signal?: AbortSignal
): Promise<LegalMove | null> {
  const analysis = prepared ?? (await analyze(deps, fen, profile, signal))
  abortIfRequested(signal)
  const sampled = analysis ? sampledCandidate(analysis.lines, policy, seed) : null
  const sampledMove = sampled ? normalizeMove(fen, sampled.move) : null
  if (sampledMove) return sampledMove
  const best = analysis?.bestMove ?? (analysis ? bestLine(analysis)?.move : null) ?? null
  return best ? normalizeMove(fen, best) : null
}

function unsafeMoveRetryText(
  previous: string,
  move: LegalMove,
  lossCp: number,
  maximumCp: number,
  reference: EngineLine | undefined,
  language: 'it' | 'en'
): string {
  const pv = reference?.pv.join(' ') || reference?.move || 'n/a'
  const rounded = Math.round(lossCp)
  const notice =
    language === 'it'
      ? `CONTROLLO TATTICO: ${move.san} perde circa ${rounded} centipawn rispetto alla variante migliore, oltre il limite di ${maximumCp} per questo livello. Variante di riferimento: ${pv}. Ricalcola autonomamente almeno fino a una posizione stabile, considera anche mosse legali fuori dalle varianti fornite e scegli una mossa più solida.`
      : `TACTICAL CHECK: ${move.san} loses about ${rounded} centipawns versus the best continuation, beyond this level's ${maximumCp} limit. Reference line: ${pv}. Recalculate independently until the position is stable, also consider legal moves outside the supplied lines, and choose a sounder move.`
  return `${previous}\n\n${notice}`
}

async function selectedMoveLoss(
  deps: OpponentDeps,
  fen: string,
  move: LegalMove,
  prepared: Analysis | null,
  signal?: AbortSignal
): Promise<number | null> {
  if (!prepared) return null
  const bestScore = lineScore(bestLine(prepared))
  const applied = applyMove(fen, move.uci)
  if (bestScore === null || !applied) return null
  const terminal = gameStatus(applied.fen)
  if (terminal.over) {
    const resultScore = terminal.reason === 'checkmate' ? MATE_SCORE : 0
    return Math.max(0, bestScore - resultScore)
  }
  const replyAnalysis = await analyze(deps, applied.fen, 'opponent-check', signal)
  const replyScore = replyAnalysis ? lineScore(bestLine(replyAnalysis)) : null
  if (replyScore === null) return null
  // The child position belongs to the other side, so its score is negated back to the AI's view.
  return Math.max(0, bestScore + replyScore)
}

export async function playOpponentTurn(
  deps: OpponentDeps,
  p: OpponentTurnParams
): Promise<OpponentMove> {
  const legal = legalMoves(p.fen)
  if (legal.length === 0) throw new Error(`no legal move in ${p.fen}`)

  const level = resolvedLevel(p.difficulty)
  const profile = OPPONENT_PROFILE[level]
  const policy = difficultyPolicy(p.difficulty)
  const seed = p.difficultySeed ?? `${p.fen}\u0000${p.pgn}`
  const opening = p.openingBook ? opponentBookContext(p.fen, legal, p.openingBook) : null
  const prepared = await analyze(deps, p.fen, profile, p.signal)
  // The engine may inspect several candidates internally, but weak tiers are not handed the
  // strongest PV as a ready-made answer. The complete legal list below remains unrestricted.
  const promptLines = contextLines(prepared?.lines ?? [], policy)
  if (
    p.allowResign &&
    prepared &&
    shouldOpponentResign(p.fen, prepared, level, p.previousHopeless)
  ) {
    return {
      san: '',
      uci: '',
      shortComment: p.language === 'it' ? 'Mi arrendo.' : 'I resign.',
      resign: true,
      effectiveModel: null,
      thinkingMs: 0,
      overheadMs: 0,
      attempts: 0,
      engineAssisted: true,
      engineVerified: true
    }
  }

  let text = opponentTurnText({
    lastUserMove: p.lastUserMove,
    fen: p.fen,
    pgn: p.pgn,
    legal,
    analysisLines: promptLines,
    opening,
    takebackNotice: p.takebackNotice,
    language: p.language
  })
  let overheadMs = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    abortIfRequested(p.signal)
    const startedAt = deps.now()
    const result = await deps.codex.runTurn(
      {
        threadId: p.threadId,
        text,
        model: p.model,
        effort: p.effort,
        outputSchema: OPPONENT_MOVE_SCHEMA,
        language: p.language,
        timeoutMs: p.timeoutMs,
        streamId: p.streamId
      },
      p.onDelta
    )
    const elapsed = Math.max(0, deps.now() - startedAt)
    abortIfRequested(p.signal)

    if (result.ok) {
      const answer = parseAnswer(result.text)
      const move = answer ? normalizeMove(p.fen, answer.move) : null
      if (answer && move) {
        const lossCp = await selectedMoveLoss(deps, p.fen, move, prepared, p.signal)
        const maximumLoss = policy.maximumLossCp
        if (lossCp !== null && lossCp > maximumLoss) {
          overheadMs += elapsed
          const why = `unsafe move "${move.san}" loses ${Math.round(lossCp)} cp`
          p.onRetry(attempt, why)
          text = unsafeMoveRetryText(text, move, lossCp, maximumLoss, promptLines[0], p.language)
          continue
        }
        const sampled = prepared ? sampledCandidate(prepared.lines, policy, seed) : null
        const adjusted =
          sampled && shouldAdjustModelMove(policy, seed) ? normalizeMove(p.fen, sampled.move) : null
        if (adjusted && adjusted.uci !== move.uci) {
          const adjustedLoss = await selectedMoveLoss(deps, p.fen, adjusted, prepared, p.signal)
          // The policy may only soften a too-accurate answer. It must never replace a natural
          // human inaccuracy with a stronger engine candidate.
          if (
            lossCp !== null &&
            adjustedLoss !== null &&
            adjustedLoss > lossCp + 10 &&
            adjustedLoss <= maximumLoss
          ) {
            return {
              san: adjusted.san,
              uci: adjusted.uci,
              // The model wrote its comment for a different move; do not attach misleading prose.
              shortComment: null,
              effectiveModel: result.effectiveModel,
              thinkingMs: elapsed,
              overheadMs,
              attempts: attempt,
              engineAssisted: true,
              engineVerified: adjustedLoss !== null
            }
          }
        }
        return {
          san: move.san,
          uci: move.uci,
          shortComment: answer.shortComment,
          effectiveModel: result.effectiveModel,
          thinkingMs: elapsed,
          overheadMs,
          attempts: attempt,
          engineAssisted: prepared !== null,
          engineVerified: lossCp !== null
        }
      }
      overheadMs += elapsed
      const why = answer ? `illegal move "${answer.move}"` : 'the answer is not the requested JSON'
      p.onRetry(attempt, why)
      text = retryText(text, result.text, p.language)
      continue
    }

    // Not the model's fault and not worth retrying: the session pauses or discards the turn.
    if (result.reason === 'quota' || result.reason === 'interrupted') {
      throw new OpponentTurnError(result.reason, result.message)
    }
    if (!RETRYABLE.includes(result.reason)) throw new Error(describeFailure(result))

    overheadMs += elapsed
    p.onRetry(attempt, describeFailure(result))
    text = retryText(text, result.message, p.language)
  }

  // Three unusable or unsafe answers spent: play on with the exact same tier policy.
  abortIfRequested(p.signal)
  const best = await engineMove(deps, p.fen, profile, prepared, policy, seed, p.signal)
  abortIfRequested(p.signal)
  const chosen = best ?? legal[Math.floor(Math.random() * legal.length)]!
  return {
    san: chosen.san,
    uci: chosen.uci,
    shortComment: null,
    fallback: best ? 'engine' : 'random',
    effectiveModel: null,
    thinkingMs: 0,
    overheadMs,
    attempts: MAX_ATTEMPTS,
    engineAssisted: prepared !== null,
    engineVerified: best !== null
  }
}
