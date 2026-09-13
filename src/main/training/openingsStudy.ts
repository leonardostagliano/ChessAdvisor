import { epdOf, normalizeMove } from '@shared/chess/notation'
import type { Game, Move } from '@shared/types/game'
import type { Profile } from '@shared/types/profile'
import type { OpeningDeviation, OpeningOverviewEntry } from '@shared/types/training'
import { START_FEN } from '../analysis/pipeline'

/**
 * The openings section of the training screen (spec §6.6).
 *
 * The table itself is `Profile.openingStats`, written game by game by the profile service. What
 * is computed here is the part that only makes sense across games: the *recurring deviations* —
 * the first move of each game that the engine called an inaccuracy or worse inside the opening —
 * grouped by the position they were played from, so playing the same wrong move in the same
 * position three times shows up as one line with a count of three.
 */

/** Plies that still count as "the opening" (spec §6.6). */
export const MAX_DEVIATION_PLIES = 20
/** Deviations shown per opening: the recurring ones, not every mistake ever made. */
export const TOP_DEVIATIONS = 5

const DEVIATING: ReadonlySet<string> = new Set(['inaccuracy', 'mistake', 'blunder'])

/** Position a ply was played from. */
function fenBefore(game: Game, ply: number): string {
  const previous = game.moves[ply - 2]
  return previous ? previous.fenAfter : (game.startFen ?? START_FEN)
}

/** The first move of the game the user got wrong inside the opening, if there is one. */
export function firstDeviation(
  game: Game
): { epd: string; san: string; bestSan: string; ply: number } | null {
  const move: Move | undefined = game.moves.find(
    (entry) =>
      entry.ply <= MAX_DEVIATION_PLIES &&
      entry.by === 'user' &&
      entry.eval &&
      DEVIATING.has(entry.eval.classification)
  )
  if (!move || !move.eval) return null
  const fen = fenBefore(game, move.ply)
  const best = move.eval.bestMove ? normalizeMove(fen, move.eval.bestMove) : null
  return { epd: epdOf(fen), san: move.san, bestSan: best?.san ?? '', ply: move.ply }
}

/**
 * The openings overview (spec §6.6): one row per opening the profile knows, with the deviations
 * gathered from the games handed in. Rows are ordered by how often the opening was played.
 *
 * Games without an opening, or from an analysis that never ran, simply contribute nothing: the
 * statistics stay the profile's, and only the deviations are recomputed here.
 */
export function buildOpeningsOverview(profile: Profile, games: Game[]): OpeningOverviewEntry[] {
  const deviations = new Map<string, Map<string, OpeningDeviation>>()

  for (const game of games) {
    const eco = game.opening?.eco
    if (!eco) continue
    const deviation = firstDeviation(game)
    if (!deviation) continue
    const perOpening = deviations.get(eco) ?? new Map<string, OpeningDeviation>()
    // The grouping key is the position *and* the move: two different mistakes in the same
    // position are two lessons, not one.
    const key = `${deviation.epd}|${deviation.san}`
    const current = perOpening.get(key)
    if (current) current.count += 1
    else
      perOpening.set(key, {
        epd: deviation.epd,
        san: deviation.san,
        count: 1,
        bestSan: deviation.bestSan
      })
    deviations.set(eco, perOpening)
  }

  return Object.values(profile.openingStats)
    .map((stat) => {
      const rows = [...(deviations.get(stat.eco)?.values() ?? [])]
        .sort((a, b) => b.count - a.count || a.san.localeCompare(b.san))
        .slice(0, TOP_DEVIATIONS)
      return {
        eco: stat.eco,
        name: stat.name,
        games: stat.games,
        score:
          stat.games > 0 ? Math.round(((stat.wins + stat.draws / 2) / stat.games) * 1000) / 10 : 0,
        avgAccuracyFirst10: stat.avgAccuracyFirst10,
        deviations: rows
      }
    })
    .sort((a, b) => b.games - a.games || a.eco.localeCompare(b.eco))
}
