import { join } from 'node:path'
import { Chess } from 'chess.js'
import { applyMove, epdOf, legalMoves } from '@shared/chess/notation'
import type { ModelInfo, TurnRequest, TurnResult } from '@shared/types/codex'
import type { Analysis } from '@shared/types/engine'
import type { Game, Move, MoveClassification } from '@shared/types/game'
import type { EngineState } from '@shared/types/engine'
import type { NewGameOptions, SessionState } from '@shared/types/session'
import type { EndgamePosition, Puzzle, TrainingChanged } from '@shared/types/training'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import type { SessionCodex, SessionEngine } from '../game/gameSession'
import { ExerciseStore } from '../store/exerciseStore'
import { GameStore } from '../store/gameStore'
import { ProfileStore } from '../store/profileStore'
import { SettingsStore } from '../store/settingsStore'
import { StudyPlanStore } from '../store/studyPlanStore'
import type { PickRequest } from '../data/puzzleLibrary'
import { endgameExerciseId, TrainingService, type TrainingLibrary } from './trainingService'
import { thematicExerciseId } from './thematic'

const MIDDLEGAME = 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4'

/** Answers by the shape of the schema, exactly as the fake app-server does. */
class FakeCodex implements SessionCodex {
  readonly started: { role: string; model: string }[] = []
  readonly requests: TurnRequest[] = []
  readonly closed: string[] = []
  /** What the theme pick answers; `null` makes the turn fail instead. */
  themePick: Record<string, unknown> | null = { theme: 'pin', ratingMin: 1000, ratingMax: 1400, motivation: 'motivo finto' }
  /** Plan items, answered in order: one array per call. */
  planAnswers: unknown[][] = []
  text = 'Spiegazione finta.'
  private threads = 0

  async startThread(role: 'opponent' | 'coach' | 'training', opts: { model: string }): Promise<string> {
    this.started.push({ role, model: opts.model })
    this.threads += 1
    return `thread-${this.threads}`
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    this.requests.push(req)
    const properties = (req.outputSchema as { properties?: Record<string, unknown> } | undefined)?.properties ?? {}
    if ('theme' in properties) {
      if (!this.themePick) return { ok: false, reason: 'failed', message: 'fake failure', turnId: null }
      return { ok: true, text: JSON.stringify(this.themePick), turnId: 't', effectiveModel: null, durationMs: 1 }
    }
    if ('items' in properties) {
      const items = this.planAnswers.shift() ?? []
      return { ok: true, text: JSON.stringify({ items }), turnId: 't', effectiveModel: null, durationMs: 1 }
    }
    return { ok: true, text: this.text, turnId: 't', effectiveModel: null, durationMs: 1 }
  }

  async interrupt(): Promise<void> {
    // Nothing to interrupt: every fake turn answers at once.
  }

  async closeThread(threadId: string): Promise<void> {
    this.closed.push(threadId)
  }

  models(): ModelInfo[] {
    return []
  }
}

/** Stockfish stand-in: the first legal move of the position, with the score the test asked for. */
class FakeEngine implements SessionEngine {
  available = true
  readonly analysed: string[] = []

  constructor(private readonly score = 300) {}

  state(): EngineState {
    return { available: this.available, binary: 'avx2', version: 'fake', message: null }
  }

  async analyze(fen: string): Promise<Analysis> {
    this.analysed.push(fen)
    const moves = legalMoves(fen)
    if (moves.length === 0) return { bestMove: null, lines: [], depth: 20, fen }
    const best = moves[0]!
    const after = applyMove(fen, best.uci)
    const reply = after ? legalMoves(after.fen)[0] : undefined
    return {
      bestMove: best.uci,
      lines: [
        { move: best.uci, pv: reply ? [best.uci, reply.uci] : [best.uci], scoreCp: this.score, depth: 20 },
        { move: moves[1]!.uci, pv: [moves[1]!.uci], scoreCp: this.score - 400, depth: 20 }
      ],
      depth: 20,
      fen
    }
  }
}

