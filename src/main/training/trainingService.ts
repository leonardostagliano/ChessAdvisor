import { randomUUID } from 'node:crypto'
import { Chess } from 'chess.js'
import { normalizeMove } from '@shared/chess/notation'
import type { StreamEnvelope } from '@shared/types/api'
import type { Analysis } from '@shared/types/engine'
import type { Game } from '@shared/types/game'
import type { Profile } from '@shared/types/profile'
import { DIFFICULTY_LEVELS, type NewGameOptions, type SessionState } from '@shared/types/session'
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
  type ThemePracticeSummary,
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
  /** Tests can keep model-driven automatic plan rebuilding off; production defaults to on. */
  autoPlan?: boolean
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

const RATING_FLOOR = 400
const RATING_CEILING = 2200
const RATING_SPAN = 400

function ratingWindow(center: number): { min: number; max: number } {
  let min = Math.round(center - RATING_SPAN / 2)
  let max = min + RATING_SPAN
  if (min < RATING_FLOOR) {
    min = RATING_FLOOR
    max = min + RATING_SPAN
  }
  if (max > RATING_CEILING) {
    max = RATING_CEILING
    min = max - RATING_SPAN
  }
  return { min, max }
}

export class TrainingService {
  /** Every write is read-modify-write on one file: they run one after the other, never together. */
  private queue: Promise<unknown> = Promise.resolve()
  /** How far each exercise has been played; it lives as long as the process, not the file. */
  private readonly progress = new Map<string, ExerciseProgress>()
  /** Set synchronously at deletion time, before queued engine work can commit its result. */
  private readonly deletedGameIds = new Set<string>()
  /** The newest plan-changing intent wins over slow coach generations. */
  private planGeneration = 0
  private autoPlanPending = false
  private autoPlanTask: Promise<void> | null = null

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

  /** Measured practice history, grouped by theme; untouched exercises add no evidence. */
  private practiceSummaries(): ThemePracticeSummary[] {
    const grouped = new Map<string, ThemePracticeSummary & { rated: number; ratingTotal: number }>()
    for (const exercise of this.deps.exercises.list('thematic')) {
      if (exercise.attempts <= 0 && exercise.status === 'new') continue
      const row = grouped.get(exercise.theme) ?? {
        theme: exercise.theme,
        attempted: 0,
        solved: 0,
        failed: 0,
        attempts: 0,
        averageRating: null,
        rated: 0,
        ratingTotal: 0
      }
      row.attempted += 1
      row.solved += exercise.status === 'solved' ? 1 : 0
      row.failed += exercise.status === 'failed' ? 1 : 0
      row.attempts += exercise.attempts
      if (typeof exercise.rating === 'number') {
        row.rated += 1
        row.ratingTotal += exercise.rating
      }
      grouped.set(exercise.theme, row)
    }
    return [...grouped.values()]
      .map(({ rated, ratingTotal, ...row }) => ({
        ...row,
        averageRating: rated > 0 ? Math.round(ratingTotal / rated) : null
      }))
      .sort(
        (a, b) => b.failed - a.failed || b.attempts - a.attempts || a.theme.localeCompare(b.theme)
      )
  }

