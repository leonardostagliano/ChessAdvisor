import { randomUUID } from 'node:crypto'
import { Chess } from 'chess.js'
import { normalizeMove } from '@shared/chess/notation'
import type { Game, Move } from '@shared/types/game'
import type { OpeningStat, Profile, ProfileHistoryEntry } from '@shared/types/profile'
import type { Language } from '@shared/types/settings'
import { moveAccuracy } from '../analysis/accuracy'
import { START_FEN } from '../analysis/pipeline'
import type { SessionCodex } from '../game/gameSession'
import type { GameStore } from '../store/gameStore'
import type { ProfileStore } from '../store/profileStore'
import type { SettingsStore } from '../store/settingsStore'
import { estimateLevel, levelSample, LEVEL_WINDOW, type LevelSample } from './level'
import {
  LABELS_SCHEMA,
  QUALITATIVE_SCHEMA,
  labelsText,
  profileBaseInstructions,
  qualitativeText,
  type LabelMoment
} from './profilePrompts'
import { normalizeTheme, type Theme } from './themes'

/**
 * Owner of `profile.json` beyond the adaptive rating (spec §5, §6.1, §6.3).
 *
 * One entry point: a match that has just been analysed. From it the service asks the coach to
 * label the key moments with the fixed taxonomy, counts those themes, aggregates the opening, adds
 * the game to the history, re-estimates the level over the last ten matches and — every third
 * analysed match — has the coach rewrite the qualitative assessment. Everything else in the app
 * only reads the result: `profile.get()` and the `profile:changed` event.
 *
 * Nothing here may break the analysis that called it: a labelling turn that fails costs the game
 * its themes and nothing else, and the statistics are written all the same.
 */

/** Key moments labelled in one call (spec §6.3, same ceiling as the review's comments). */
export const MAX_LABELLED_MOMENTS = 8
/** Analysed matches between two qualitative assessments (spec §6.1). */
export const QUALITATIVE_EVERY = 3
/** Matches kept in `Profile.history`; the dashboard shows the last twenty (spec §6.9). */
export const HISTORY_LIMIT = 50
/** Strengths and weaknesses kept from one assessment, whatever the model answered. */
export const QUALITATIVE_ITEMS = 4
/** Plies of a best line written into a label prompt. */
const BEST_LINE_PLIES = 6
/** Plies of the opening the per-opening accuracy looks at (spec §6.6). */
const OPENING_PLIES = 10
/** Archive rows scanned to fill the level window before giving up. */
const LEVEL_SCAN = LEVEL_WINDOW * 3

/** Carries a machine-readable code through the IPC error contract (`serializeError`). */
export class ProfileError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ProfileError'
  }
}

export interface ProfileServiceDeps {
  codex: SessionCodex
  settings: SettingsStore
  profile: ProfileStore
  games: GameStore
  emit(channel: 'profile:changed', payload: Profile): void
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

/** UCI moves rendered in SAN from `fen`; an unplayable tail is simply dropped. */
function sanLine(fen: string, uci: string[]): string[] {
  let chess: Chess
  try {
    chess = new Chess(fen)
  } catch {
    return []
  }
  const san: string[] = []
  for (const move of uci.slice(0, BEST_LINE_PLIES)) {
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

function trimStrings(raw: unknown, limit: number): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, limit)
}

export class ProfileService {
  /** Every write is read-modify-write on one file: they run one after the other, never together. */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ProfileServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private stamp(): string {
    return new Date(this.now()).toISOString()
  }

  private language(): Language {
    return this.deps.settings.get().language
  }

  get(): Profile {
    return this.deps.profile.get()
  }

