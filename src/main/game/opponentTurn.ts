import { legalMoves, normalizeMove, type LegalMove } from '@shared/chess/notation'
import type { TurnFailureReason, TurnResult } from '@shared/types/codex'
import type { CodexService } from '../codex/codexService'
import type { EngineService } from '../engine/engineService'
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
  fen: string
  pgn: string
  lastUserMove: string | null
  takebackNotice: number | null
  timeoutMs: number
  streamId: string
  onDelta(kind: 'text' | 'reasoning', delta: string): void
  onRetry(attempt: number, why: string): void
}

export interface OpponentMove {
  san: string
  uci: string
  shortComment: string | null
  fallback?: 'engine' | 'random'
  effectiveModel: string | null
  /** Wall time of the attempt that produced the move. */
  thinkingMs: number
  /** Wall time burned by the attempts that had to be thrown away. */
  overheadMs: number
  attempts: number
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
  return { move: record.move, shortComment: typeof comment === 'string' && comment.length > 0 ? comment : null }
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
const RETRYABLE: readonly TurnFailureReason[] = ['failed', 'timeout', 'invalid-items', 'no-message', 'server-request']

function describeFailure(result: Extract<TurnResult, { ok: false }>): string {
  return `${result.reason}: ${result.message}`
}

/** Picks the engine's best move, or nothing when the engine is unavailable or unhelpful. */
async function engineMove(deps: OpponentDeps, fen: string): Promise<LegalMove | null> {
  if (!deps.engine.state().available) return null
  try {
    const analysis = await deps.engine.analyze(fen, 'coach')
    const best = analysis.bestMove ?? analysis.lines[0]?.move ?? null
    return best ? normalizeMove(fen, best) : null
  } catch (error) {
    console.error('[opponent] the engine fallback failed:', error)
    return null
  }
}

export async function playOpponentTurn(deps: OpponentDeps, p: OpponentTurnParams): Promise<OpponentMove> {
  const legal = legalMoves(p.fen)
  if (legal.length === 0) throw new Error(`no legal move in ${p.fen}`)

  let text = opponentTurnText({
    lastUserMove: p.lastUserMove,
    fen: p.fen,
    pgn: p.pgn,
    legal,
    takebackNotice: p.takebackNotice,
    language: p.language
  })
  let overheadMs = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
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

    if (result.ok) {
      const answer = parseAnswer(result.text)
      const move = answer ? normalizeMove(p.fen, answer.move) : null
      if (answer && move) {
        return {
          san: move.san,
          uci: move.uci,
          shortComment: answer.shortComment,
          effectiveModel: result.effectiveModel,
          thinkingMs: elapsed,
          overheadMs,
          attempts: attempt
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

  // Three attempts spent: play on regardless, with the badge the UI shows next to the move.
  const best = await engineMove(deps, p.fen)
  const chosen = best ?? legal[Math.floor(Math.random() * legal.length)]!
  return {
    san: chosen.san,
    uci: chosen.uci,
    shortComment: null,
    fallback: best ? 'engine' : 'random',
    effectiveModel: null,
    thinkingMs: 0,
    overheadMs,
    attempts: MAX_ATTEMPTS
  }
}