  /** A cautious puzzle band: trusted games, then actual puzzle results, then habitual difficulty. */
  private suggestedRatingWindow(
    profile: Profile,
    practice: ThemePracticeSummary[]
  ): { min: number; max: number; reason: string } {
    const it = this.language() === 'it'
    const attempted = practice.reduce((sum, row) => sum + row.attempted, 0)
    const solved = practice.reduce((sum, row) => sum + row.solved, 0)
    const failed = practice.reduce((sum, row) => sum + row.failed, 0)
    const practiceAdjustment =
      attempted >= 3 ? (solved / attempted >= 0.75 ? 100 : failed / attempted >= 0.5 ? -100 : 0) : 0
    if (
      profile.level.estimate > 0 &&
      profile.level.confidence >= 0.35 &&
      profile.history.length >= 3
    ) {
      return {
        ...ratingWindow(profile.level.estimate + practiceAdjustment),
        reason: it
          ? `stima sostenuta da partite analizzate${practiceAdjustment === 0 ? '' : ' e progressi negli esercizi'}`
          : `estimate supported by analysed games${practiceAdjustment === 0 ? '' : ' and exercise progress'}`
      }
    }
    const rated = practice.filter((row) => row.averageRating !== null)
    if (rated.length > 0) {
      const center =
        rated.reduce((sum, row) => sum + row.averageRating! * row.attempted, 0) /
        Math.max(
          1,
          rated.reduce((sum, row) => sum + row.attempted, 0)
        )
      return {
        ...ratingWindow(center + practiceAdjustment),
        reason: it ? 'risultati degli esercizi già svolti' : 'results from completed exercises'
      }
    }
    const level = this.deps.settings.get().lastDifficulty.level
    const indicativeRating = DIFFICULTY_LEVELS[level].elo ?? 1800
    return {
      ...ratingWindow(indicativeRating),
      reason: it
        ? 'stima iniziale dalla difficoltà abituale'
        : 'initial estimate from usual difficulty'
    }
  }

  private fallbackTheme(
    rotation: number,
    available: readonly string[],
    profile: Profile,
    practice: ThemePracticeSummary[]
  ): string {
    const struggled = practice.find((row) => row.failed > 0 && available.includes(row.theme))
    if (struggled) return struggled.theme
    const recurring = Object.entries(profile.themeStats)
      .filter(([theme]) => available.includes(theme))
      .sort((a, b) => b[1].occurrences - a[1].occurrences)[0]?.[0]
    return recurring ?? rotationPick(rotation, available).theme
  }

  private fallbackPick(
    rotation: number,
    available: readonly string[],
    profile: Profile,
    practice: ThemePracticeSummary[],
    window: { min: number; max: number; reason: string }
  ): ThemePick {
    return {
      theme: this.fallbackTheme(rotation, available, profile, practice) as ThemePick['theme'],
      ratingMin: window.min,
      ratingMax: window.max,
      motivation:
        this.language() === 'it'
          ? `Criterio della serie: ${window.reason}.`
          : `Selection basis: ${window.reason}.`,
      fallback: true
    }
  }

  /** Keep the coach's theme, but do not let an unsupported rating guess override the evidence. */
  private alignPickWithEvidence(
    pick: ThemePick,
    window: { min: number; max: number; reason: string }
  ): ThemePick {
    const pickedCenter = (pick.ratingMin + pick.ratingMax) / 2
    const evidenceCenter = (window.min + window.max) / 2
    if (Math.abs(pickedCenter - evidenceCenter) <= 200) return pick
    return {
      ...pick,
      ratingMin: window.min,
      ratingMax: window.max,
      motivation:
        this.language() === 'it'
          ? `${pick.motivation || 'Tema scelto dal coach'} Fascia mantenuta: ${window.reason}.`
          : `${pick.motivation || 'Theme selected by the coach'} Rating band retained: ${window.reason}.`
    }
  }