  /** Serialises the writers: the profile is one JSON file read, patched and written back. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work)
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * Coach model and effort (global constraint of the plan): the separate coach when the user asked
   * for one, then the game's own coach, then the default of Settings.
   */
  private resolveModel(game?: Game): { model: string; effort: string } {
    const settings = this.deps.settings.get()
    const fallbackEffort =
      settings.defaultEffort ?? game?.coach.effort ?? game?.opponent.effort ?? 'medium'
    if (settings.separateCoach && settings.coachModel) {
      return { model: settings.coachModel, effort: settings.coachEffort ?? fallbackEffort }
    }
    if (game && game.coach.model)
      return { model: game.coach.model, effort: game.coach.effort || fallbackEffort }
    if (settings.defaultModel) return { model: settings.defaultModel, effort: fallbackEffort }
    if (game) return { model: game.opponent.model, effort: game.opponent.effort }
    return { model: '', effort: fallbackEffort }
  }

  /**
   * One structured turn in a `training` thread of its own (spec §6.1/§6.3 are not a conversation:
   * every call carries all of its data). The thread is always closed, failure or not.
   */
  private async runTurn(p: {
    text: string
    outputSchema: object
    language: Language
    game?: Game
  }): Promise<Record<string, unknown> | null> {
    const { model, effort } = this.resolveModel(p.game)
    if (!model) throw new ProfileError('PROFILE_NO_MODEL', 'no model is configured for the coach')

    const threadId = await this.deps.codex.startThread('training', {
      model,
      baseInstructions: profileBaseInstructions(p.language),
      ...(p.game ? { gameId: p.game.id } : {})
    })
    try {
      const result = await this.deps.codex.runTurn({
        threadId,
        text: p.text,
        model,
        effort,
        outputSchema: p.outputSchema,
        language: p.language,
        timeoutMs: this.deps.settings.get().turnTimeoutSec * 1000,
        streamId: randomUUID()
      })
      if (!result.ok) throw new ProfileError('PROFILE_TURN_FAILED', result.message)
      return parseObject(result.text)
    } finally {
      await this.deps.codex.closeThread(threadId).catch(() => undefined)
    }
  }

  // ------------------------------------------------------------------ labelling

  /** Position a ply was played from. */
  private fenBefore(game: Game, ply: number): string {
    const previous = game.moves[ply - 2]
    return previous ? previous.fenAfter : (game.startFen ?? START_FEN)
  }

  private momentsOf(game: Game): { move: Move; moment: LabelMoment }[] {
    const plies = (game.analysis?.keyMoments ?? [])
      .filter((ply) => Boolean(game.moves[ply - 1]))
      .slice(0, MAX_LABELLED_MOMENTS)
    return plies.map((ply) => {
      const move = game.moves[ply - 1]!
      const fenBefore = this.fenBefore(game, ply)
      const evaluation = move.eval
      const line = evaluation
        ? sanLine(
            fenBefore,
            evaluation.bestLine.length > 0 ? evaluation.bestLine : [evaluation.bestMove]
          )
        : []
      const moment: LabelMoment = {
        ply,
        san: move.san,
        uci: move.uci,
        fenBefore,
        ...(evaluation
          ? { classification: evaluation.classification, winPercentLoss: evaluation.winPercentLoss }
          : {}),
        ...(line.length > 0 ? { bestSan: line[0]!, bestLine: line } : {})
      }
      return { move, moment }
    })
  }

