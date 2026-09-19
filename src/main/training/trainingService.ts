import { randomUUID } from 'node:crypto'
import { Chess } from 'chess.js'
import { normalizeMove } from '@shared/chess/notation'
import type { StreamEnvelope } from '@shared/types/api'
import type { Game } from '@shared/types/game'
import type { Profile } from '@shared/types/profile'
import type { NewGameOptions, SessionState } from '@shared/types/session'
import type { Language } from '@shared/types/settings'
import type {
  AttemptResult,
  EndgameListEntry,
  EndgamePosition,
  Exercise,
  ExerciseKind,
  OpeningOverviewEntry,
  StudyCatalogue,
  StudyPlanView,
  ThematicSet,
  TrainingActivity,
  TrainingChanged
} from '@shared/types/training'
import { THEMATIC_SET_SIZE } from '@shared/types/training'
import type { PuzzleLibrary } from '../data/puzzleLibrary'
import type { SessionCodex, SessionEngine } from '../game/gameSession'
import type { ExerciseStore } from '../store/exerciseStore'
import type { GameStore } from '../store/gameStore'
import type { ProfileStore } from '../store/profileStore'
import type { SettingsStore } from '../store/settingsStore'
import type { StudyPlanStore } from '../store/studyPlanStore'
import {
  buildExercise,
  extractCandidates,
  judgeAttempt,
  ownGameExerciseId,
  startProgress,
  type ExerciseProgress
} from './exercises'
import { buildOpeningsOverview } from './openingsStudy'
import { buildCatalogue, planView, validatePlanItems, PLAN_MIN_ITEMS } from './studyPlan'
import {
  puzzleToExercise,
  rotationPick,
  sanitizeThemePick,
  thematicExerciseId,
  type ThemePick
} from './thematic'
import {
  explainExerciseText,
  openingLessonText,
  planSchema,
  planText,
  themePickText,
  trainingBaseInstructions,
  THEME_PICK_SCHEMA
} from './trainingPrompts'

/**
 * Owner of the training section (spec §3.1 TrainingService, §6.4–§6.8).
 *
 * It is the one place where the five ways of training meet: the exercises taken from the user's
 * own analysed games, the thematic sets drawn from the bundled puzzles, the openings the user
 * actually plays, the curated endgames — played as real drills against the opponent — and the
 * study plan that points at all of the above. It writes two files of its own (`exercises.json`
 * and `study-plan.json`) and reads everything else from the stores that already exist.
 *
 * Two rules run through the whole file. Nothing here may ever break what called it: the exercise
 * extraction hangs off the analysis of a finished game and is queued, caught and forgotten if it
 * fails. And every AI call is a short-lived `training` thread of its own with the coach's model
 * and effort, because none of these turns is a conversation.
 */

/** Exercises taken out of a single game: the worst mistakes, not every one of them. */
export const MAX_EXERCISES_PER_GAME = 4
/** Deterministic id of the record that follows one curated endgame. */
export const endgameExerciseId = (endgameId: string): string => `end-${endgameId}`

/** Carries a machine-readable code through the IPC error contract (`serializeError`). */
export class TrainingError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'TrainingError'
  }
}

/** The slice of {@link PuzzleLibrary} the service needs; a test can hand in its own. */
export type TrainingLibrary = Pick<PuzzleLibrary, 'pick' | 'themes' | 'endgames' | 'get'>

