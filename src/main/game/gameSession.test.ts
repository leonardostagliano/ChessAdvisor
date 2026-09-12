import { join } from 'node:path'
import { applyMove, epdOf, legalMoves } from '@shared/chess/notation'
import type { ModelInfo, TurnRequest, TurnResult } from '@shared/types/codex'
import type { Analysis, EngineState } from '@shared/types/engine'
import type { Game, Move } from '@shared/types/game'
import type { NewGameOptions } from '@shared/types/session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { GameStore } from '../store/gameStore'
import { ProfileStore } from '../store/profileStore'
import { SettingsStore } from '../store/settingsStore'
import { GameSession, START_FEN, type SessionCodex, type SessionEngine } from './gameSession'

/** Mate in one: 1. Qg7#. Used to reach a real terminal position without playing a whole game. */
const MATE_IN_ONE = '7k/5Q2/6K1/8/8/8/8/8 w - - 0 1'

const MODELS: ModelInfo[] = [
  {
    id: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    description: '',
    isDefault: true,
    defaultEffort: 'medium',
    efforts: [
      { id: 'low', description: '' },
      { id: 'medium', description: '' },
      { id: 'high', description: '' }
    ]
  },
  { id: 'gpt-5.5', displayName: 'GPT-5.5', description: '', isDefault: false, defaultEffort: 'medium', efforts: [{ id: 'medium', description: '' }] }
]

function fenOf(text: string): string {
  const line = text.split('\n').find((entry) => entry.startsWith('FEN: '))
  return line ? line.slice(5).trim() : START_FEN
}

/**
 * A Codex service that always answers with the first legal move in SAN order, so a whole game is
 * deterministic. `hold()` freezes the next turn until `interrupt` or `release` resolves it.
 */
class FakeCodex implements SessionCodex {
  readonly started: { role: string; model: string; baseInstructions: string; gameId?: string }[] = []
  readonly interrupted: string[] = []
  readonly closed: string[] = []
  readonly requests: TurnRequest[] = []
  script: TurnResult[] = []
  catalogue: ModelInfo[] = MODELS
  private holding = false
  private pending: ((result: TurnResult) => void) | null = null
  private threads = 0

  async startThread(role: 'opponent' | 'coach' | 'training', opts: { model: string; baseInstructions: string; gameId?: string }): Promise<string> {
    this.started.push({ role, ...opts })
    this.threads += 1
    return `thread-${this.threads}`
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    this.requests.push(req)
    if (this.holding) {
      this.holding = false
      return new Promise<TurnResult>((resolve) => {
        this.pending = resolve
      })
    }
    const scripted = this.script.shift()
    return scripted ?? this.answer(req)
  }

  async interrupt(threadId: string): Promise<void> {
    this.interrupted.push(threadId)
    const pending = this.pending
    this.pending = null
    pending?.({ ok: false, reason: 'interrupted', message: 'interrupted by the user', turnId: 't-held' })
  }

  async closeThread(threadId: string): Promise<void> {
    this.closed.push(threadId)
  }

  models(): ModelInfo[] {
    return this.catalogue
  }

  /** The next turn hangs until `interrupt` resolves it. */
  hold(): void {
    this.holding = true
  }

  private answer(req: TurnRequest): TurnResult {
    const moves = legalMoves(fenOf(req.text))
    const drawOffer = JSON.stringify(req.outputSchema ?? {}).includes('accept')
    const text = drawOffer
      ? JSON.stringify({ accept: false, reason: 'gioco ancora' })
      : JSON.stringify({ move: moves[0]?.san ?? 'resign', shortComment: 'ok' })
    return { ok: true, text, turnId: `t-${this.requests.length}`, effectiveModel: null, durationMs: 5 }
  }
}

function fakeEngine(available = true): SessionEngine {
  return {
    state: (): EngineState => ({ available, binary: available ? 'avx2' : 'none', version: 'fake 17', message: null }),
    analyze: async (fen: string): Promise<Analysis> => ({
      bestMove: legalMoves(fen)[0]?.uci ?? null,
      lines: [{ move: legalMoves(fen)[0]?.uci ?? 'e2e4', pv: [], scoreCp: 30, depth: 14 }],
      depth: 14,
      fen
    })
  }
}

const options = (over: Partial<NewGameOptions> = {}): NewGameOptions => ({
  userColor: 'w',
  model: 'gpt-6-astra',
  effort: 'medium',
  difficulty: { mode: 'fixed', level: 3 },
  coach: { model: 'gpt-6-astra', effort: 'medium' },
  language: 'it',
  showReasoning: true,
  commentsVisible: true,
  ...over
})