  private async engineLines(fen: string, limit = 5): Promise<string[]> {
    if (!this.deps.engine.state().available) return []
    let analysis: Analysis
    try {
      analysis = await this.deps.engine.analyze(fen, 'coach')
    } catch {
      return []
    }
    return analysis.lines.slice(0, limit).flatMap((line, index) => {
      const san = sanLine(fen, line.pv)
      if (san.length === 0) return []
      const score =
        typeof line.scoreMate === 'number'
          ? `M${line.scoreMate}`
          : typeof line.scoreCp === 'number'
            ? `${line.scoreCp >= 0 ? '+' : ''}${(line.scoreCp / 100).toFixed(2)}`
            : '?'
      return [`${index + 1}. ${san.join(' ')} · ${score} · depth ${line.depth}`]
    })
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  private changed(payload: TrainingChanged): void {
    this.deps.emit('training:changed', payload)
  }

  /** An exercise mutation can change the validity and labels of the current plan too. */
  private materialChanged(): void {
    this.changed({ kind: 'exercises' })
    // Do not merely invalidate a coach answer: start (or join) the coalesced replacement so new
    // own-game exercises actually become part of the stored plan.
    void this.refreshAfterGame()
  }

  /** Rebuilds the plan from the profile's newly persisted history, openings and counters. */
  onProfileChanged(): Promise<void> {
    const plan = this.refreshAfterGame()
    const themes = this.refreshOwnGameThemes()
    return Promise.all([plan, themes]).then(() => undefined)
  }

  /**
   * Profile labels may arrive after the engine exercise was made. Keep the deterministic exercise
   * and its attempts, but replace only its fallback theme with the newly saved move label.
   */
  private async refreshOwnGameThemes(): Promise<void> {
    let changed = false
    for (const exercise of this.deps.exercises.list('own_game')) {
      if (!exercise.sourceGameId || !exercise.sourcePly) continue
      if (this.deletedGameIds.has(exercise.sourceGameId)) continue
      const game = await this.deps.games.get(exercise.sourceGameId).catch(() => null)
      const theme = game?.moves[exercise.sourcePly - 1]?.theme
      if (!theme || theme === exercise.theme) continue
      if (await this.deps.exercises.update(exercise.id, { theme })) changed = true
    }
    if (changed) this.materialChanged()
  }

  /**
   * Coalesces automatic rebuilds instead of spending one coach turn per overlapping analysis
   * event.  A missing coach leaves the current computed view intact and never blocks a game.
   */
  refreshAfterGame(): Promise<void> {
    this.requestPlanRefresh()
    this.changed({ kind: 'plan' })
    if (this.deps.autoPlan === false || !this.resolveModel().model) return Promise.resolve()
    this.autoPlanPending = true
    if (!this.autoPlanTask) {
      this.autoPlanTask = (async () => {
        while (this.autoPlanPending) {
          this.autoPlanPending = false
          await this.generatePlanFor(this.planGeneration).catch((error) =>
            console.error('[training] the automatic study plan could not be refreshed:', error)
          )
        }
      })().finally(() => {
        this.autoPlanTask = null
        // A refresh can arrive between the last loop check and this finalizer.
        if (this.autoPlanPending) void this.refreshAfterGame()
      })
    }
    return this.autoPlanTask
  }

  private requestPlanRefresh(): void {
    this.planGeneration += 1
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
      // The caller may hand us a drill-shaped stale snapshot while an archived match with the
      // same id still exists. The hook is only for the analysed match it was given.
      if (game.kind !== 'match' || !game.analysis) return
      const current = await this.activeAnalyzedGame(game.id)
      if (!current) return
      if (!this.deps.engine.state().available) {
        this.changed({ kind: 'plan' })
        return
      }
      const built: Exercise[] = []
      try {
        const candidates = extractCandidates(current)
          .sort((a, b) => b.lossCp - a.lossCp)
          .slice(0, MAX_EXERCISES_PER_GAME)
        for (const candidate of candidates) {
          if (this.deletedGameIds.has(current.id)) return
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
      // The game may have been deleted while Stockfish was thinking. Re-read it immediately
      // before the write; the deletion hook also closes the tiny gap with a synchronous tombstone.
      if (!(await this.activeAnalyzedGame(current.id))) return
      if (built.length > 0) {
        await this.deps.exercises.putMany(built)
        this.materialChanged()
      } else {
        // The analysis can enrich openings/profile even without a usable tactical candidate.
        this.changed({ kind: 'plan' })
      }
    })
  }

  /**
   * Removes derived exercises for an archive deletion and prevents an in-flight extraction from
   * restoring them. Call this before removing the game file.
   */
  invalidateGame(gameId: string): void {
    this.deletedGameIds.add(gameId)
    this.planGeneration += 1
  }

  /** Removes the derived records after a successful archive deletion. */
  onGameDeleted(gameId: string): Promise<void> {
    this.invalidateGame(gameId)
    return this.enqueue(async () => {
      const removed = await this.deps.exercises.deleteBySourceGameId(gameId, 'own_game')
      if (removed > 0) this.materialChanged()
      else void this.refreshAfterGame()
    })
  }

  /** Startup repair for older data and an interrupted game deletion. */
  reconcile(): Promise<number> {
    return this.enqueue(async () => {
      const gameIds = new Set(
        this.deps.exercises
          .list('own_game')
          .map((exercise) => exercise.sourceGameId)
          .filter((id): id is string => Boolean(id))
      )
      let removed = 0
      for (const gameId of gameIds) {
        if (await this.activeAnalyzedGame(gameId)) continue
        this.deletedGameIds.add(gameId)
        removed += await this.deps.exercises.deleteBySourceGameId(gameId, 'own_game')
      }
      if (removed > 0) this.materialChanged()
      return removed
    })
  }

  /** A persisted, non-retired analysed match is the only valid source of own-game material. */
  private async activeAnalyzedGame(gameId: string): Promise<Game | null> {
    if (this.deletedGameIds.has(gameId)) return null
    if (this.deps.profile.get().retiredGameIds.includes(gameId)) return null
    const current = await this.deps.games.get(gameId).catch(() => null)
    if (!current || current.kind !== 'match' || !current.analysis) return null
    return current
  }

  /** Hook of `game:finished`: an endgame drill writes its result on its own record (spec §6.7). */
  onGameFinished(game: Game): Promise<void> {
    // A match affects the plan context before analysis completes. The profile hook announces a
    // second refresh after its counters and opening data are durable.
    if (game.kind === 'match') {
      return this.refreshAfterGame()
    }
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
      this.materialChanged()
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
    this.materialChanged()
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
    this.materialChanged()
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
        profile: this.deps.profile.get(),
        engineLines: await this.engineLines(exercise.fen),
        ...(playedSan ? { playedSan } : {})
      }),
      activity: { kind: 'explain', ref: id }
    })
    if (text.length === 0)
      throw new TrainingError('TRAINING_EMPTY_ANSWER', 'the explanation came back empty')
    await this.deps.exercises.update(id, { explanation: text })
    this.materialChanged()
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
    const practice = this.practiceSummaries()
    const suggestedWindow = this.suggestedRatingWindow(profile, practice)
    const available = this.deps.library.themes()
    const availableThemes = available.map((entry) => entry.theme)
    const rotation = Math.floor(this.deps.exercises.list('thematic').length / THEMATIC_SET_SIZE)

    let pick: ThemePick | null = null
    if ((this.hasProfileData(profile) || practice.length > 0) && this.resolveModel().model) {
      try {
        const answer = await this.runTurn({
          text: themePickText({
            profile,
            language: this.language(),
            available,
            practice,
            suggestedWindow
          }),
          outputSchema: THEME_PICK_SCHEMA,
          activity: { kind: 'thematic', ref: null }
        })
        const parsed = sanitizeThemePick(parseObject(answer))
        pick = parsed ? this.alignPickWithEvidence(parsed, suggestedWindow) : null
      } catch (error) {
        // Spec §6.5: without a usable answer the themes simply rotate.
        console.error('[training] the coach could not choose a theme:', error)
      }
    }
    const fallback = this.fallbackPick(
      rotation,
      availableThemes,
      profile,
      practice,
      suggestedWindow
    )
    const chosen = pick ?? fallback

    let puzzles = this.drawPuzzles(chosen)
    let used = chosen
    if (puzzles.length === 0 && !chosen.fallback) {
      // Keep the evidence-based calibration when the model requested an empty slice.
      used = fallback
      puzzles = this.drawPuzzles(used)
    }
    if (puzzles.length === 0 && used.fallback) {
      for (const theme of availableThemes) {
        if (theme === used.theme) continue
        const candidate = { ...used, theme: theme as ThemePick['theme'] }
        const candidatePuzzles = this.drawPuzzles(candidate)
        if (candidatePuzzles.length === 0) continue
        used = candidate
        puzzles = candidatePuzzles
        break
      }
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
      this.materialChanged()
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
    const engineLines: Record<string, string[]> = {}
    for (const deviation of entry.deviations.slice(0, 2)) {
      const fen = `${deviation.epd} 0 1`
      engineLines[deviation.epd] = await this.engineLines(fen)
    }
    const text = await this.runTurn({
      text: openingLessonText({
        entry,
        language: this.language(),
        profile: this.deps.profile.get(),
        engineLines
      }),
      activity: { kind: 'lesson', ref: eco }
    })
    if (text.length === 0)
      throw new TrainingError('TRAINING_EMPTY_ANSWER', 'the opening lesson came back empty')
    return text
  }

  /** The analysed matches of the archive, newest first; drills never enter here. */
  private async analysedGames(): Promise<Game[]> {
    const retired = new Set(this.deps.profile.get().retiredGameIds)
    const rows = this.deps.games
      .list({ kind: 'match', status: 'finished' })
      .filter((row) => !retired.has(row.id) && Boolean(row.accuracy))
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
    this.materialChanged()
    return state
  }

  // ────────────────────────────────────────────────────────────── study plan

  private catalogue(): StudyCatalogue {
    const profile = this.deps.profile.get()
    return buildCatalogue({
      // A deletion is marked synchronously, while the physical cleanup waits behind a deep engine
      // search. Do not let that small interval leak a dead exercise into a new plan.
      exercises: this.deps.exercises
        .list()
        .filter(
          (exercise) => !exercise.sourceGameId || !this.deletedGameIds.has(exercise.sourceGameId)
        ),
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
    this.requestPlanRefresh()
    return this.generatePlanFor(this.planGeneration)
  }

  private async generatePlanFor(generation: number): Promise<StudyPlanView> {
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

    // A deletion or a newer manual/automatic request won while the coach was answering.  Do not
    // let this stale response overwrite it; revalidate once more against the live catalogue too.
    if (generation !== this.planGeneration) return this.plan()
    items = validatePlanItems({ items }, this.catalogue())
    if (items.length === 0) {
      if (generation !== this.planGeneration) return this.plan()
      throw new TrainingError('PLAN_EMPTY', 'the study plan no longer has usable activities')
    }
    const done = new Set(
      (this.deps.plans.get()?.items ?? [])
        .filter((item) => item.done)
        .map((item) => `${item.activity.type}:${item.activity.ref ?? ''}`)
    )
    items = items.map((item) => ({
      ...item,
      done: done.has(`${item.activity.type}:${item.activity.ref ?? ''}`)
    }))
    if (generation !== this.planGeneration) return this.plan()
    const plan = await this.deps.plans.save({ generatedAt: this.stamp(), items })
    if (generation !== this.planGeneration) return this.plan()
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
        labels: this.catalogueLabels(catalogue),
        practice: this.practiceSummaries()
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
      if (catalogue.endgames.includes(endgame.id)) {
        const record = this.deps.exercises.get(endgameExerciseId(endgame.id))
        labels[endgame.id] =
          `${endgame.name[language]} · ${language === 'it' ? 'obiettivo' : 'goal'} ${endgame.goal} · ${language === 'it' ? 'difficoltà' : 'difficulty'} ${endgame.difficulty} · ${record?.status ?? 'new'} · ${record?.attempts ?? 0} ${language === 'it' ? 'partite avviate' : 'games started'}`
      }
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
          `${exercise.theme}${exercise.sourcePly ? ` · ${language === 'it' ? 'semimossa' : 'ply'} ${exercise.sourcePly}` : ''} · ${exercise.status} · ${exercise.attempts} ${language === 'it' ? 'mosse provate' : 'move attempts'}${exercise.rating ? ` · rating ${exercise.rating}` : ''}`
    }
    return labels
  }

  /** Ticks one item of the plan off, or back on (spec §6.8). */
  async markDone(itemId: string, done = true): Promise<StudyPlanView> {
    // A deliberate tick is newer than any slow automatic coach response.
    this.requestPlanRefresh()
    const plan = await this.deps.plans.markDone(itemId, done)
    if (!plan) throw new TrainingError('PLAN_NOT_FOUND', 'there is no study plan yet')
    this.changed({ kind: 'plan' })
    return planView(plan, this.catalogue(), this.deps.profile.get().gamesSincePlan)
  }
}
