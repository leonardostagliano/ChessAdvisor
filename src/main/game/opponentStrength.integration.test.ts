import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Analysis } from '@shared/types/engine'
import { EngineService } from '../engine/engineService'
import { SettingsStore } from '../store/settingsStore'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { applyMove, legalMoves } from '@shared/chess/notation'
import { difficultyPolicy, lineUtility, sampledCandidate } from './difficultyPolicy'
import { playOpponentTurn } from './opponentTurn'

// A position from the reported 1800-level game: 7...Qxd5 hangs the queen to Nxd5.
const POSITION = 'r1bqkb1r/ppp2ppp/5n2/3P4/3Q4/2N5/PPP2PPP/R1B1KB1R b KQkq - 0 7'
const BENCHMARK_POSITIONS = [
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1',
  POSITION,
  'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 3'
]
const bundled =
  process.platform === 'win32' && existsSync(resolve('resources/engine/stockfish-popcnt.exe'))

describe.skipIf(!bundled)('bundled Stockfish opponent regression', () => {
  it('samples measurably weaker but still legal candidates at low tiers across fixtures', async () => {
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
      const lowPolicy = difficultyPolicy({ mode: 'fixed', level: 1, targetElo: 600 })
      const highPolicy = difficultyPolicy({ mode: 'fixed', level: 5, targetElo: 1800 })
      const gaps: number[] = []
      for (const [index, fen] of BENCHMARK_POSITIONS.entries()) {
        // These are the actual tier search pools. A separate moderate reference searches the two
        // selected child positions, avoiding brittle exact-PV assertions under machine load.
        const lowAnalysis = await engine.analyze(fen, 'opponent-beginner')
        const highAnalysis = await engine.analyze(fen, 'opponent-strong')
        const reference = await engine.analyze(fen, 'opponent-challenging')
        const low = sampledCandidate(lowAnalysis.lines, lowPolicy, `benchmark-low-${index}`)
        const high = sampledCandidate(highAnalysis.lines, highPolicy, `benchmark-high-${index}`)
        const best = Math.max(...reference.lines.map((line) => lineUtility(line) ?? -Infinity))
        expect(low).not.toBeNull()
        expect(high).not.toBeNull()
        expect(legalMoves(fen).map((move) => move.uci)).toContain(low!.move)
        expect(legalMoves(fen).map((move) => move.uci)).toContain(high!.move)
        const lowReply = await engine.analyze(applyMove(fen, low!.move)!.fen, 'opponent-check')
        const highReply = await engine.analyze(applyMove(fen, high!.move)!.fen, 'opponent-check')
        const lowLoss = Math.max(0, best + (lineUtility(lowReply.lines[0]) ?? 0))
        const highLoss = Math.max(0, best + (lineUtility(highReply.lines[0]) ?? 0))
        expect(lowLoss).toBeGreaterThanOrEqual(highLoss)
        gaps.push(lowLoss - highLoss)
      }
      expect(gaps.some((gap) => gap > 0)).toBe(true)
    } finally {
      await engine.shutdown()
      await removeTmpDir(dir)
    }
  }, 30_000)

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
