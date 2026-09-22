import { legalMoves } from '@shared/chess/notation'
import type { TurnRequest, TurnResult } from '@shared/types/codex'
import type { Analysis, EngineState } from '@shared/types/engine'
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
type Analyze = OpponentDeps['engine']['analyze']

function deps(
  script: TurnResult[],
  engine?: Partial<{ available: boolean; bestMove: string | null; analyses: Analysis[] }>
): OpponentDeps & {
  runTurn: ReturnType<typeof vi.fn<RunTurn>>
  analyze: ReturnType<typeof vi.fn<Analyze>>
} {
  const available = engine?.available ?? false
  const analyses = engine?.analyses?.slice() ?? []
  const runTurn = vi.fn<RunTurn>(async () => script.shift() ?? ok('{}'))
  const analyze = vi.fn<Analyze>(async (fen: string) => {
    return (
      analyses.shift() ?? {
        bestMove: engine?.bestMove === undefined ? 'g8f6' : engine.bestMove,
        lines: [],
        depth: 18,
        fen
      }
    )
  })
  // Every call advances the clock by one second, so an attempt always costs exactly 1000 ms.
  let clock = 0
  return {
    runTurn,
    analyze,
    codex: { runTurn },
    engine: {
      state: (): EngineState => ({
        available,
        binary: available ? 'avx2' : 'none',
        version: 'fake',
        message: null
      }),
      analyze
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
  difficulty: { mode: 'fixed', level: 5, targetElo: 1800 },
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

  it('falls back to the engine move and reports that missing scores prevented verification', async () => {
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
      shortComment: null,
      engineVerified: false
    })
    expect(move.overheadMs).toBe(3000)
    expect(onRetry).toHaveBeenCalledTimes(MAX_ATTEMPTS)
  })

  it('uses the best prepared line when fallback child scores are unavailable', async () => {
    const prepared: Analysis = {
      bestMove: 'e7e5',
      lines: [
        { move: 'e7e5', pv: ['e7e5'], scoreCp: 900, depth: 12 },
        { move: 'c7c5', pv: ['c7c5'], scoreCp: 300, depth: 12 },
        { move: 'g8f6', pv: ['g8f6'], scoreCp: 0, depth: 12 }
      ],
      depth: 12,
      fen: AFTER_E4
    }
    const difficulty = { mode: 'fixed', level: 1, targetElo: 600 } as const
    const d = deps([ok('nope'), ok('nope'), ok('nope')], { available: true, analyses: [prepared] })

    const move = await playOpponentTurn(d, params({ difficulty, difficultySeed: 'fallback-seed' }))

    expect(move).toMatchObject({
      uci: prepared.bestMove,
      fallback: 'engine',
      engineVerified: false
    })
  })

  it('marks an engine fallback verified only after the child position is checked', async () => {
    const prepared: Analysis = {
      bestMove: 'e7e5',
      lines: [{ move: 'e7e5', pv: ['e7e5'], scoreCp: 0, depth: 12 }],
      depth: 12,
      fen: AFTER_E4
    }
    const reply: Analysis = {
      bestMove: 'g1f3',
      lines: [{ move: 'g1f3', pv: ['g1f3'], scoreCp: 0, depth: 20 }],
      depth: 20,
      fen: AFTER_E4
    }
    const d = deps([ok('nope'), ok('nope'), ok('nope')], {
      available: true,
      analyses: [prepared, reply]
    })

    const move = await playOpponentTurn(d, params())

    expect(move).toMatchObject({ uci: 'e7e5', fallback: 'engine', engineVerified: true })
    expect(d.analyze).toHaveBeenCalledTimes(2)
  })

  it('keeps the model-selected move and comment when a policy sample would differ', async () => {
    const prepared: Analysis = {
      bestMove: 'e7e5',
      lines: [
        { move: 'e7e5', pv: ['e7e5'], scoreCp: 900, depth: 12 },
        { move: 'c7c5', pv: ['c7c5'], scoreCp: 300, depth: 12 },
        { move: 'g8f6', pv: ['g8f6'], scoreCp: 0, depth: 12 }
      ],
      depth: 12,
      fen: AFTER_E4
    }
    const difficulty = { mode: 'fixed', level: 1, targetElo: 600 } as const
    const reply: Analysis = {
      bestMove: 'g1f3',
      lines: [{ move: 'g1f3', pv: ['g1f3'], scoreCp: -900, depth: 20 }],
      depth: 20,
      fen: AFTER_E4
    }
    const d = deps([answer('e5', 'Commento per e5')], {
      available: true,
      analyses: [prepared, reply]
    })

    const move = await playOpponentTurn(d, params({ difficulty, difficultySeed: 'human-seed' }))

    expect(move).toMatchObject({ uci: 'e7e5', shortComment: 'Commento per e5', attempts: 1 })
    expect(move.fallback).toBeUndefined()
  })

  it('keeps an allowed imperfect model move when the sampled candidate would improve it', async () => {
    const prepared: Analysis = {
      bestMove: 'e7e5',
      lines: [
        { move: 'e7e5', pv: ['e7e5'], scoreCp: 900, depth: 12 },
        { move: 'c7c5', pv: ['c7c5'], scoreCp: 300, depth: 12 },
        { move: 'g8f6', pv: ['g8f6'], scoreCp: 0, depth: 12 }
      ],
      depth: 12,
      fen: AFTER_E4
    }
    const difficulty = { mode: 'fixed', level: 1, targetElo: 600 } as const
    const imperfectReply: Analysis = {
      bestMove: 'g1f3',
      lines: [{ move: 'g1f3', pv: ['g1f3'], scoreCp: -500, depth: 20 }],
      depth: 20,
      fen: AFTER_E4
    }
    const d = deps([answer('c5', 'Commento per c5')], {
      available: true,
      analyses: [prepared, imperfectReply]
    })

    const move = await playOpponentTurn(d, params({ difficulty, difficultySeed: 'retain-seed' }))

    expect(move).toMatchObject({ uci: 'c7c5', shortComment: 'Commento per c5' })
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

  it('keeps the only legal move available even when no engine is available', async () => {
    const forced = '7k/8/8/8/8/8/6r1/7K w - - 0 1'
    const only = legalMoves(forced)
    expect(only).toHaveLength(1)
    const d = deps([ok('nope'), ok('nope'), ok('nope')], { available: false })
    const move = await playOpponentTurn(d, params({ fen: forced, pgn: '' }))
    expect(move).toMatchObject({ uci: only[0]!.uci, fallback: 'random' })
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

  it('grounds the model with every line and retries an 1800-level tactical blunder', async () => {
    const prepared: Analysis = {
      bestMove: 'e7e5',
      lines: [
        { move: 'e7e5', pv: ['e7e5', 'g1f3', 'b8c6'], scoreCp: 30, depth: 20 },
        { move: 'c7c5', pv: ['c7c5', 'g1f3', 'd7d6'], scoreCp: 18, depth: 20 }
      ],
      depth: 20,
      fen: AFTER_E4
    }
    const badReply: Analysis = {
      bestMove: 'g1f3',
      lines: [{ move: 'g1f3', pv: ['g1f3', 'b8c6'], scoreCp: 500, depth: 20 }],
      depth: 20,
      fen: AFTER_E4
    }
    const safeReply: Analysis = {
      bestMove: 'g1f3',
      lines: [{ move: 'g1f3', pv: ['g1f3', 'b8c6'], scoreCp: -20, depth: 20 }],
      depth: 20,
      fen: AFTER_E4
    }
    const d = deps([answer('a6'), answer('e5')], {
      available: true,
      analyses: [prepared, badReply, safeReply]
    })
    const onRetry = vi.fn()
    const move = await playOpponentTurn(d, params({ onRetry }))

    expect(move).toMatchObject({
      san: 'e5',
      attempts: 2,
      engineAssisted: true,
      engineVerified: true
    })
    expect(onRetry).toHaveBeenCalledWith(1, expect.stringMatching(/unsafe move.*a6.*530 cp/i))
    expect(d.analyze.mock.calls.map((call) => call[1])).toEqual([
      'opponent-strong',
      'opponent-check',
      'opponent-check'
    ])
    const firstPrompt = (d.runTurn.mock.calls[0]![0] as TurnRequest).text
    expect(firstPrompt).toContain('e7e5 g1f3 b8c6')
    expect(firstPrompt).toContain('c7c5 g1f3 d7d6')
    expect(firstPrompt).toContain('qualunque mossa legale')
    const retryPrompt = (d.runTurn.mock.calls[1]![0] as TurnRequest).text
    expect(retryPrompt).toContain('CONTROLLO TATTICO')
    expect(retryPrompt).toContain('e7e5 g1f3 b8c6')
  })

  it('rejects throwing away a forced win by stalemate and verifies a mating move without a child search', async () => {
    const fen = 'k7/8/1QK5/8/8/8/8/8 w - - 0 1'
    const prepared: Analysis = {
      fen,
      bestMove: 'b6b7',
      depth: 20,
      lines: [{ move: 'b6b7', pv: ['b6b7'], scoreMate: 1, depth: 20 }]
    }
    const d = deps([answer('Qc7'), answer('Qb7#')], { available: true, analyses: [prepared] })
    const onRetry = vi.fn()
    const move = await playOpponentTurn(d, params({ fen, pgn: '', onRetry }))
    expect(move).toMatchObject({ san: 'Qb7#', attempts: 2, engineVerified: true })
    expect(onRetry).toHaveBeenCalledWith(1, expect.stringContaining('unsafe move'))
    expect((d.runTurn.mock.calls[1]![0] as TurnRequest).text).toContain(
      'rinuncia a una linea vincente di matto forzato'
    )
    expect(d.analyze).toHaveBeenCalledTimes(1)
  })

  it('does not claim a missed forced mate when child analysis has no score', async () => {
    const forcedWin: Analysis = {
      bestMove: 'e7e5',
      lines: [{ move: 'e7e5', pv: ['e7e5'], scoreMate: 1, depth: 20 }],
      depth: 20,
      fen: AFTER_E4
    }
    const unscoredChild: Analysis = {
      bestMove: null,
      lines: [],
      depth: 0,
      fen: AFTER_E4
    }
    const d = deps([answer('c5')], { available: true, analyses: [forcedWin, unscoredChild] })
    const onRetry = vi.fn()

    const move = await playOpponentTurn(d, params({ onRetry }))

    expect(move).toMatchObject({ san: 'c5', engineVerified: false })
    expect(d.runTurn).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('treats a mate-zero child score as a completed mating loss', async () => {
    const forcedWin: Analysis = {
      bestMove: 'e7e5',
      lines: [{ move: 'e7e5', pv: ['e7e5'], scoreMate: 1, depth: 20 }],
      depth: 20,
      fen: AFTER_E4
    }
    const matedChild: Analysis = {
      bestMove: 'g1f3',
      lines: [{ move: 'g1f3', pv: ['g1f3'], scoreMate: 0, depth: 20 }],
      depth: 20,
      fen: AFTER_E4
    }
    const d = deps([answer('c5')], { available: true, analyses: [forcedWin, matedChild] })

    const move = await playOpponentTurn(d, params())

    expect(move).toMatchObject({ san: 'c5', engineVerified: true })
    expect(d.runTurn).toHaveBeenCalledTimes(1)
  })

  it('uses the adaptive target to select the breadth/depth profile', async () => {
    const d = deps([answer('e5')], { available: true })
    await playOpponentTurn(
      d,
      params({ difficulty: { mode: 'adaptive', level: 1, targetElo: 1520 } })
    )
    expect(d.analyze).toHaveBeenCalledWith(AFTER_E4, 'opponent-challenging', {
      signal: undefined
    })
  })

  it('resigns a deeply verified forced mate without asking the model for a move', async () => {
    const forcedMate: Analysis = {
      bestMove: 'g8f6',
      lines: [{ move: 'g8f6', pv: ['g8f6', 'f1b5'], scoreMate: -4, depth: 20 }],
      depth: 20,
      fen: AFTER_E4
    }
    const d = deps([answer('e5')], { available: true, analyses: [forcedMate] })
    const move = await playOpponentTurn(d, params({ allowResign: true }))
    expect(move).toMatchObject({
      resign: true,
      san: '',
      uci: '',
      shortComment: 'Mi arrendo.',
      engineAssisted: true
    })
    expect(d.runTurn).not.toHaveBeenCalled()
  })

  it('does not start analysis or a model turn after cancellation', async () => {
    const controller = new AbortController()
    controller.abort()
    const d = deps([answer('e5')], { available: true })
    await expect(playOpponentTurn(d, params({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError'
    })
    expect(d.analyze).not.toHaveBeenCalled()
    expect(d.runTurn).not.toHaveBeenCalled()
  })
})