const puzzle = (id: string, rating: number, theme: string): Puzzle => ({
  id,
  fen: MIDDLEGAME,
  sideToMove: 'w',
  solution: [legalMoves(MIDDLEGAME)[0]!.uci, 'e7e6'],
  rating,
  themes: [theme],
  source: 'lichess'
})

const ENDGAMES: EndgamePosition[] = [
  { id: 'queen_mate', name: { it: 'Matto con la donna', en: 'Queen mate' }, fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1', sideToMove: 'w', goal: 'win', difficulty: 1, theme: 'endgame_technique' },
  { id: 'philidor', name: { it: 'Philidor', en: 'Philidor' }, fen: '8/8/8/8/8/1k6/8/K7 b - - 0 1', sideToMove: 'b', goal: 'draw', difficulty: 2, theme: 'endgame_technique' }
]

/** A library with a handful of puzzles, so a set can be drawn without the real dataset. */
class FakeLibrary implements TrainingLibrary {
  puzzles: Puzzle[] = [puzzle('p1', 1100, 'pin'), puzzle('p2', 1200, 'pin'), puzzle('p3', 900, 'fork')]
  readonly picks: PickRequest[] = []

  pick(p: PickRequest): Puzzle[] {
    this.picks.push(p)
    return this.puzzles.filter((entry) => entry.themes.includes(p.theme) && entry.rating >= p.ratingMin && entry.rating <= p.ratingMax && !p.exclude.has(entry.id)).slice(0, p.count)
  }

  themes(): { theme: string; count: number }[] {
    return [
      { theme: 'pin', count: 2 },
      { theme: 'fork', count: 1 }
    ]
  }

  endgames(): EndgamePosition[] {
    return ENDGAMES.map((endgame) => ({ ...endgame, name: { ...endgame.name } }))
  }

  get(id: string): Puzzle | null {
    return this.puzzles.find((entry) => entry.id === id) ?? null
  }
}

/** A game with real moves and the evaluations the extraction filters on. */
function analysedGame(p: { sans: string[]; classifications: (MoveClassification | undefined)[]; eco?: string; result?: Game['result'] }): Omit<Game, 'id' | 'createdAt' | 'updatedAt' | 'status'> {
  const chess = new Chess()
  const moves: Move[] = p.sans.map((san, index) => {
    const played = chess.move(san)
    const classification = p.classifications[index]
    const move: Move = {
      ply: index + 1,
      san: played.san,
      uci: played.lan,
      fenAfter: chess.fen(),
      epdAfter: epdOf(chess.fen()),
      by: index % 2 === 0 ? 'user' : 'ai'
    }
    if (classification) {
      move.eval = {
        before: { cp: 30 },
        after: { cp: -250 },
        cpLoss: 280,
        winPercentLoss: 24,
        classification,
        bestMove: 'g1f3',
        bestLine: ['g1f3'],
      }
    }
    return move
  })
  return {
    kind: 'match',
    userColor: 'w',
    opponent: { model: 'gpt-6-astra', effort: 'medium', difficulty: { mode: 'fixed', level: 3, targetElo: 1200 } },
    coach: { model: 'gpt-6-astra', effort: 'medium' },
    clock: null,
    language: 'it',
    moves,
    takebacks: 0,
    coachLog: [],
    ...(p.result ? { result: p.result } : {}),
    analysis: { accuracy: { w: 78, b: 70 }, acpl: { w: 45, b: 60 }, keyMoments: [3], analyzedAt: '2026-03-01T10:40:00.000Z' },
    ...(p.eco ? { opening: { eco: p.eco, name: 'Partita spagnola', lastBookPly: 4 } } : {})
  } as Omit<Game, 'id' | 'createdAt' | 'updatedAt' | 'status'>
}

describe('TrainingService', () => {
  let root: string
  let codex: FakeCodex
  let engine: FakeEngine
  let library: FakeLibrary
  let settings: SettingsStore
  let profile: ProfileStore
  let games: GameStore
  let exercises: ExerciseStore
  let plans: StudyPlanStore
  let events: TrainingChanged[]
  let started: NewGameOptions[]
  let service: TrainingService

  beforeEach(async () => {
    root = await makeTmpDir()
    codex = new FakeCodex()
    engine = new FakeEngine()
    library = new FakeLibrary()
    settings = new SettingsStore(join(root, 'settings.json'))
    await settings.load()
    await settings.save({ defaultModel: 'gpt-6-astra', defaultEffort: 'medium', language: 'it' })
    profile = new ProfileStore(join(root, 'profile.json'))
    await profile.load()
    games = new GameStore(join(root, 'games'))
    await games.load()
    exercises = new ExerciseStore(join(root, 'exercises.json'))
    await exercises.load()
    plans = new StudyPlanStore(join(root, 'study-plan.json'))
    await plans.load()
    events = []
    started = []
    service = new TrainingService({
      codex,
      engine,
      settings,
      profile,
      games,
      exercises,
      plans,
      library,
      startGame: async (opts) => {
        started.push(opts)
        const game = await games.create({ ...analysedGame({ sans: [], classifications: [] }), kind: 'endgame_drill', startFen: opts.startFen, userColor: opts.userColor === 'b' ? 'b' : 'w' })
        return { game } as SessionState
      },
      emit: (channel, payload) => {
        if (channel === 'training:changed') events.push(payload as TrainingChanged)
      },
      now: () => Date.parse('2026-03-03T12:00:00.000Z')
    })
  })

  afterEach(async () => {
    await removeTmpDir(root)
  })

  /** `GameStore.create` always starts a game empty: the moves are written by the save that follows. */
  async function storeGame(init: Omit<Game, 'id' | 'createdAt' | 'updatedAt' | 'status'>): Promise<Game> {
    const created = await games.create(init)
    const game: Game = { ...created, moves: init.moves, status: 'finished' }
    await games.save(game)
    return game
  }

  // ───────────────────────────────────────────────────── own-game exercises

  it('builds the exercises of an analysed game and never rebuilds them', async () => {
    const game = await storeGame(analysedGame({ sans: ['e4', 'e5', 'Nf3'], classifications: [undefined, undefined, 'blunder'] }))
    await service.onGameAnalyzed(game)
    const built = service.list('own_game')
    expect(built).toHaveLength(1)
    expect(built[0]?.id).toBe(`og-${game.id}-3`)
    expect(built[0]?.sourceGameId).toBe(game.id)
    expect(events.some((event) => event.kind === 'exercises')).toBe(true)

    const before = engine.analysed.length
    await service.onGameAnalyzed(game)
    expect(service.list('own_game')).toHaveLength(1)
    expect(engine.analysed.length).toBe(before)
  })

  it('builds nothing without an engine, and nothing for a drill', async () => {
    engine.available = false
    const game = await storeGame(analysedGame({ sans: ['e4', 'e5', 'Nf3'], classifications: [undefined, undefined, 'blunder'] }))
    await service.onGameAnalyzed(game)
    expect(service.list('own_game')).toEqual([])

    engine.available = true
    await service.onGameAnalyzed({ ...game, kind: 'endgame_drill' })
    expect(service.list('own_game')).toEqual([])
  })

  // ─────────────────────────────────────────────────────────────── attempts

  it('walks an exercise through its state machine', async () => {
    await exercises.put({
      id: 'tac-1',
      kind: 'thematic',
      fen: MIDDLEGAME,
      sideToMove: 'w',
      solution: solutionOf(MIDDLEGAME, 4),
      theme: 'pin',
      status: 'new',
      attempts: 0,
      createdAt: '2026-03-01T10:00:00.000Z'
    })
    const solution = service.get('tac-1')!.solution

    const wrong = await service.attempt('tac-1', legalMoves(MIDDLEGAME).find((move) => move.uci !== solution[0])!.uci)
    expect(wrong.correct).toBe(false)
    expect(service.get('tac-1')?.status).toBe('failed')
    expect(service.get('tac-1')?.attempts).toBe(1)

    const first = await service.attempt('tac-1', solution[0]!)
    expect(first.correct).toBe(true)
    expect(first.done).toBe(false)
    expect(first.reply).toBe(solution[1])

    const second = await service.attempt('tac-1', solution[2]!)
    expect(second.done).toBe(true)
    expect(service.get('tac-1')?.status).toBe('solved')
    expect(service.get('tac-1')?.solvedAt).toBe('2026-03-03T12:00:00.000Z')
    expect(service.get('tac-1')?.attempts).toBe(3)

    const reset = await service.reset('tac-1')
    expect(reset.status).toBe('new')
    expect(reset.attempts).toBe(0)
    expect(reset.solvedAt).toBeUndefined()
    // The position is back at the start: the first move is accepted again.
    expect((await service.attempt('tac-1', solution[0]!)).correct).toBe(true)
  })

  it('refuses to play an endgame as an exercise and an unknown id', async () => {
    await expect(service.attempt('nothing', 'e2e4')).rejects.toThrow(/no exercise/)
    await service.startEndgame('queen_mate')
    await expect(service.attempt(endgameExerciseId('queen_mate'), 'd1d5')).rejects.toThrow(/played as a game/)
  })

  it('asks the coach for an explanation and keeps it on the exercise', async () => {
    const game = await storeGame(analysedGame({ sans: ['e4', 'e5', 'Nf3'], classifications: [undefined, undefined, 'blunder'] }))
    await service.onGameAnalyzed(game)
    const id = `og-${game.id}-3`

    const text = await service.explain(id)
    expect(text).toBe('Spiegazione finta.')
    expect(service.get(id)?.explanation).toBe('Spiegazione finta.')
    expect(codex.requests.at(-1)?.text).toContain('Spiega')
    // The move actually played is part of the prompt, taken from the source game.
    expect(codex.requests.at(-1)?.text).toContain('Nf3')
    expect(codex.closed).toHaveLength(1)
    const activity = events.filter((event) => event.kind === 'activity')
    expect(activity).toHaveLength(2)
    expect(activity[0]?.activity?.busy).toBe(true)
    expect(activity[0]?.activity?.streamId).toBeTruthy()
    expect(activity[1]?.activity?.busy).toBe(false)
  })

  // ──────────────────────────────────────────────────────────── thematic sets

  it('rotates the themes while the profile says nothing, without asking the coach', async () => {
    const set = await service.nextThematicSet()
    expect(codex.requests).toHaveLength(0)
    expect(set.fallback).toBe(true)
    expect(set.theme).toBe('fork')
    expect(set.ratingMin).toBe(800)
    expect(set.ratingMax).toBe(1200)
    expect(set.exercises.map((exercise) => exercise.id)).toEqual([thematicExerciseId('p3')])
  })

  it('asks the coach once the profile has something to read, and excludes the solved puzzles', async () => {
    await profile.update({ themeStats: { pin: { occurrences: 4, lastSeen: '2026-03-01T10:00:00.000Z' } } })
    const first = await service.nextThematicSet()
    expect(first.fallback).toBe(false)
    expect(first.theme).toBe('pin')
    expect(first.motivation).toBe('motivo finto')
    expect(first.exercises.map((exercise) => exercise.id)).toEqual([thematicExerciseId('p1'), thematicExerciseId('p2')])

    await exercises.update(thematicExerciseId('p1'), { status: 'solved' })
    const second = await service.nextThematicSet()
    expect(second.exercises.map((exercise) => exercise.id)).toEqual([thematicExerciseId('p2')])
    expect(library.picks.at(-1)?.exclude.has('p1')).toBe(true)
  })

  it('falls back to the rotation when the coach turn fails or draws nothing', async () => {
    await profile.update({ themeStats: { pin: { occurrences: 4, lastSeen: '2026-03-01T10:00:00.000Z' } } })
    codex.themePick = null
    const failed = await service.nextThematicSet()
    expect(failed.fallback).toBe(true)

    codex.themePick = { theme: 'pin', ratingMin: 2000, ratingMax: 2200, motivation: 'niente in quella fascia' }
    const empty = await service.nextThematicSet()
    expect(empty.fallback).toBe(true)
    expect(empty.exercises.length).toBeGreaterThan(0)
  })

  // ───────────────────────────────────────────────────────────────── openings

  it('builds the openings overview and the mini-lesson of one of them', async () => {
    await profile.update({ openingStats: { C60: { eco: 'C60', name: 'Partita spagnola', games: 2, wins: 1, draws: 0, losses: 1, avgAccuracyFirst10: 80 } } })
    await storeGame(analysedGame({ sans: ['e4', 'e5', 'Nf3'], classifications: [undefined, undefined, 'mistake'], eco: 'C60' }))

    const overview = await service.openingsOverview()
    expect(overview).toHaveLength(1)
    expect(overview[0]?.score).toBe(50)
    expect(overview[0]?.deviations[0]?.san).toBe('Nf3')

    expect(await service.openingLesson('C60')).toBe('Spiegazione finta.')
    expect(codex.requests.at(-1)?.text).toContain('C60 Partita spagnola')
    await expect(service.openingLesson('B20')).rejects.toThrow(/no opening/)
  })

  // ───────────────────────────────────────────────────────────────── endgames

  it('starts a drill at the maximum level and records its result', async () => {
    const list = service.endgames()
    expect(list.map((entry) => entry.id)).toEqual(['queen_mate', 'philidor'])
    expect(list[0]?.status).toBe('new')

    const state = await service.startEndgame('queen_mate')
    expect(started[0]?.kind).toBe('endgame_drill')
    expect(started[0]?.difficulty).toEqual({ mode: 'fixed', level: 6 })
    expect(started[0]?.startFen).toBe(ENDGAMES[0]!.fen)
    expect(started[0]?.userColor).toBe('w')
    const record = service.get(endgameExerciseId('queen_mate'))!
    expect(record.attempts).toBe(1)
    expect(record.sourceGameId).toBe(state.game!.id)

    await service.onGameFinished({ ...state.game!, kind: 'endgame_drill', userColor: 'w', result: { outcome: '1-0', reason: 'checkmate' } })
    expect(service.get(endgameExerciseId('queen_mate'))?.status).toBe('solved')
    expect(service.endgames()[0]?.status).toBe('solved')
  })

  it('marks a drill failed when the goal was not reached, and a draw goal as reached', async () => {
    const won = await service.startEndgame('queen_mate')
    await service.onGameFinished({ ...won.game!, kind: 'endgame_drill', userColor: 'w', result: { outcome: '1/2-1/2', reason: 'stalemate' } })
    expect(service.get(endgameExerciseId('queen_mate'))?.status).toBe('failed')

    const drawn = await service.startEndgame('philidor')
    expect(started.at(-1)?.userColor).toBe('b')
    await service.onGameFinished({ ...drawn.game!, kind: 'endgame_drill', userColor: 'b', result: { outcome: '1/2-1/2', reason: 'repetition' } })
    expect(service.get(endgameExerciseId('philidor'))?.status).toBe('solved')
  })

  it('refuses an endgame that is not in the dataset', async () => {
    await expect(service.startEndgame('lucena')).rejects.toThrow(/no endgame/)
  })

  // ─────────────────────────────────────────────────────────────── study plan

  it('drops the invented references and saves what is left', async () => {
    await profile.update({ openingStats: { C60: { eco: 'C60', name: 'Spagnola', games: 2, wins: 1, draws: 0, losses: 1, avgAccuracyFirst10: 80 } }, gamesSincePlan: 7 })
    codex.planAnswers = [
      [
        { title: 'Tattica', why: 'perché', activity: { type: 'thematic', ref: 'fork' } },
        { title: 'Esercizio inventato', why: 'perché', activity: { type: 'own_game', ref: 'og-nope-1' } },
        { title: 'Apertura', why: 'perché', activity: { type: 'opening', ref: 'C60' } },
        { title: 'Finale', why: 'perché', activity: { type: 'endgame', ref: 'queen_mate' } },
        { title: 'Gioca', why: 'perché', activity: { type: 'play', ref: null } }
      ]
    ]
    const view = await service.generatePlan()
    expect(view.plan?.items.map((item) => item.activity.ref)).toEqual(['fork', 'C60', 'queen_mate', null])
    expect(view.gamesSincePlan).toBe(0)
    expect(profile.get().gamesSincePlan).toBe(0)
    expect(view.suggestRegenerate).toBe(false)
    expect(events.some((event) => event.kind === 'plan')).toBe(true)
  })

  it('asks a second time when too few items survived, and settles for what it gets', async () => {
    codex.planAnswers = [
      [{ title: 'Solo una', why: '', activity: { type: 'play', ref: null } }],
      [
        { title: 'Tattica', why: '', activity: { type: 'thematic', ref: 'fork' } },
        { title: 'Altra', why: '', activity: { type: 'thematic', ref: 'pin' } },
        { title: 'Terza', why: '', activity: { type: 'thematic', ref: 'skewer' } },
        { title: 'Gioca', why: '', activity: { type: 'play', ref: null } }
      ]
    ]
    const view = await service.generatePlan()
    expect(codex.requests.filter((request) => request.outputSchema)).toHaveLength(2)
    expect(view.plan?.items).toHaveLength(4)
  })

  it('refuses a plan with nothing usable in it', async () => {
    codex.planAnswers = [[], []]
    await expect(service.generatePlan()).rejects.toThrow(/without a single usable item/)
  })

  it('marks the dangling references at read time and proposes a new plan', async () => {
    const game = await storeGame(analysedGame({ sans: ['e4', 'e5', 'Nf3'], classifications: [undefined, undefined, 'blunder'] }))
    await service.onGameAnalyzed(game)
    const exerciseId = `og-${game.id}-3`
    codex.planAnswers = [
      [
        { title: 'Esercizio', why: '', activity: { type: 'own_game', ref: exerciseId } },
        { title: 'Tattica', why: '', activity: { type: 'thematic', ref: 'fork' } },
        { title: 'Finale', why: '', activity: { type: 'endgame', ref: 'queen_mate' } },
        { title: 'Gioca', why: '', activity: { type: 'play', ref: null } }
      ]
    ]
    await service.generatePlan()
    expect(service.plan().invalidRefs).toBe(0)

    // The exercise is solved, so it leaves the catalogue: the item that pointed at it goes stale.
    await exercises.update(exerciseId, { status: 'solved' })
    const stale = service.plan()
    expect(stale.invalidRefs).toBe(1)
    expect(stale.plan?.items[0]?.invalidRef).toBe(true)
    expect(stale.suggestRegenerate).toBe(false)

    await profile.update({ gamesSincePlan: 5 })
    expect(service.plan().suggestRegenerate).toBe(true)
  })

  it('ticks an item of the plan off', async () => {
    codex.planAnswers = [
      [
        { title: 'Tattica', why: '', activity: { type: 'thematic', ref: 'fork' } },
        { title: 'Gioca', why: '', activity: { type: 'play', ref: null } }
      ],
      []
    ]
    await service.generatePlan()
    const view = service.plan()
    const itemId = view.plan!.items[0]!.id
    const updated = await service.markDone(itemId)
    expect(updated.plan?.items.find((item) => item.id === itemId)?.done).toBe(true)
    expect((await service.markDone(itemId, false)).plan?.items[0]?.done).toBe(false)
  })

  it('answers an empty view while there is no plan at all', () => {
    expect(service.plan()).toEqual({ plan: null, suggestRegenerate: false, invalidRefs: 0, gamesSincePlan: 0 })
  })
})

/** The first legal move of every position in a row: a playable line, whatever it is worth. */
function solutionOf(fen: string, plies: number): string[] {
  const line: string[] = []
  let current = fen
  for (let i = 0; i < plies; i += 1) {
    const move = legalMoves(current)[0]
    if (!move) break
    line.push(move.uci)
    const played = applyMove(current, move.uci)
    if (!played) break
    current = played.fen
  }
  return line
}