describe('GameSession', () => {
  let root: string
  let store: GameStore
  let settings: SettingsStore
  let profile: ProfileStore
  let codex: FakeCodex
  let emit: ReturnType<typeof vi.fn>
  let session: GameSession
  let clock: number

  const build = async (engine: SessionEngine = fakeEngine()): Promise<GameSession> => {
    session = new GameSession({
      codex,
      engine,
      store,
      settings,
      profile,
      emit,
      now: () => (clock += 1000)
    })
    return session
  }

  beforeEach(async () => {
    root = await makeTmpDir()
    store = new GameStore(join(root, 'games'))
    await store.load()
    settings = new SettingsStore(join(root, 'settings.json'))
    await settings.load()
    profile = new ProfileStore(join(root, 'profile.json'))
    await profile.load()
    codex = new FakeCodex()
    emit = vi.fn()
    clock = 1_700_000_000_000
    await build()
  })

  afterEach(async () => {
    await removeTmpDir(root)
    vi.restoreAllMocks()
  })

  it('starts a game, opens the opponent thread and waits for the user', async () => {
    const state = await session.newGame(options())
    expect(state.status).toBe('playing')
    expect(state.userToMove).toBe(true)
    expect(state.fen).toBe(START_FEN)
    expect(state.legal).toHaveLength(20)
    expect(state.liveEval).toEqual({ cp: 30, depth: 14 })

    expect(codex.started).toHaveLength(1)
    expect(codex.started[0]!.role).toBe('opponent')
    // The AI has Black, and the persona of the chosen level is in the base instructions.
    expect(codex.started[0]!.baseInstructions).toContain('il Nero')
    expect(codex.started[0]!.baseInstructions).toContain('1200')
    expect(state.game!.opponent.difficulty).toEqual({ mode: 'fixed', level: 3, targetElo: 1200 })
    expect(settings.get().lastDifficulty).toEqual({ mode: 'fixed', level: 3 })
    expect(emit).toHaveBeenCalledWith('game:state', expect.objectContaining({ status: 'playing' }))
  })

  it('plays the user move, records the AI answer and autosaves both', async () => {
    await session.newGame(options())
    const save = vi.spyOn(store, 'save')
    const state = await session.userMove('e2e4')

    const moves = state.game!.moves
    expect(moves).toHaveLength(2)
    expect(moves[0]).toMatchObject({ ply: 1, san: 'e4', uci: 'e2e4', by: 'user' })
    expect(moves[1]!.by).toBe('ai')
    expect(moves[1]!.ply).toBe(2)
    expect(moves[1]!.aiShortComment).toBe('ok')
    expect(moves[1]!.thinkingMs).toBeGreaterThan(0)
    expect(moves[1]!.epdAfter).toBe(epdOf(moves[1]!.fenAfter))
    expect(state.userToMove).toBe(true)
    expect(state.ai.thinking).toBe(false)
    // One write for the user move, one for the AI answer.
    expect(save).toHaveBeenCalledTimes(2)
    expect(await store.get(state.game!.id)).toMatchObject({ moves: [expect.anything(), expect.anything()] })

    // The turn text carries the position the model has to answer from.
    expect(codex.requests[0]!.text).toContain('FEN: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1')
    expect(codex.requests[0]!.text).toContain('PGN: 1. e4')
  })

  it('lets the AI open when the user plays Black', async () => {
    const state = await session.newGame(options({ userColor: 'b' }))
    expect(codex.started[0]!.baseInstructions).toContain('il Bianco')
    expect(state.game!.moves).toHaveLength(1)
    expect(state.game!.moves[0]!.by).toBe('ai')
    expect(state.userToMove).toBe(true)
  })

  it('refuses a move the user cannot play', async () => {
    await session.newGame(options())
    await expect(session.userMove('e7e5')).rejects.toMatchObject({ code: 'ILLEGAL_MOVE' })
    await expect(session.userMove('nonsense')).rejects.toMatchObject({ code: 'ILLEGAL_MOVE' })
  })

  it('interrupts the running turn on a takeback and removes the user move', async () => {
    await session.newGame(options())
    codex.hold()
    const pending = session.userMove('e2e4')
    await vi.waitFor(() => expect(session.state().ai.thinking).toBe(true))
    expect(session.state().game!.moves).toHaveLength(1)

    const state = await session.takeback()
    await pending

    expect(codex.interrupted).toEqual(['thread-1'])
    expect(state.game!.moves).toHaveLength(0)
    expect(state.game!.takebacks).toBe(1)
    expect(state.ai.thinking).toBe(false)
    expect(state.status).toBe('playing')
    expect(session.state().game!.moves).toHaveLength(0)
    // The opponent is told about it in its next turn text.
    await session.userMove('d2d4')
    expect(codex.requests[codex.requests.length - 1]!.text).toContain('semimosse sono state annullate')
  })

  it('removes both plies when the AI already answered, and only once', async () => {
    await session.newGame(options())
    await session.userMove('e2e4')
    expect(session.state().game!.moves).toHaveLength(2)
    const state = await session.takeback()
    expect(state.game!.moves).toHaveLength(0)
    expect(state.game!.takebacks).toBe(1)
    // Nothing left to take back: the call is a no-op, not an error.
    expect((await session.takeback()).game!.takebacks).toBe(1)
  })

  it('detects checkmate, stores the result and closes the thread', async () => {
    await session.newGame(options({ startFen: MATE_IN_ONE }))
    const state = await session.userMove('f7g7')

    expect(state.status).toBe('finished')
    expect(state.game!.status).toBe('finished')
    expect(state.game!.result).toEqual({ outcome: '1-0', reason: 'checkmate' })
    expect(codex.closed).toEqual(['thread-1'])
    expect(emit).toHaveBeenCalledWith('game:finished', { gameId: state.game!.id, result: { outcome: '1-0', reason: 'checkmate' } })
    expect((await store.get(state.game!.id))!.result).toEqual({ outcome: '1-0', reason: 'checkmate' })
  })

  it('records a resignation as a loss for the user', async () => {
    await session.newGame(options({ userColor: 'b' }))
    const state = await session.resign()
    expect(state.game!.result).toEqual({ outcome: '1-0', reason: 'resign' })
    expect(state.status).toBe('finished')
  })

  it('asks the opponent about a draw offer and keeps playing when it refuses', async () => {
    await session.newGame(options())
    const answer = await session.offerDraw()
    expect(answer).toEqual({ accepted: false, reason: 'gioco ancora' })
    expect(session.state().status).toBe('playing')
  })

  it('agrees to a draw when the opponent accepts', async () => {
    await session.newGame(options())
    codex.script = [{ ok: true, text: JSON.stringify({ accept: true, reason: 'posizione morta' }), turnId: 'd1', effectiveModel: null, durationMs: 1 }]
    const answer = await session.offerDraw()
    expect(answer.accepted).toBe(true)
    expect(session.state().game!.result).toEqual({ outcome: '1/2-1/2', reason: 'draw_agreed' })
  })

  it('pauses the game when the quota runs out', async () => {
    await session.newGame(options())
    codex.script = [{ ok: false, reason: 'quota', message: 'usage limit reached', turnId: 'q1' }]
    const state = await session.userMove('e2e4')
    expect(state.status).toBe('error')
    expect(state.error).toContain('usage limit')
    expect(state.game!.moves).toHaveLength(1)
  })

  it('hides the eval bar when no engine is available', async () => {
    await build(fakeEngine(false))
    const state = await session.newGame(options())
    expect(state.liveEval).toBeNull()
  })

  it('reports the live eval of a browsed position from White’s point of view', async () => {
    await session.newGame(options())
    await session.navigateEval('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1')
    // The engine speaks from the side to move: with Black to move the sign is flipped.
    expect(session.state().liveEval).toEqual({ cp: -30, depth: 14 })
  })

  describe('resume', () => {
    const saved = async (patch: Partial<Game> = {}): Promise<Game> => {
      const game = await store.create({
        kind: 'match',
        userColor: 'w',
        opponent: { model: 'gpt-6-astra', effort: 'medium', difficulty: { mode: 'fixed', level: 3, targetElo: 1200 } },
        coach: { model: 'gpt-6-astra', effort: 'medium' },
        clock: null,
        language: 'it'
      })
      const applied = applyMove(START_FEN, 'e2e4')!
      const move: Move = { ply: 1, san: applied.san, uci: 'e2e4', fenAfter: applied.fen, epdAfter: epdOf(applied.fen), by: 'user' }
      Object.assign(game, patch)
      game.moves.push(move)
      await store.save(game)
      return game
    }

    it('recreates the thread from the PGN and resumes the AI turn', async () => {
      const game = await saved()
      const state = await session.resume(game.id)

      expect(codex.started).toHaveLength(1)
      expect(codex.started[0]!.gameId).toBe(game.id)
      expect(state.game!.moves).toHaveLength(2)
      expect(state.game!.moves[1]!.by).toBe('ai')
      expect(codex.requests[0]!.text).toContain('PGN: 1. e4')
    })

    it('refuses a game whose model is gone and proposes the default one', async () => {
      const game = await saved({ opponent: { model: 'ghost-1', effort: 'medium', difficulty: { mode: 'fixed', level: 3, targetElo: 1200 } } })
      await expect(session.resume(game.id)).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE', suggested: 'gpt-6-astra' })
      expect(codex.started).toHaveLength(0)
      expect(session.state().status).toBe('idle')

      const state = await session.resume(game.id, { substituteModel: 'gpt-6-astra' })
      expect(state.game!.opponent.model).toBe('gpt-6-astra')
      expect(state.game!.opponent.substitutedFrom).toBe('ghost-1')
      expect((await store.get(game.id))!.opponent.substitutedFrom).toBe('ghost-1')
    })

    it('falls back to the default effort when the saved one is gone', async () => {
      const game = await saved({ opponent: { model: 'gpt-5.5', effort: 'xhigh', difficulty: { mode: 'fixed', level: 3, targetElo: 1200 } } })
      const state = await session.resume(game.id)
      expect(state.game!.opponent.effort).toBe('medium')
    })

    it('rejects an unknown game id', async () => {
      await expect(session.resume('nope')).rejects.toMatchObject({ code: 'GAME_NOT_FOUND' })
    })
  })

  describe('adaptive difficulty', () => {
    const adaptive = options({ difficulty: { mode: 'adaptive', level: 3 } })

    it('starts at 1200 and doubles the first steps after a win', async () => {
      const state = await session.newGame({ ...adaptive, startFen: MATE_IN_ONE })
      expect(state.game!.opponent.difficulty).toEqual({ mode: 'adaptive', level: 3, targetElo: 1200 })

      await session.userMove('f7g7')
      expect(profile.get().adaptive).toMatchObject({ elo: 1350, games: 1 })
      expect(session.adaptiveElo()).toEqual({ elo: 1350, games: 1 })
    })

    it('takes 75 points off a loss once the rating has settled', async () => {
      await profile.update({ adaptive: { elo: 1350, games: 3, updatedAt: '2026-01-01T00:00:00.000Z' } })
      await session.newGame(adaptive)
      await session.resign()
      expect(profile.get().adaptive).toMatchObject({ elo: 1275, games: 4 })
    })

    it('clamps the rating to 500–2400', async () => {
      await profile.update({ adaptive: { elo: 2400, games: 9, updatedAt: '2026-01-01T00:00:00.000Z' } })
      await session.newGame({ ...adaptive, startFen: MATE_IN_ONE })
      await session.userMove('f7g7')
      expect(profile.get().adaptive!.elo).toBe(2400)

      await profile.update({ adaptive: { elo: 500, games: 11, updatedAt: '2026-01-01T00:00:00.000Z' } })
      await session.newGame(adaptive)
      await session.resign()
      expect(profile.get().adaptive!.elo).toBe(500)
    })

    it('uses the persona nearest to the current rating', async () => {
      await profile.update({ adaptive: { elo: 1700, games: 5, updatedAt: '2026-01-01T00:00:00.000Z' } })
      const state = await session.newGame(adaptive)
      expect(state.game!.opponent.difficulty).toEqual({ mode: 'adaptive', level: 5, targetElo: 1700 })
      expect(codex.started[0]!.baseInstructions).toContain('1700')
      expect(codex.started[0]!.baseInstructions).toContain('Forte')
    })

    it('never touches the profile in fixed mode', async () => {
      await session.newGame(options({ startFen: MATE_IN_ONE }))
      await session.userMove('f7g7')
      expect(profile.get().adaptive).toBeUndefined()
    })

    it('always plays an endgame drill at the maximum level', async () => {
      const state = await session.newGame(options({ kind: 'endgame_drill', difficulty: { mode: 'adaptive', level: 2 }, startFen: MATE_IN_ONE }))
      expect(state.game!.opponent.difficulty).toEqual({ mode: 'fixed', level: 6, targetElo: null })
      await session.userMove('f7g7')
      // Drills are not matches: they never move the adaptive rating.
      expect(profile.get().adaptive).toBeUndefined()
    })
  })

  it('reports being busy only while the opponent is thinking', async () => {
    await session.newGame(options())
    expect(session.isBusy()).toBe(false)
    codex.hold()
    const pending = session.userMove('e2e4')
    await vi.waitFor(() => expect(session.isBusy()).toBe(true))
    await session.takeback()
    await pending
    expect(session.isBusy()).toBe(false)
  })

  it('closes the thread and forgets the game without finishing it', async () => {
    const state = await session.newGame(options())
    const id = state.game!.id
    await session.close()
    expect(codex.closed).toEqual(['thread-1'])
    expect(session.state().game).toBeNull()
    expect(session.state().status).toBe('idle')
    expect((await store.get(id))!.status).toBe('in_progress')
  })
})
