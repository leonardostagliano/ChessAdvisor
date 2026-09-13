import { legalMoves } from '@shared/chess/notation'
import type { TurnRequest, TurnResult } from '@shared/types/codex'
import type { Analysis, AnalysisProfile, EngineState } from '@shared/types/engine'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_ATTEMPTS,
  OpponentTurnError,
  playOpponentTurn,
  type OpponentDeps
} from './opponentTurn'

/** After 1. e4: Black to move, so the opponent under test plays Black. */
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'

const ok = (text: string, effectiveModel: string | null = null): TurnResult => ({
  ok: true,
  text,
  turnId: 't1',
  effectiveModel,
  durationMs: 10
})

const answer = (move: string, shortComment: string | null = 'ok'): TurnResult =>
  ok(JSON.stringify({ move, shortComment }))

type RunTurn = OpponentDeps['codex']['runTurn']

function deps(
  script: TurnResult[],
  engine?: Partial<{ available: boolean; bestMove: string | null }>
): OpponentDeps & { runTurn: ReturnType<typeof vi.fn<RunTurn>> } {
  const available = engine?.available ?? false
  const runTurn = vi.fn<RunTurn>(async () => script.shift() ?? ok('{}'))
  // Every call advances the clock by one second, so an attempt always costs exactly 1000 ms.
  let clock = 0
  return {
    runTurn,
    codex: { runTurn },
    engine: {
      state: (): EngineState => ({
        available,
        binary: available ? 'avx2' : 'none',
        version: 'fake',
        message: null
      }),
      analyze: async (fen: string, _profile: AnalysisProfile): Promise<Analysis> => ({
        bestMove: engine?.bestMove === undefined ? 'g8f6' : engine.bestMove,
        lines: [],
        depth: 18,
        fen
      })
    },
    now: () => (clock += 1000)
  }
}

const params = (
  over: Partial<Parameters<typeof playOpponentTurn>[1]> = {}
): Parameters<typeof playOpponentTurn>[1] => ({
  threadId: 'thread-1',
  model: 'gpt-6-astra',
  effort: 'medium',
  language: 'it',
  fen: AFTER_E4,
  pgn: '1. e4',
  lastUserMove: 'e4',
  takebackNotice: null,
  timeoutMs: 5000,
  streamId: 'stream-1',
  onDelta: () => undefined,
  onRetry: () => undefined,
  ...over
})

describe('playOpponentTurn', () => {
  it('accepts a legal move on the first attempt', async () => {
    const d = deps([answer('e5', 'la tua mossa preferita?')])
    const move = await playOpponentTurn(d, params())
    expect(move).toMatchObject({
      san: 'e5',
      uci: 'e7e5',
      shortComment: 'la tua mossa preferita?',
      attempts: 1
    })
    expect(move.fallback).toBeUndefined()
    expect(move.thinkingMs).toBe(1000)
    expect(move.overheadMs).toBe(0)
    expect(d.runTurn).toHaveBeenCalledTimes(1)

    const request = d.runTurn.mock.calls[0]![0] as TurnRequest
    expect(request.outputSchema).toBeDefined()
    expect(request.text).toContain(`FEN: ${AFTER_E4}`)
    expect(request.streamId).toBe('stream-1')
    expect(request.timeoutMs).toBe(5000)
  })

  it('reports the model the app-server rerouted to', async () => {
    const d = deps([ok(JSON.stringify({ move: 'e5', shortComment: null }), 'gpt-6-astra-mini')])
    await expect(playOpponentTurn(d, params())).resolves.toMatchObject({
      effectiveModel: 'gpt-6-astra-mini',
      shortComment: null
    })
  })

  it('retries an illegal move quoting it back, and counts the wasted time as overhead', async () => {
    const d = deps([answer('Qh4'), answer('Nf6')])
    const onRetry = vi.fn()
    const move = await playOpponentTurn(d, params({ onRetry }))
    expect(move).toMatchObject({ san: 'Nf6', attempts: 2, thinkingMs: 1000, overheadMs: 1000 })
    expect(onRetry).toHaveBeenCalledTimes(1)
    expect(onRetry.mock.calls[0]![0]).toBe(1)

    const retryText = (d.runTurn.mock.calls[1]![0] as TurnRequest).text
    expect(retryText).toContain('ERRORE')
    expect(retryText).toContain('Qh4')
  })

  it('retries a failed turn without treating it as a model mistake', async () => {
    const d = deps([
      { ok: false, reason: 'failed', message: 'fake failure', turnId: 't1' },
      answer('e5')
    ])
    const move = await playOpponentTurn(d, params())
    expect(move).toMatchObject({ san: 'e5', attempts: 2, overheadMs: 1000 })
  })

  it('falls back to the engine best move after three unusable answers', async () => {
    const d = deps([ok('not json at all'), ok('```json\n{"move":\n'), ok('{"move": 42}')], {
      available: true,
      bestMove: 'g8f6'
    })
    const onRetry = vi.fn()
    const move = await playOpponentTurn(d, params({ onRetry }))
    expect(move).toMatchObject({
      san: 'Nf6',
      uci: 'g8f6',
      fallback: 'engine',
      attempts: MAX_ATTEMPTS,
      shortComment: null
    })
    expect(move.overheadMs).toBe(3000)
    expect(onRetry).toHaveBeenCalledTimes(MAX_ATTEMPTS)
  })

  it('accepts JSON wrapped in a code fence', async () => {
    const d = deps([ok('```json\n{"move":"e5","shortComment":null}\n```')])
    await expect(playOpponentTurn(d, params())).resolves.toMatchObject({ san: 'e5', attempts: 1 })
  })

  it('plays a random legal move when no engine is available', async () => {
    const d = deps([ok('nope'), ok('nope'), ok('nope')], { available: false })
    const move = await playOpponentTurn(d, params())
    expect(move.fallback).toBe('random')
    expect(legalMoves(AFTER_E4).map((legal) => legal.uci)).toContain(move.uci)
  })

  it('falls back to a random move when the engine has no answer either', async () => {
    const d = deps([ok('nope'), ok('nope'), ok('nope')], { available: true, bestMove: null })
    const move = await playOpponentTurn(d, params())
    expect(move.fallback).toBe('random')
  })

  it('never retries a quota failure', async () => {
    const d = deps([
      { ok: false, reason: 'quota', message: 'usage limit reached', turnId: 't1' },
      answer('e5')
    ])
    await expect(playOpponentTurn(d, params())).rejects.toMatchObject({
      name: 'OpponentTurnError',
      reason: 'quota'
    })
    expect(d.runTurn).toHaveBeenCalledTimes(1)
  })

  it('never retries an interrupted turn', async () => {
    const d = deps([
      { ok: false, reason: 'interrupted', message: 'takeback', turnId: 't1' },
      answer('e5')
    ])
    await expect(playOpponentTurn(d, params())).rejects.toBeInstanceOf(OpponentTurnError)
    expect(d.runTurn).toHaveBeenCalledTimes(1)
  })

  it('refuses a position with no legal move at all', async () => {
    const d = deps([answer('e5')])
    await expect(
      playOpponentTurn(d, params({ fen: '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1' }))
    ).rejects.toThrow(/no legal move/)
    expect(d.runTurn).not.toHaveBeenCalled()
  })
})