  /**
   * The labelling call of spec §6.3: one turn for all the key moments, one theme per moment from
   * the fixed taxonomy. Anything the model invents lands on `missed_tactic`; a moment it forgot
   * keeps the same fallback, so every key moment always ends up with a theme.
   */
  private async labelKeyMoments(game: Game): Promise<Map<number, Theme>> {
    const moments = this.momentsOf(game)
    const labels = new Map<number, Theme>()
    if (moments.length === 0) return labels

    const language = this.language()
    const parsed = await this.runTurn({
      text: labelsText({
        moments: moments.map((entry) => entry.moment),
        language,
        userColor: game.userColor,
        opening: game.opening ?? null
      }),
      outputSchema: LABELS_SCHEMA,
      language,
      game
    })

    const known = new Set(moments.map((entry) => entry.moment.ply))
    const raw = parsed && Array.isArray(parsed.labels) ? parsed.labels : []
    for (const entry of raw) {
      if (typeof entry !== 'object' || entry === null) continue
      const record = entry as Record<string, unknown>
      const ply = typeof record.ply === 'number' ? Math.round(record.ply) : NaN
      if (!known.has(ply) || labels.has(ply)) continue
      labels.set(ply, normalizeTheme(record.theme))
    }
    // A moment the model skipped is still a mistake we know about: it keeps the fallback theme.
    for (const entry of moments)
      if (!labels.has(entry.moment.ply)) labels.set(entry.moment.ply, normalizeTheme(null))
    return labels
  }

  // ------------------------------------------------------------------ aggregates

  /** The user's accuracy over the first plies of the game, the number spec §6.6 keeps per opening. */
  private openingAccuracy(game: Game): number | null {
    const losses = game.moves
      .filter((move) => move.ply <= OPENING_PLIES && move.by === 'user' && move.eval)
      .map((move) => moveAccuracy(move.eval!.winPercentLoss))
    if (losses.length === 0) return null
    return losses.reduce((sum, value) => sum + value, 0) / losses.length
  }

  private mergeOpening(stats: Record<string, OpeningStat>, game: Game): void {
    const opening = game.opening
    if (!opening) return
    const key = opening.eco
    const current: OpeningStat = stats[key] ?? {
      eco: opening.eco,
      name: opening.name,
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      avgAccuracyFirst10: 0
    }
    const accuracy = this.openingAccuracy(game)
    // Running mean: the stored value is the mean over `games`, so one more game just re-weighs it.
    const merged: OpeningStat = {
      ...current,
      name: opening.name || current.name,
      games: current.games + 1,
      avgAccuracyFirst10:
        accuracy === null
          ? current.avgAccuracyFirst10
          : Math.round(
              ((current.avgAccuracyFirst10 * current.games + accuracy) / (current.games + 1)) * 10
            ) / 10
    }
    const result = game.result
    if (result) {
      if (result.outcome === '1/2-1/2') merged.draws += 1
      else if ((result.outcome === '1-0' ? 'w' : 'b') === game.userColor) merged.wins += 1
      else merged.losses += 1
    }
    stats[key] = merged
  }

  /** The last {@link LEVEL_WINDOW} analysed matches from the archive, oldest first (spec §6.1). */
  private async levelSamples(): Promise<LevelSample[]> {
    const rows = this.deps.games
      .list({ kind: 'match', status: 'finished' })
      .filter((row) => Boolean(row.accuracy))
      .slice(0, LEVEL_SCAN)
    const samples: LevelSample[] = []
    for (const row of rows) {
      if (samples.length >= LEVEL_WINDOW) break
      const game = await this.deps.games.get(row.id)
      if (!game) continue
      const sample = levelSample(game)
      if (sample) samples.push(sample)
    }
    return samples.reverse()
  }

  private mergeHistory(history: ProfileHistoryEntry[], game: Game): ProfileHistoryEntry[] {
    const analysis = game.analysis
    if (!analysis) return history
    const entry: ProfileHistoryEntry = {
      gameId: game.id,
      date: analysis.analyzedAt || this.stamp(),
      accuracy: analysis.accuracy[game.userColor],
      acpl: analysis.acpl[game.userColor]
    }
    const rest = history.filter((row) => row.gameId !== game.id)
    return [...rest, entry]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .slice(-HISTORY_LIMIT)
  }

  // ------------------------------------------------------------------ entry points

