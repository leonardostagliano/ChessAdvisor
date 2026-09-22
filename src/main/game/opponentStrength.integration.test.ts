import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Analysis } from '@shared/types/engine'
import { EngineService } from '../engine/engineService'
import { SettingsStore } from '../store/settingsStore'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { legalMoves } from '@shared/chess/notation'
import { DIFFICULTY_LEVELS } from '@shared/types/session'
import { difficultyPolicy, lineUtility, sampledCandidate } from './difficultyPolicy'
import { OPPONENT_PROFILE, playOpponentTurn } from './opponentTurn'

// A position from the reported 1800-level game: 7...Qxd5 hangs the queen to Nxd5.
const POSITION = 'r1bqkb1r/ppp2ppp/5n2/3P4/3Q4/2N5/PPP2PPP/R1B1KB1R b KQkq - 0 7'
const MATE_IN_ONE = 'k7/8/1QK5/8/8/8/8/8 w - - 0 1'
const BENCHMARK_POSITIONS = [
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
  POSITION,
  MATE_IN_ONE
]
const bundled =
  process.platform === 'win32' && existsSync(resolve('resources/engine/stockfish-popcnt.exe'))

describe.skipIf(!bundled)('bundled Stockfish opponent regression', () => {
  it('samples legal candidates within the empirical root-loss ceiling across all six levels', async () => {
    const dir = await makeTmpDir('chessadvisor-strength-benchmark-')
    const settings = new SettingsStore(join(dir, 'settings.json'))
    const engine = new EngineService({
      settings,
      resourcePath: (...parts) => resolve('resources', ...parts),
      emit: () => {},
      threads: 2,
      hashMb: 32
    })
    try {
      expect((await engine.start()).available).toBe(true)
      for (const level of [1, 2, 3, 4, 5, 6] as const) {
        const difficulty = {
          mode: 'fixed' as const,
          level,
          targetElo: DIFFICULTY_LEVELS[level].elo
        }
        for (const fen of BENCHMARK_POSITIONS) {
          const analysis = await engine.analyze(fen, OPPONENT_PROFILE[level])
          const policy = difficultyPolicy(difficulty, fen)
          const best =
            analysis.lines.find((line) => line.move === analysis.bestMove) ?? analysis.lines[0]
          const bestScore = best ? lineUtility(best) : null
          expect(best).toBeDefined()
          if (fen === MATE_IN_ONE) expect(best?.scoreMate).toBe(1)

          for (const seed of ['rapid-a', 'rapid-b', 'rapid-c']) {
            const chosen = sampledCandidate(analysis.lines, policy, `${level}:${seed}:${fen}`)
            expect(chosen).not.toBeNull()
            expect(legalMoves(fen).map((move) => move.uci)).toContain(chosen!.move)
            if (typeof best?.scoreMate === 'number' && best.scoreMate > 0) {
              expect(typeof chosen?.scoreMate).toBe('number')
              expect(chosen!.scoreMate).toBeGreaterThan(0)
            } else if (bestScore !== null && typeof chosen?.scoreMate !== 'number') {
              const chosenScore = chosen ? lineUtility(chosen) : null
              if (chosenScore !== null)
                expect(bestScore - chosenScore).toBeLessThanOrEqual(policy.maximumLossCp)
            }
          }
        }
      }
    } finally {
      await engine.shutdown()
      await removeTmpDir(dir)
    }
  }, 60_000)

  it('rejects the reported queen blunder and lets the model choose again with evidence', async () => {
    const dir = await makeTmpDir('chessadvisor-strength-')
    const settings = new SettingsStore(join(dir, 'settings.json'))
    const engine = new EngineService({
      settings,
      resourcePath: (...parts) => resolve('resources', ...parts),
      emit: () => {},
      threads: 2,
      hashMb: 32
    })
    try {
      expect((await engine.start()).available).toBe(true)
      let baseline: Analysis | undefined
      let attempts = 0
      const retry = vi.fn()
      const move = await playOpponentTurn(
        {
          engine: {
            state: () => engine.state(),
            analyze: async (fen, profile, opts) => {
              const result = await engine.analyze(fen, profile, opts)
              if (fen === POSITION) baseline = result
              return result
            }
          },
          codex: {
            runTurn: async () => ({
              ok: true,
              text: JSON.stringify({
                move: ++attempts === 1 ? 'Qxd5' : baseline!.bestMove,
                shortComment: null
              }),
              turnId: 'regression',
              effectiveModel: null,
              durationMs: 1
            })
          },
          now: Date.now
        },
        {
          threadId: 'test',
          model: 'fake-regression',
          effort: 'high',
          language: 'it',
          difficulty: { mode: 'fixed', level: 5, targetElo: 1800 },
          fen: POSITION,
          pgn: '',
          lastUserMove: null,
          takebackNotice: null,
          timeoutMs: 10000,
          streamId: 'test',
          allowResign: false,
          onDelta: () => {},
          onRetry: retry
        }
      )
      expect(retry).toHaveBeenCalled()
      expect(move.uci).not.toBe('d8d5')
      expect(move.engineVerified).toBe(true)
      expect(move.fallback).toBeUndefined()
    } finally {
      await engine.shutdown()
      await removeTmpDir(dir)
    }
  }, 25000)
})
