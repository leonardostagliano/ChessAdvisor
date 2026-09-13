import { join } from 'node:path'
import { applyMove, epdOf, legalMoves } from '@shared/chess/notation'
import type { ModelInfo, TurnRequest, TurnResult } from '@shared/types/codex'
import type { Analysis, EngineState } from '@shared/types/engine'
import type { Game, Move } from '@shared/types/game'
import type { NewGameOptions, SessionState } from '@shared/types/session'
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
  /** Called before every answer: the clock tests let a turn burn some of the fake wall time. */
  onTurn: ((req: TurnRequest) => void) | null = null
  catalogue: ModelInfo[] = MODELS
  private holding = false
  private pending: ((result: TurnResult) => void) | null = null
  private holdingCoach = false
  private pendingCoach: ((result: TurnResult) => void) | null = null
  private threads = 0

  async startThread(role: 'opponent' | 'coach' | 'training', opts: { model: string; baseInstructions: string; gameId?: string }): Promise<string> {
    this.started.push({ role, ...opts })
    this.threads += 1
    return `thread-${this.threads}`
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    this.requests.push(req)
    this.onTurn?.(req)
    if (this.holding) {
      this.holding = false
      return new Promise<TurnResult>((resolve) => {
        this.pending = resolve
      })
    }
    if (this.holdingCoach && !req.outputSchema) {
      return new Promise<TurnResult>((resolve) => {
        this.pendingCoach = resolve
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

  /** Every plain-text turn (i.e. every coach comment or answer) hangs until `releaseCoach`. */
  holdCoach(): void {
    this.holdingCoach = true
  }

  releaseCoach(text = 'Commento finto.'): void {
    const pending = this.pendingCoach
    this.pendingCoach = null
    this.holdingCoach = false
    pending?.({ ok: true, text, turnId: 't-coach', effectiveModel: null, durationMs: 5 })
  }

  private answer(req: TurnRequest): TurnResult {
    const moves = legalMoves(fenOf(req.text))
    const schema = JSON.stringify(req.outputSchema ?? {})
    const text = schema.includes('accept')
      ? JSON.stringify({ accept: false, reason: 'gioco ancora' })
      : schema.includes('reason')
        ? JSON.stringify({ move: moves[0]?.san ?? 'resign', reason: 'occupa il centro' })
        : schema.includes('move')
          ? JSON.stringify({ move: moves[0]?.san ?? 'resign', shortComment: 'ok' })
          : req.text.includes('Domanda:')
            ? 'Risposta finta.'
            : 'Commento finto.'
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
  // The coach has its own describe block: the game tests do not want a comment after every move.
  commentsVisible: false,
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
    await session.close()
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

    expect(codex.started.map((thread) => thread.role)).toEqual(['opponent', 'coach'])
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

  it('ignores a second resignation instead of recording it twice', async () => {
    await session.newGame(options({ userColor: 'b' }))
    await session.resign()
    const state = await session.resign()

    expect(state.game!.result).toEqual({ outcome: '1-0', reason: 'resign' })
    expect(emit.mock.calls.filter(([channel]) => channel === 'game:finished')).toHaveLength(1)
    expect(codex.closed).toEqual(['thread-1'])
  })

  it('hands the finished game to the analysis hook exactly once (M3)', async () => {
    const finished: { id: string; status: string }[] = []
    session = new GameSession({
      codex,
      engine: fakeEngine(),
      store,
      settings,
      profile,
      emit,
      onFinished: (game) => finished.push({ id: game.id, status: game.status }),
      now: () => (clock += 1000)
    })
    const started = await session.newGame(options({ userColor: 'b' }))
    await session.resign()
    await session.resign()

    expect(finished).toEqual([{ id: started.game!.id, status: 'finished' }])
    // The game is already on disk when the hook fires: the pipeline reads it back by id.
    expect((await store.get(started.game!.id))!.result).toEqual({ outcome: '1-0', reason: 'resign' })
  })

  it('never lets a failing analysis hook break the end of a game', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    session = new GameSession({
      codex,
      engine: fakeEngine(),
      store,
      settings,
      profile,
      emit,
      onFinished: () => {
        throw new Error('the pipeline exploded')
      },
      now: () => (clock += 1000)
    })
    await session.newGame(options({ userColor: 'b' }))
    const state = await session.resign()

    expect(state.game!.result).toEqual({ outcome: '1-0', reason: 'resign' })
    expect(errors).toHaveBeenCalled()
  })

  it('keeps the checkmate result when a resignation arrives after the game is over', async () => {
    await session.newGame(options({ startFen: MATE_IN_ONE }))
    await session.userMove('f7g7')

    const state = await session.resign()
    expect(state.game!.result).toEqual({ outcome: '1-0', reason: 'checkmate' })
    expect((await store.get(state.game!.id))!.result).toEqual({ outcome: '1-0', reason: 'checkmate' })
    expect(emit.mock.calls.filter(([channel]) => channel === 'game:finished')).toHaveLength(1)
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

      expect(codex.started.map((thread) => thread.role)).toEqual(['opponent', 'coach'])
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

    it('moves the rating once even if the resignation is sent twice', async () => {
      await profile.update({ adaptive: { elo: 1200, games: 5, updatedAt: '2026-01-01T00:00:00.000Z' } })
      await session.newGame(adaptive)
      await session.resign()
      await session.resign()
      expect(profile.get().adaptive).toMatchObject({ elo: 1125, games: 6 })
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

    it('leaves the new-game choices untouched when a drill is started', async () => {
      await session.newGame(options({ difficulty: { mode: 'adaptive', level: 3 } }))
      expect(settings.get()).toMatchObject({
        defaultModel: 'gpt-6-astra',
        defaultEffort: 'medium',
        lastDifficulty: { mode: 'adaptive', level: 3 }
      })

      // The training screen starts drills with a difficulty and a model of its own: the dialog
      // must still reopen on what the user chose for their games (spec §4.3).
      await session.newGame(
        options({ kind: 'endgame_drill', difficulty: { mode: 'fixed', level: 6 }, model: 'gpt-5.5', effort: 'xhigh', startFen: MATE_IN_ONE })
      )
      expect(settings.get()).toMatchObject({
        defaultModel: 'gpt-6-astra',
        defaultEffort: 'medium',
        lastDifficulty: { mode: 'adaptive', level: 3 }
      })
    })
  })

  describe('coach', () => {
    /** The coach describe block is the only one that wants a comment after every move. */
    const seen = (over: Partial<NewGameOptions> = {}): NewGameOptions => options({ commentsVisible: true, ...over })

    const commented = (ply: number): Promise<void> =>
      vi.waitFor(() => expect(session.state().game!.moves[ply - 1]!.coachComment).toBeTruthy())

    it('opens the coach thread with the tutor persona next to the opponent one', async () => {
      await session.newGame(seen())
      expect(codex.started.map((thread) => thread.role)).toEqual(['opponent', 'coach'])
      expect(codex.started[1]!.model).toBe('gpt-6-astra')
      expect(codex.started[1]!.gameId).toBe(session.state().game!.id)
      expect(codex.started[1]!.baseInstructions).toMatch(/allenatore/)
      expect(session.state().coach).toEqual({ commentsVisible: true, busy: false, streamId: null, hint: null, lastAnswer: null })
    })

    it('comments both moves and saves them on the move and in the log', async () => {
      await session.newGame(seen())
      const state = await session.userMove('e2e4')
      await commented(1)
      await commented(2)

      const game = session.state().game!
      expect(game.moves[0]!.coachComment).toBe('Commento finto.')
      expect(game.moves[0]!.coachCommentLanguage).toBe('it')
      const comments = game.coachLog.filter((entry) => entry.kind === 'comment')
      expect(comments.map((entry) => entry.ply)).toEqual([1, 2])
      expect(comments[0]).toMatchObject({ move: 'e4', language: 'it', text: 'Commento finto.' })
      // Comments are autosaved like everything else.
      expect((await store.get(state.game!.id))!.moves[0]!.coachComment).toBe('Commento finto.')

      // The comment turn carries the move, the position it was played from and the engine lines.
      const comment = codex.requests.find((request) => request.text.includes('Commenta'))!
      expect(comment.text).toContain('1. e4 (e2e4)')
      expect(comment.text).toContain('+0.30')
      expect(comment.outputSchema).toBeUndefined()
    })

    it('never makes the opponent turn wait for a comment', async () => {
      await session.newGame(seen())
      codex.holdCoach()
      const state = await session.userMove('e2e4')

      // The AI has already answered while the first comment is still being written.
      expect(state.game!.moves).toHaveLength(2)
      expect(state.game!.moves[1]!.by).toBe('ai')
      expect(state.game!.moves[0]!.coachComment).toBeUndefined()
      await vi.waitFor(() => expect(session.state().coach.busy).toBe(true))
      expect(session.state().coach.streamId).toMatch(/[0-9a-f-]{36}/)

      codex.releaseCoach()
      await commented(1)
      await vi.waitFor(() => expect(session.state().coach.busy).toBe(false))
    })

    it('comments nothing while they are hidden, and never comments backwards', async () => {
      await session.newGame(seen({ commentsVisible: false }))
      await session.userMove('e2e4')
      expect(session.state().coach.commentsVisible).toBe(false)

      const shown = session.setCommentsVisible(true)
      expect(shown.coach.commentsVisible).toBe(true)
      await session.userMove('d2d4')
      await commented(3)
      await commented(4)

      // The two plies played while the comments were hidden stay uncommented (spec §4.2).
      const moves = session.state().game!.moves
      expect(moves[0]!.coachComment).toBeUndefined()
      expect(moves[1]!.coachComment).toBeUndefined()
    })

    it('comments at most six skipped moves, in order', async () => {
      await session.newGame(seen({ commentsVisible: false }))
      for (let move = 0; move < 4; move += 1) await session.userMove(legalMoves(session.state().fen)[0]!.uci)
      expect(session.state().game!.moves).toHaveLength(8)

      session.commentSkipped()
      await commented(8)
      await vi.waitFor(() => expect(session.state().game!.coachLog).toHaveLength(6))

      const moves = session.state().game!.moves
      expect(moves.filter((move) => move.coachComment).map((move) => move.ply)).toEqual([3, 4, 5, 6, 7, 8])
      expect(session.state().game!.coachLog.map((entry) => entry.ply)).toEqual([3, 4, 5, 6, 7, 8])
    })

    it('answers a question and records both sides of it in the log', async () => {
      await session.newGame(seen({ commentsVisible: false }))
      const state = await session.askCoach('  che piano ho?  ')

      expect(state.coach.lastAnswer).toEqual({ question: 'che piano ho?', text: 'Risposta finta.', ply: 0 })
      expect(state.game!.coachLog.map((entry) => entry.kind)).toEqual(['question', 'answer'])
      expect(state.game!.coachLog[0]!.text).toBe('che piano ho?')
      expect(codex.requests[0]!.text).toContain('Domanda: che piano ho?')
      expect((await store.get(state.game!.id))!.coachLog).toHaveLength(2)
      await expect(session.askCoach('   ')).rejects.toMatchObject({ code: 'BAD_QUESTION' })
    })

    it('draws a hint until the next user move', async () => {
      await session.newGame(seen({ commentsVisible: false }))
      const state = await session.requestHint()

      expect(state.coach.hint).toEqual({ move: 'Na3', uci: 'b1a3', reason: 'occupa il centro' })
      expect(state.game!.coachLog[0]).toMatchObject({ kind: 'hint', move: 'Na3', text: 'occupa il centro' })
      expect(codex.requests[0]!.outputSchema).toMatchObject({ required: ['move', 'reason'] })

      const moved = await session.userMove('e2e4')
      expect(moved.coach.hint).toBeNull()
    })

    it('drops the hint on request and on a takeback', async () => {
      await session.newGame(seen({ commentsVisible: false }))
      await session.requestHint()
      expect(session.clearHint().coach.hint).toBeNull()

      // A takeback changes the position the hint was given for, so the arrow goes with it.
      await session.userMove('e2e4')
      await session.requestHint()
      expect(session.state().coach.hint).not.toBeNull()
      expect((await session.takeback()).coach.hint).toBeNull()
    })

    it('recreates the coach thread on resume and rides the recap on the first comment', async () => {
      const game = await store.create({
        kind: 'match',
        userColor: 'w',
        opponent: { model: 'gpt-6-astra', effort: 'medium', difficulty: { mode: 'fixed', level: 3, targetElo: 1200 } },
        coach: { model: 'gpt-6-astra', effort: 'medium' },
        clock: null,
        language: 'it'
      })
      const applied = applyMove(START_FEN, 'e2e4')!
      game.moves.push({ ply: 1, san: applied.san, uci: 'e2e4', fenAfter: applied.fen, epdAfter: epdOf(applied.fen), by: 'user' })
      game.coachLog.push({ id: 'c1', ply: 1, kind: 'question', text: 'che piano ho?', language: 'it', createdAt: '2026-01-01T00:00:00.000Z' })
      game.coachLog.push({ id: 'c2', ply: 1, kind: 'answer', text: 'sviluppa i pezzi', language: 'it', createdAt: '2026-01-01T00:00:00.000Z' })
      await store.save(game)

      await session.resume(game.id)
      expect(codex.started.map((thread) => thread.role)).toEqual(['opponent', 'coach'])
      // The comment on the AI answer is the first coach turn, and it carries the recap.
      await commented(2)
      const comment = codex.requests.find((request) => request.text.includes('Commenta'))!
      expect(comment.text).toMatch(/riprende da un salvataggio/)
      expect(comment.text).toContain('sviluppa i pezzi')
    })

    it('keeps playing when the coach cannot answer', async () => {
      await session.newGame(seen())
      codex.script = [
        { ok: true, text: JSON.stringify({ move: 'Na6', shortComment: 'ok' }), turnId: 'm1', effectiveModel: null, durationMs: 1 },
        { ok: false, reason: 'failed', message: 'coach down', turnId: null },
        { ok: false, reason: 'failed', message: 'coach down', turnId: null }
      ]
      const state = await session.userMove('e2e4')
      expect(state.status).toBe('playing')
      expect(state.game!.moves).toHaveLength(2)
      await vi.waitFor(() => expect(session.state().coach.busy).toBe(false))
      expect(session.state().game!.moves[0]!.coachComment).toBeUndefined()
      expect(session.state().error).toBeNull()
    })
  })

  describe('clocks', () => {
    const FIVE_MINUTES = 300_000
    /** The wall clock of these tests moves only when a test says so. */
    let at = 0

    const timed = (clock: NewGameOptions['clock'] = { initialMs: FIVE_MINUTES, incrementMs: 3_000, aiClock: false }): NewGameOptions =>
      options({ clock })

    /** A session whose `now()` is frozen: nothing but the test advances the clocks. */
    const buildFrozen = (): void => {
      at = 1_700_000_000_000
      session = new GameSession({ codex, engine: fakeEngine(), store, settings, profile, emit, now: () => at })
    }

    beforeEach(() => buildFrozen())

    it('plays without clocks unless the dialog asked for one', async () => {
      const state = await session.newGame(options())
      expect(state.clock).toBeNull()
      expect(state.game!.clock).toBeNull()
      await session.userMove('e2e4')
      expect(session.state().game!.moves[0]!.clockAfter).toBeUndefined()
    })

    it('runs the user clock and credits the increment to whoever has moved', async () => {
      const state = await session.newGame(timed())
      expect(state.game!.clock).toEqual({ initialMs: FIVE_MINUTES, incrementMs: 3_000, aiClock: false, remainingMs: { w: FIVE_MINUTES, b: FIVE_MINUTES } })
      expect(state.clock).toEqual({ remainingMs: { w: FIVE_MINUTES, b: FIVE_MINUTES }, running: 'w', updatedAt: at })

      at += 10_000
      const moved = await session.userMove('e2e4')
      // 10 s burned, 3 s of increment credited right after the move was validated.
      expect(moved.game!.moves[0]!.clockAfter).toEqual({ w: 293_000, b: FIVE_MINUTES })
      expect(moved.clock).toEqual({ remainingMs: { w: 293_000, b: FIVE_MINUTES }, running: 'w', updatedAt: at })
      expect(moved.game!.clock!.remainingMs).toEqual({ w: 293_000, b: FIVE_MINUTES })
      expect((await store.get(moved.game!.id))!.clock!.remainingMs).toEqual({ w: 293_000, b: FIVE_MINUTES })
    })

    it('never runs the AI clock in "solo il mio tempo"', async () => {
      await session.newGame(timed())
      at += 5_000
      await session.userMove('e2e4')
      expect(session.state().clock!.remainingMs).toEqual({ w: 298_000, b: FIVE_MINUTES })

      codex.hold()
      const pending = session.userMove(legalMoves(session.state().fen)[0]!.uci)
      await vi.waitFor(() => expect(session.state().ai.thinking).toBe(true))
      // The opponent is thinking: nobody's clock is running and the AI never loses a millisecond.
      expect(session.state().clock!.running).toBeNull()
      at += 60_000
      expect(session.state().clock!.remainingMs).toEqual({ w: 301_000, b: FIVE_MINUTES })

      await session.takeback()
      await pending
    })

    it('charges the AI only the thinking time of the accepted attempt', async () => {
      await session.newGame(timed({ initialMs: 60_000, incrementMs: 2_000, aiClock: true }))
      // Every attempt burns four seconds of wall time; only the last one is charged (spec §4.3).
      codex.onTurn = () => {
        at += 4_000
      }
      codex.script = [
        { ok: false, reason: 'failed', message: 'hiccup', turnId: null },
        { ok: false, reason: 'failed', message: 'hiccup', turnId: null }
      ]
      const state = await session.userMove('e2e4')

      const answer = state.game!.moves[1]!
      expect(answer.thinkingMs).toBe(4_000)
      expect(answer.thinkingOverheadMs).toBe(8_000)
      expect(answer.clockAfter).toEqual({ w: 62_000, b: 58_000 })
      expect(state.clock!.remainingMs).toEqual({ w: 62_000, b: 58_000 })
      // Spec §4.3: the turn can never be given more time than the AI has left, plus two seconds.
      expect(codex.requests[0]!.timeoutMs).toBe(62_000)
    })

    it('finishes the game on time when the user flag falls', async () => {
      const started = await session.newGame(timed({ initialMs: 5_000, incrementMs: 0, aiClock: false }))
      at += 6_000
      const state = await session.checkClock()

      expect(state.status).toBe('finished')
      expect(state.game!.result).toEqual({ outcome: '0-1', reason: 'timeout' })
      expect(state.clock).toEqual({ remainingMs: { w: 0, b: 5_000 }, running: null, updatedAt: at })
      expect(emit).toHaveBeenCalledWith('game:finished', { gameId: started.game!.id, result: { outcome: '0-1', reason: 'timeout' } })
      expect((await store.get(started.game!.id))!.clock!.remainingMs.w).toBe(0)
    })

    it('interrupts the opponent turn when the AI runs out of time', async () => {
      await session.newGame(timed({ initialMs: 3_000, incrementMs: 0, aiClock: true }))
      codex.hold()
      const pending = session.userMove('e2e4')
      await vi.waitFor(() => expect(session.state().ai.thinking).toBe(true))
      expect(session.state().clock!.running).toBe('b')

      at += 10_000
      const state = await session.checkClock()
      await pending

      expect(codex.interrupted).toEqual(['thread-1'])
      expect(state.ai.thinking).toBe(false)
      expect(state.status).toBe('finished')
      // The AI plays Black: its flag is the user's win.
      expect(state.game!.result).toEqual({ outcome: '1-0', reason: 'timeout' })
      expect(state.clock!.remainingMs.b).toBe(0)
    })

    it('puts the clocks back where the takeback puts the moves', async () => {
      await session.newGame(timed())
      at += 20_000
      await session.userMove('e2e4')
      at += 15_000
      await session.userMove(legalMoves(session.state().fen)[0]!.uci)
      expect(session.state().clock!.remainingMs).toEqual({ w: 271_000, b: FIVE_MINUTES })

      const back = await session.takeback()
      expect(back.game!.moves).toHaveLength(2)
      // 300 s − 20 s + 3 s of increment: what the first pair of moves left on the clock.
      expect(back.clock!.remainingMs).toEqual({ w: 283_000, b: FIVE_MINUTES })
      expect(back.game!.clock!.remainingMs).toEqual({ w: 283_000, b: FIVE_MINUTES })

      // Back to the empty board: the clocks are the ones the game started with.
      const empty = await session.takeback()
      expect(empty.game!.moves).toHaveLength(0)
      expect(empty.clock!.remainingMs).toEqual({ w: FIVE_MINUTES, b: FIVE_MINUTES })
    })

    it('resumes a game with the time it had left on disk', async () => {
      const game = await store.create({
        kind: 'match',
        userColor: 'w',
        opponent: { model: 'gpt-6-astra', effort: 'medium', difficulty: { mode: 'fixed', level: 3, targetElo: 1200 } },
        coach: { model: 'gpt-6-astra', effort: 'medium' },
        clock: { initialMs: FIVE_MINUTES, incrementMs: 3_000, aiClock: false, remainingMs: { w: 123_000, b: FIVE_MINUTES } },
        language: 'it'
      })
      const applied = applyMove(START_FEN, 'e2e4')!
      game.moves.push({
        ply: 1,
        san: applied.san,
        uci: 'e2e4',
        fenAfter: applied.fen,
        epdAfter: epdOf(applied.fen),
        by: 'user',
        clockAfter: { w: 123_000, b: FIVE_MINUTES }
      })
      await store.save(game)

      const state = await session.resume(game.id)
      // The AI answered on resume; the user's remaining time is the one that was saved.
      expect(state.game!.moves).toHaveLength(2)
      expect(state.clock).toEqual({ remainingMs: { w: 123_000, b: FIVE_MINUTES }, running: 'w', updatedAt: at })
    })

    it('republishes the state once a second while a clock runs', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
      try {
        await session.newGame(timed())
        emit.mockClear()
        at += 1_000
        await vi.advanceTimersByTimeAsync(1_000)

        const published = emit.mock.calls.filter(([channel]) => channel === 'game:state')
        expect(published).toHaveLength(1)
        expect((published[0]![1] as SessionState).clock).toEqual({ remainingMs: { w: 299_000, b: FIVE_MINUTES }, running: 'w', updatedAt: at })

        // A finished game stops the ticker.
        await session.resign()
        emit.mockClear()
        at += 2_000
        await vi.advanceTimersByTimeAsync(2_000)
        expect(emit.mock.calls.filter(([channel]) => channel === 'game:state')).toHaveLength(0)
      } finally {
        vi.useRealTimers()
      }
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
    // The coach thread goes first, then the opponent one.
    expect(codex.closed).toEqual(['thread-2', 'thread-1'])
    expect(session.state().game).toBeNull()
    expect(session.state().status).toBe('idle')
    expect((await store.get(id))!.status).toBe('in_progress')
  })
})