export interface TrainingServiceDeps {
  codex: SessionCodex
  /** Own-game exercises need Stockfish; everything else works without it (spec §6.4/§6.5). */
  engine: SessionEngine
  settings: SettingsStore
  profile: ProfileStore
  games: GameStore
  exercises: ExerciseStore
  plans: StudyPlanStore
  library: TrainingLibrary
  /** Starts the endgame drill of spec §6.7; the session is owned by the game layer. */
  startGame(opts: NewGameOptions): Promise<SessionState>
  emit(
    channel: 'training:changed' | 'profile:changed' | 'stream',
    payload: TrainingChanged | Profile | StreamEnvelope
  ): void
  now?: () => number
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

function parseObject(text: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(text))
  } catch {
    return null
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

/** A line of UCI moves rendered in SAN from `fen`; an unplayable tail is simply dropped. */
function sanLine(fen: string, uci: string[]): string[] {
  let chess: Chess
  try {
    chess = new Chess(fen)
  } catch {
    return []
  }
  const san: string[] = []
  for (const move of uci) {
    const normalized = normalizeMove(chess.fen(), move)
    if (!normalized) break
    try {
      san.push(chess.move(normalized.san).san)
    } catch {
      break
    }
  }
  return san
}

export class TrainingService {
  /** Every write is read-modify-write on one file: they run one after the other, never together. */
  private queue: Promise<unknown> = Promise.resolve()
  /** How far each exercise has been played; it lives as long as the process, not the file. */
  private readonly progress = new Map<string, ExerciseProgress>()

  constructor(private readonly deps: TrainingServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private stamp(): string {
    return new Date(this.now()).toISOString()
  }

  private language(): Language {
    return this.deps.settings.get().language
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private changed(payload: TrainingChanged): void {
    this.deps.emit('training:changed', payload)
  }

  /**
   * Coach model and effort (global constraint of the plan): the separate coach when the user
   * asked for one, then the default model of Settings.
   */
  private resolveModel(): { model: string; effort: string } {
    const settings = this.deps.settings.get()
    const effort = settings.defaultEffort || 'medium'
    if (settings.separateCoach && settings.coachModel)
      return { model: settings.coachModel, effort: settings.coachEffort || effort }
    return { model: settings.defaultModel ?? '', effort }
  }

  /**
   * One training turn in a thread of its own.
   *
   * The thread is closed whatever happens: none of these calls is a conversation, and a plan
   * generated an hour ago is no context for an explanation asked for now. A plain-text turn is
   * announced on `training:changed` before it starts, so the screen can subscribe to its
   * `streamId` in time, and a turn that never streamed gets one envelope with the whole answer —
   * the same contract the review turns follow.
   */
  private async runTurn(p: {
    text: string
    outputSchema?: object
    activity: { kind: TrainingActivity['kind']; ref: string | null }
  }): Promise<string> {
    const { model, effort } = this.resolveModel()
    if (!model) throw new TrainingError('TRAINING_NO_MODEL', 'no model is configured for the coach')
    const language = this.language()
    const streamId = randomUUID()

    const threadId = await this.deps.codex.startThread('training', {
      model,
      baseInstructions: trainingBaseInstructions(language)
    })
    this.changed({ kind: 'activity', activity: { ...p.activity, streamId, busy: true } })
    let streamed = false
    try {
      const result = await this.deps.codex.runTurn(
        {
          threadId,
          text: p.text,
          model,
          effort,
          ...(p.outputSchema ? { outputSchema: p.outputSchema } : {}),
          language,
          timeoutMs: this.deps.settings.get().turnTimeoutSec * 1000,
          streamId
        },
        (kind) => {
          if (kind === 'text') streamed = true
        }
      )
      if (!result.ok) throw new TrainingError('TRAINING_TURN_FAILED', result.message)
      const text = result.text.trim()
      if (!streamed && !p.outputSchema && text.length > 0) {
        this.deps.emit('stream', {
          streamId,
          threadId,
          turnId: result.turnId,
          itemId: '',
          kind: 'text',
          chunk: text
        })
      }
      return text
    } finally {
      this.changed({ kind: 'activity', activity: { ...p.activity, streamId: null, busy: false } })
      // The answer (or the failure) is already final at this point. Unsubscribing the ephemeral
      // thread is housekeeping and must not keep the renderer's IPC request busy when the Codex
      // transport is degraded: `thread/unsubscribe` has its own RPC timeout and used to leave the
      // training screen apparently stuck even after the turn itself had finished.
      void this.deps.codex.closeThread(threadId).catch(() => undefined)
    }
  }

  // ────────────────────────────────────────────────────── own-game exercises

  /**
   * Hook of the analysis pipeline, run after the profile has been updated (spec §6.4): the
   * mistakes of the game that has just been analysed become exercises.
   *
   * It is queued and never awaited by the caller — building one exercise means several deep
   * searches — and it never throws: a game without exercises is a normal game.
   */
  onGameAnalyzed(game: Game): Promise<void> {
    return this.enqueue(async () => {
      if (game.kind !== 'match' || !game.analysis) return
      if (!this.deps.engine.state().available) return
      const built: Exercise[] = []
      try {
        const candidates = extractCandidates(game)
          .sort((a, b) => b.lossCp - a.lossCp)
          .slice(0, MAX_EXERCISES_PER_GAME)
        for (const candidate of candidates) {
          // An exercise already built for this ply is never rebuilt: it may already be solved.
          if (this.deps.exercises.has(ownGameExerciseId(candidate.gameId, candidate.ply))) continue
          const exercise = await buildExercise(candidate, this.deps.engine, {
            now: () => this.now()
          })
          if (exercise) built.push(exercise)
        }
      } catch (error) {
        console.error('[training] the exercises of the game could not be built:', error)
      }
      if (built.length === 0) return
      await this.deps.exercises.putMany(built)
      this.changed({ kind: 'exercises' })
    })
  }

  /** Hook of `game:finished`: an endgame drill writes its result on its own record (spec §6.7). */
  onGameFinished(game: Game): Promise<void> {
    return this.enqueue(async () => {
      if (game.kind !== 'endgame_drill' || !game.result) return
      const record = this.deps.exercises
        .list('endgame')
        .find((exercise) => exercise.sourceGameId === game.id)
      if (!record) return
      const endgame = this.endgamePositions().find(
        (position) => endgameExerciseId(position.id) === record.id
      )
      if (!endgame) return

      const draw = game.result.outcome === '1/2-1/2'
      const userWon = !draw && (game.result.outcome === '1-0' ? 'w' : 'b') === game.userColor
      const solved = endgame.goal === 'win' ? userWon : draw || userWon
      await this.deps.exercises.update(record.id, {
        status: solved ? 'solved' : 'failed',
        ...(solved ? { solvedAt: this.stamp() } : {})
      })
      this.changed({ kind: 'exercises' })
    })
  }

  // ────────────────────────────────────────────────────────────── exercises

  list(kind?: ExerciseKind): Exercise[] {
    return this.deps.exercises.list(kind)
  }

  get(id: string): Exercise | null {
    return this.deps.exercises.get(id)
  }

  private require(id: string): Exercise {
    const exercise = this.deps.exercises.get(id)
    if (!exercise) throw new TrainingError('EXERCISE_NOT_FOUND', `no exercise ${id}`)
    return exercise
  }

  /**
   * One move played inside an exercise (spec §6.4). The position the exercise has reached lives
   * in memory: a restart simply starts the exercise again, and `reset` does the same on demand.
   */
  async attempt(id: string, uci: string): Promise<AttemptResult> {
    const exercise = this.require(id)
    if (exercise.kind === 'endgame')
      throw new TrainingError(
        'EXERCISE_NOT_PLAYABLE',
        'an endgame is played as a game, not as an exercise'
      )
    if (exercise.solution.length === 0)
      throw new TrainingError('EXERCISE_NOT_PLAYABLE', `exercise ${id} has no solution`)

    const current = this.progress.get(id) ?? startProgress(exercise)
    const { result, progress } = judgeAttempt(exercise, current, uci)
    if (result.done) this.progress.delete(id)
    else this.progress.set(id, progress)

    const patch: Partial<Exercise> = { attempts: exercise.attempts + 1 }
    if (result.correct && result.done) {
      patch.status = 'solved'
      patch.solvedAt = this.stamp()
    } else if (!result.correct && !result.done) {
      patch.status = 'failed'
    }
    await this.deps.exercises.update(id, patch)
    this.changed({ kind: 'exercises' })
    return result
  }

  /** Puts an exercise back to its starting position, forgetting the attempts made at it. */
  async reset(id: string): Promise<Exercise> {
    this.require(id)
    this.progress.delete(id)
    const updated = await this.deps.exercises.update(id, {
      status: 'new',
      attempts: 0,
      solvedAt: undefined
    })
    this.changed({ kind: 'exercises' })
    return updated ?? this.require(id)
  }

  /** "Spiega" (spec §6.4): the coach explains the solution; the text is kept on the record. */
  async explain(id: string): Promise<string> {
    const exercise = this.require(id)
    const playedSan = await this.playedSan(exercise)
    const text = await this.runTurn({
      text: explainExerciseText({
        exercise,
        solutionSan: sanLine(exercise.fen, exercise.solution),
        language: this.language(),
        ...(playedSan ? { playedSan } : {})
      }),
      activity: { kind: 'explain', ref: id }
    })
    if (text.length === 0)
      throw new TrainingError('TRAINING_EMPTY_ANSWER', 'the explanation came back empty')
    await this.deps.exercises.update(id, { explanation: text })
    this.changed({ kind: 'exercises' })
    return text
  }

  /** The move the user actually played, when the exercise comes from one of their games. */
  private async playedSan(exercise: Exercise): Promise<string | null> {
    if (exercise.kind !== 'own_game' || !exercise.sourceGameId || !exercise.sourcePly) return null
    const game = await this.deps.games.get(exercise.sourceGameId).catch(() => null)
    return game?.moves[exercise.sourcePly - 1]?.san ?? null
  }

  // ─────────────────────────────────────────────────────────── thematic sets

  /**
   * "Nuova serie" (spec §6.5): the coach picks a theme and a rating window from the profile, the
   * library draws ten puzzles that have not been solved yet.
   *
   * The coach is asked only when there is something to read — a level, some themes, some history.
   * Its answer failing, or drawing nothing at all, falls back to the rotation of spec §6.5: the
   * themes in taxonomy order and the default window.
   */
  async nextThematicSet(): Promise<ThematicSet> {
    const profile = this.deps.profile.get()
    const available = this.deps.library.themes()
    const availableThemes = available.map((entry) => entry.theme)
    const rotation = Math.floor(this.deps.exercises.list('thematic').length / THEMATIC_SET_SIZE)

    let pick: ThemePick | null = null
    if (this.hasProfileData(profile) && this.resolveModel().model) {
      try {
        const answer = await this.runTurn({
          text: themePickText({ profile, language: this.language(), available }),
          outputSchema: THEME_PICK_SCHEMA,
          activity: { kind: 'thematic', ref: null }
        })
        pick = sanitizeThemePick(parseObject(answer))
      } catch (error) {
        // Spec §6.5: without a usable answer the themes simply rotate.
        console.error('[training] the coach could not choose a theme:', error)
      }
    }
    const chosen = pick ?? rotationPick(rotation, availableThemes)

    let puzzles = this.drawPuzzles(chosen)
    let used = chosen
    if (puzzles.length === 0 && !chosen.fallback) {
      // The window the coach asked for is never widened (spec §6.5); the rotation answers instead.
      used = rotationPick(rotation, availableThemes)
      puzzles = this.drawPuzzles(used)
    }

    const stamp = this.stamp()
    const exercises: Exercise[] = []
    const fresh: Exercise[] = []
    for (const puzzle of puzzles) {
      const stored = this.deps.exercises.get(thematicExerciseId(puzzle.id))
      if (stored) {
        exercises.push(stored)
        continue
      }
      const exercise = puzzleToExercise(puzzle, used.theme, stamp)
      fresh.push(exercise)
      exercises.push(exercise)
    }
    if (fresh.length > 0) {
      await this.deps.exercises.putMany(fresh)
      this.changed({ kind: 'exercises' })
    }
    // A set always starts from the beginning: the ones played before are played again.
    for (const exercise of exercises) this.progress.delete(exercise.id)

    return {
      theme: used.theme,
      ratingMin: used.ratingMin,
      ratingMax: used.ratingMax,
      motivation: used.motivation,
      exercises,
      fallback: used.fallback
    }
  }

  private drawPuzzles(pick: ThemePick): ReturnType<TrainingLibrary['pick']> {
    const solved = this.deps.exercises.idsWithStatus('solved', 'thematic')
    const exclude = new Set([...solved].map((id) => id.replace(/^tac-/, '')))
    return this.deps.library.pick({
      theme: pick.theme,
      ratingMin: pick.ratingMin,
      ratingMax: pick.ratingMax,
      exclude,
      count: THEMATIC_SET_SIZE
    })
  }

  /** Whether the profile says anything at all: below this the coach has nothing to read. */
  private hasProfileData(profile: Profile): boolean {
    return profile.history.length > 0 || Object.keys(profile.themeStats).length > 0
  }

  // ────────────────────────────────────────────────────────────── openings

  /** The openings table with the recurring deviations (spec §6.6). */
  async openingsOverview(): Promise<OpeningOverviewEntry[]> {
    return buildOpeningsOverview(this.deps.profile.get(), await this.analysedGames())
  }

  /** "Mini-lezione" of one opening (spec §6.6). */
  async openingLesson(eco: string): Promise<string> {
    const entry = (await this.openingsOverview()).find((row) => row.eco === eco)
    if (!entry) throw new TrainingError('OPENING_NOT_FOUND', `no opening ${eco} in the profile`)
    const text = await this.runTurn({
      text: openingLessonText({ entry, language: this.language() }),
      activity: { kind: 'lesson', ref: eco }
    })
    if (text.length === 0)
      throw new TrainingError('TRAINING_EMPTY_ANSWER', 'the opening lesson came back empty')
    return text
  }

  /** The analysed matches of the archive, newest first; drills never enter here. */
  private async analysedGames(): Promise<Game[]> {
    const rows = this.deps.games
      .list({ kind: 'match', status: 'finished' })
      .filter((row) => Boolean(row.accuracy))
    const games: Game[] = []
    for (const row of rows) {
      const game = await this.deps.games.get(row.id).catch(() => null)
      if (game?.analysis) games.push(game)
    }
    return games
  }

  // ─────────────────────────────────────────────────────────────── endgames

  private endgamePositions(): EndgamePosition[] {
    return this.deps.library.endgames()
  }

  /** The curated endgames with the state of the user's attempts (spec §6.7). */
  endgames(): EndgameListEntry[] {
    return this.endgamePositions().map((position) => {
      const record = this.deps.exercises.get(endgameExerciseId(position.id))
      return {
        ...position,
        status: record?.status ?? 'new',
        attempts: record?.attempts ?? 0,
        gameId: record?.sourceGameId ?? null
      }
    })
  }

  /**
   * "Gioca" of an endgame (spec §6.7): a real game against the opponent at the maximum level,
   * started from the position, with the goal written on the record that follows it.
   */
  async startEndgame(id: string): Promise<SessionState> {
    const endgame = this.endgamePositions().find((position) => position.id === id)
    if (!endgame) throw new TrainingError('ENDGAME_NOT_FOUND', `no endgame ${id}`)
    const settings = this.deps.settings.get()
    if (!settings.defaultModel)
      throw new TrainingError('TRAINING_NO_MODEL', 'no model is configured')
    const coach = this.resolveModel()

    const state = await this.deps.startGame({
      // The user plays the side the position asks to move: the goal is theirs to reach.
      userColor: endgame.sideToMove,
      model: settings.defaultModel,
      effort: settings.defaultEffort ?? '',
      difficulty: { mode: 'fixed', level: 6 },
      coach,
      language: settings.language,
      showReasoning: settings.showReasoning,
      commentsVisible: true,
      clock: null,
      startFen: endgame.fen,
      kind: 'endgame_drill'
    })

    const recordId = endgameExerciseId(endgame.id)
    const previous = this.deps.exercises.get(recordId)
    await this.deps.exercises.put({
      id: recordId,
      kind: 'endgame',
      fen: endgame.fen,
      sideToMove: endgame.sideToMove,
      solution: [],
      theme: endgame.theme,
      status: 'new',
      attempts: (previous?.attempts ?? 0) + 1,
      ...(state.game ? { sourceGameId: state.game.id } : {}),
      createdAt: previous?.createdAt ?? this.stamp()
    })
    this.changed({ kind: 'exercises' })
    return state
  }

  // ────────────────────────────────────────────────────────────── study plan

  private catalogue(): StudyCatalogue {
    const profile = this.deps.profile.get()
    return buildCatalogue({
      exercises: this.deps.exercises.list(),
      openings: Object.keys(profile.openingStats),
      endgames: this.endgamePositions()
    })
  }

  /** The plan as the screen reads it, with the dangling references marked (spec §6.8). */
  plan(): StudyPlanView {
    return planView(this.deps.plans.get(), this.catalogue(), this.deps.profile.get().gamesSincePlan)
  }

  /**
   * "Genera il piano" (spec §6.8). The catalogue goes into the prompt and into the schema; what
   * comes back is validated against it, and a plan left with fewer than {@link PLAN_MIN_ITEMS}
   * usable items is asked for once more before the app settles for what it has.
   */
  async generatePlan(): Promise<StudyPlanView> {
    const catalogue = this.catalogue()
    let items = await this.requestPlan(catalogue)
    if (items.length < PLAN_MIN_ITEMS) {
      // Spec §6.8: one more try, and the richer of the two answers wins — asking again must
      // never leave the user with less than the first attempt already had.
      const second = await this.requestPlan(catalogue)
      if (second.length > items.length) items = second
    }
    if (items.length === 0)
      throw new TrainingError('PLAN_EMPTY', 'the study plan came back without a single usable item')

    const plan = await this.deps.plans.save({ generatedAt: this.stamp(), items })
    // Spec §6.8: the counter that proposes a new plan starts again from here.
    const profile = await this.deps.profile.update({ gamesSincePlan: 0 })
    this.deps.emit('profile:changed', profile)
    this.changed({ kind: 'plan' })
    return planView(plan, catalogue, 0)
  }

  private async requestPlan(
    catalogue: StudyCatalogue
  ): Promise<ReturnType<typeof validatePlanItems>> {
    const answer = await this.runTurn({
      text: planText({
        catalogue,
        profile: this.deps.profile.get(),
        language: this.language(),
        labels: this.catalogueLabels(catalogue)
      }),
      outputSchema: planSchema(catalogue),
      activity: { kind: 'lesson', ref: null }
    })
    return validatePlanItems(parseObject(answer), catalogue)
  }

  /** Human-readable names for the ids of the catalogue, so the plan can talk about them. */
  private catalogueLabels(catalogue: StudyCatalogue): Record<string, string> {
    const labels: Record<string, string> = {}
    const language = this.language()
    for (const endgame of this.endgamePositions()) {
      if (catalogue.endgames.includes(endgame.id)) labels[endgame.id] = endgame.name[language]
    }
    const openings = this.deps.profile.get().openingStats
    for (const eco of catalogue.openings) {
      const stat = openings[eco]
      if (stat) labels[eco] = stat.name
    }
    for (const id of catalogue.exercises) {
      const exercise = this.deps.exercises.get(id)
      if (exercise)
        labels[id] =
          `${exercise.theme}${exercise.sourcePly ? ` · ${language === 'it' ? 'semimossa' : 'ply'} ${exercise.sourcePly}` : ''}`
    }
    return labels
  }

  /** Ticks one item of the plan off, or back on (spec §6.8). */
  async markDone(itemId: string, done = true): Promise<StudyPlanView> {
    const plan = await this.deps.plans.markDone(itemId, done)
    if (!plan) throw new TrainingError('PLAN_NOT_FOUND', 'there is no study plan yet')
    this.changed({ kind: 'plan' })
    return planView(plan, this.catalogue(), this.deps.profile.get().gamesSincePlan)
  }
}
