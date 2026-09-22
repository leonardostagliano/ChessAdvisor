import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Analysis } from '@shared/types/engine'
import { EngineService } from '../engine/engineService'
import { SettingsStore } from '../store/settingsStore'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { playOpponentTurn } from './opponentTurn'

// A position from the reported 1800-level game: 7...Qxd5 hangs the queen to Nxd5.
const POSITION = 'r1bqkb1r/ppp2ppp/5n2/3P4/3Q4/2N5/PPP2PPP/R1B1KB1R b KQkq - 0 7'
const bundled =
  process.platform === 'win32' && existsSync(resolve('resources/engine/stockfish-popcnt.exe'))

describe.skipIf(!bundled)('bundled Stockfish opponent regression', () => {
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