  /**
   * Hook of the analysis pipeline: the game has just been analysed and saved (spec §3.1).
   *
   * A game already in the history is a re-analysis: its history row is refreshed and the level is
   * re-estimated, but nothing is counted twice — not the themes, not the opening, not the games
   * since the last study plan.
   */
  onGameAnalyzed(game: Game): Promise<void> {
    return this.enqueue(async () => {
      if (game.kind !== 'match' || !game.analysis) return
      const before = this.deps.profile.get()
      const known = before.history.some((row) => row.gameId === game.id)

      let labels = new Map<number, Theme>()
      if (!known) {
        try {
          labels = await this.labelKeyMoments(game)
        } catch (error) {
          // The themes are a bonus on top of the analysis: the statistics are written anyway.
          console.error('[profile] the labelling of the key moments failed:', error)
        }
        if (labels.size > 0) {
          for (const [ply, theme] of labels) {
            const move = game.moves[ply - 1]
            if (move) move.theme = theme
          }
          await this.deps.games
            .save(game)
            .catch((error) =>
              console.error('[profile] the labelled game could not be saved:', error)
            )
        }
      }

      const themeStats = { ...before.themeStats }
      const stamp = this.stamp()
      for (const theme of labels.values()) {
        const current = themeStats[theme]
        themeStats[theme] = { occurrences: (current?.occurrences ?? 0) + 1, lastSeen: stamp }
      }

      const openingStats = { ...before.openingStats }
      if (!known) this.mergeOpening(openingStats, game)

      const history = this.mergeHistory(before.history, game)
      const level = estimateLevel(await this.levelSamples())

      const updated = await this.deps.profile.update({
        themeStats,
        openingStats,
        history,
        level: { ...level, updatedAt: stamp },
        gamesSincePlan: known ? before.gamesSincePlan : before.gamesSincePlan + 1
      })
      this.deps.emit('profile:changed', updated)

      // Spec §6.1: the qualitative assessment is rewritten every third analysed match.
      const analysed = this.analysedMatches()
      if (!known && analysed > 0 && analysed % QUALITATIVE_EVERY === 0) {
        await this.writeQualitative().catch((error) =>
          console.error('[profile] the qualitative assessment failed:', error)
        )
      }
    })
  }

  /** Analysed matches known to the archive: what spec §6.1 counts to every third game. */
  private analysedMatches(): number {
    return this.deps.games
      .list({ kind: 'match', status: 'finished' })
      .filter((row) => Boolean(row.accuracy)).length
  }

  /** The call itself; it assumes the queue is already held by the caller. */
  private async writeQualitative(): Promise<Profile> {
    const language = this.language()
    const parsed = await this.runTurn({
      text: qualitativeText({ profile: this.deps.profile.get(), language }),
      outputSchema: QUALITATIVE_SCHEMA,
      language
    })
    const strengths = trimStrings(parsed?.strengths, QUALITATIVE_ITEMS)
    const weaknesses = trimStrings(parsed?.weaknesses, QUALITATIVE_ITEMS)
    if (strengths.length === 0 && weaknesses.length === 0) {
      throw new ProfileError(
        'PROFILE_QUALITATIVE_EMPTY',
        'the qualitative assessment came back empty'
      )
    }
    const updated = await this.deps.profile.update({
      qualitative: { strengths, weaknesses, updatedAt: this.stamp() }
    })
    this.deps.emit('profile:changed', updated)
    return updated
  }

  /** "Aggiorna" of the Progressi dashboard (spec §6.9): the assessment on demand. */
  refreshQualitative(): Promise<Profile> {
    return this.enqueue(() => this.writeQualitative())
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandleFn = <T>(channel: string, fn: (...args: any[]) => Promise<T>) => void

export interface RegisterProfileIpcDeps {
  handle: HandleFn
  service: ProfileService
}

/** Binds the `profile` namespace of `window.api`. */
export function registerProfileIpc(deps: RegisterProfileIpcDeps): void {
  deps.handle('profile:get', async (): Promise<Profile> => deps.service.get())
  deps.handle('profile:refreshQualitative', async (): Promise<Profile> =>
    deps.service.refreshQualitative()
  )
}
