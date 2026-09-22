import { Chess } from 'chess.js'
import data from '../../../resources/data/rapid-calibration.json'
import { positionContext } from '@shared/chess/rapidFeatures'
import { DIFFICULTY_LEVELS, type OpponentDifficulty } from '@shared/types/session'

export const RAPID_QUANTILES = [0, 0.5, 0.75, 0.9, 0.95, 0.99, 1] as const
const MIN_POSITIONS = 40
const MIN_PLAYERS = 8

export interface RapidGroup {
  count: number
  lossCounts: number[]
}

export interface RapidProfile extends RapidGroup {
  elo: number
  phase: 'opening' | 'middlegame' | 'endgame' | 'all'
  players: number
  games: number
  quantilesCp: number[]
  inCheck?: RapidGroup
  hasCapture?: RapidGroup
}

export interface RapidOpening {
  epd: string
  elo: number
  count: number
  moves: { uci: string; count: number }[]
}

export interface RapidDataset {
  schemaVersion: number
  source: string
  timeClass: string
  profiles: RapidProfile[]
  openings: RapidOpening[]
}

export interface RapidEstimate {
  quantilesCp: number[]
  /** Weighted probabilities; never pretend interpolated counts were observed. */
  probabilities: number[]
  sources: { profile: RapidProfile; weight: number }[]
  phaseSpecific: boolean
}

export const RAPID_DATA = data as RapidDataset

function validCounts(group: RapidGroup): boolean {
  return (
    group !== null &&
    typeof group === 'object' &&
    Number.isInteger(group.count) &&
    group.count > 0 &&
    Array.isArray(group.lossCounts) &&
    group.lossCounts.length === 7 &&
    group.lossCounts.every((n) => Number.isInteger(n) && n >= 0) &&
    group.lossCounts.reduce((sum, n) => sum + n, 0) === group.count
  )
}

export function usableProfile(profile: RapidProfile): boolean {
  return (
    validCounts(profile) &&
    profile.count >= MIN_POSITIONS &&
    profile.players >= MIN_PLAYERS &&
    Number.isFinite(profile.elo) &&
    Array.isArray(profile.quantilesCp) &&
    profile.quantilesCp.length === RAPID_QUANTILES.length &&
    profile.quantilesCp.every(
      (n, i, values) => Number.isFinite(n) && n >= 0 && (i === 0 || n >= values[i - 1]!)
    )
  )
}

export function requestedRapidElo(difficulty: OpponentDifficulty): number | null {
  if (difficulty.mode === 'fixed') return DIFFICULTY_LEVELS[difficulty.level].elo
  const target = difficulty.targetElo ?? 1200
  return Number.isFinite(target) ? Math.max(500, Math.min(2400, target)) : 1200
}

/** Sparse phase cells fall back to the same rating's aggregate before using another rating. */
export function estimateRapidProfile(
  elo: number,
  phase: RapidProfile['phase'] = 'all',
  dataset: RapidDataset = RAPID_DATA
): RapidEstimate | null {
  if (
    !dataset ||
    dataset.schemaVersion !== 1 ||
    dataset.timeClass !== 'rapid' ||
    !Array.isArray(dataset.profiles) ||
    !Number.isFinite(elo)
  )
    return null
  const byElo = new Map<number, RapidProfile>()
  for (const profile of dataset.profiles) {
    if (!usableProfile(profile) || (profile.phase !== phase && profile.phase !== 'all')) continue
    if (!byElo.has(profile.elo) || profile.phase === phase) byElo.set(profile.elo, profile)
  }
  const profiles = [...byElo.values()].sort((a, b) => a.elo - b.elo)
  if (profiles.length === 0) return null
  const high = profiles.find((profile) => profile.elo >= elo) ?? profiles[profiles.length - 1]!
  const low = profiles.filter((profile) => profile.elo <= elo).at(-1) ?? profiles[0]!
  const portion = high.elo === low.elo ? 0 : (elo - low.elo) / (high.elo - low.elo)
  const sources =
    high.elo === low.elo
      ? [{ profile: low, weight: 1 }]
      : [
          { profile: low, weight: 1 - portion },
          { profile: high, weight: portion }
        ]
  // A missing distant cohort is not evidence for this target rating.
  if (sources.some((entry) => Math.abs(entry.profile.elo - elo) > 300)) return null
  if (sources.some((entry) => entry.profile.phase !== sources[0]!.profile.phase)) {
    // Comparing unlike phase populations would create an artificial rating trend.
    const aggregates = sources.map((entry) =>
      dataset.profiles.find(
        (profile) =>
          usableProfile(profile) && profile.elo === entry.profile.elo && profile.phase === 'all'
      )
    )
    if (aggregates.some((profile) => !profile)) return null
    sources.forEach((entry, index) => {
      entry.profile = aggregates[index]!
    })
  }
  return {
    quantilesCp: RAPID_QUANTILES.map((_, index) =>
      sources.reduce((sum, entry) => sum + entry.weight * entry.profile.quantilesCp[index]!, 0)
    ),
    probabilities: Array.from({ length: 7 }, (_, index) =>
      sources.reduce(
        (sum, entry) =>
          sum + (entry.weight * entry.profile.lossCounts[index]!) / entry.profile.count,
        0
      )
    ),
    sources,
    phaseSpecific: sources.every((entry) => entry.profile.phase === phase)
  }
}

/** Inverse empirical CDF with linear interpolation between the stored quantiles. */
export function rapidLossAt(quantiles: readonly number[], unit: number): number {
  const u = Math.max(0, Math.min(1, unit))
  for (let index = 1; index < RAPID_QUANTILES.length; index += 1) {
    if (u > RAPID_QUANTILES[index]!) continue
    const portion =
      (u - RAPID_QUANTILES[index - 1]!) / (RAPID_QUANTILES[index]! - RAPID_QUANTILES[index - 1]!)
    return quantiles[index - 1]! + portion * (quantiles[index]! - quantiles[index - 1]!)
  }
  return quantiles[quantiles.length - 1] ?? 0
}

export function rapidOpening(
  fen: string,
  elo: number,
  dataset: RapidDataset = RAPID_DATA
): RapidOpening | null {
  if (
    !dataset ||
    dataset.schemaVersion !== 1 ||
    dataset.timeClass !== 'rapid' ||
    !Array.isArray(dataset.openings)
  )
    return null
  const chess = new Chess(fen)
  if (Number(chess.fen().split(' ')[5]) > 10) return null
  const epd = chess.fen().split(' ').slice(0, 4).join(' ')
  const legal = new Set(
    chess.moves({ verbose: true }).map((m) => m.from + m.to + (m.promotion ?? ''))
  )
  const entry = dataset.openings
    .filter(
      (opening) =>
        opening &&
        opening.epd === epd &&
        opening.count >= 8 &&
        Array.isArray(opening.moves) &&
        Math.abs(opening.elo - elo) <= 300
    )
    .sort((a, b) => Math.abs(a.elo - elo) - Math.abs(b.elo - elo) || b.count - a.count)[0]
  if (!entry) return null
  const moves = entry.moves
    .filter(
      (move) =>
        move &&
        legal.has(move.uci) &&
        Number.isInteger(move.count) &&
        move.count > 0 &&
        move.count <= entry.count
    )
    .sort((a, b) => b.count - a.count || a.uci.localeCompare(b.uci))
  return moves.length ? { ...entry, moves } : null
}

/** Statistics are evidence for the persona, never an error quota or a legal-move whitelist. */
export function rapidContextText(
  difficulty: OpponentDifficulty,
  fen: string,
  language: 'it' | 'en',
  dataset: RapidDataset = RAPID_DATA
): string[] {
  const elo = requestedRapidElo(difficulty)
  if (elo === null) return []
  const context = positionContext(fen)
  const estimate = estimateRapidProfile(elo, context.phase, dataset)
  const opening = rapidOpening(fen, elo, dataset)
  if (!estimate && !opening) return []
  const it = language === 'it'
  const lines = [
    it
      ? 'Riferimento umano: campione sperimentale di partite Chess.com Rapid; non certifica un Elo.'
      : 'Human reference: an experimental sample of Chess.com Rapid games; it does not certify an Elo.'
  ]
  if (estimate) {
    const count = estimate.sources.reduce((sum, entry) => sum + entry.profile.count, 0)
    const bands = estimate.sources.map((entry) => entry.profile.elo).join('/')
    const phase = estimate.phaseSpecific ? context.phase : 'all'
    const nearBest = Math.round(100 * estimate.probabilities[0]!)
    const major = Math.round(100 * estimate.probabilities.slice(3).reduce((sum, n) => sum + n, 0))
    lines.push(
      it
        ? `Fasce osservate ${bands}; fase ${phase}; ${count} decisioni in posizioni entro ±600 cp e senza matto calcolato. Circa ${nearBest}% perde al massimo 20 cp; ${major}% perde oltre 150 cp.`
        : `Observed bands ${bands}; phase ${phase}; ${count} decisions in positions within ±600 cp and without a calculated mate. About ${nearBest}% loses at most 20 cp; ${major}% loses over 150 cp.`
    )
    const key = context.inCheck ? 'inCheck' : context.hasCapture ? 'hasCapture' : null
    if (
      key &&
      estimate.sources.every((entry) => {
        const group = entry.profile[key]
        return group && validCounts(group) && group.count >= MIN_POSITIONS
      })
    ) {
      const errorRate = estimate.sources.reduce((sum, entry) => {
        const group = entry.profile[key]!
        return (
          sum +
          (entry.weight * group.lossCounts.slice(3).reduce((n, count) => n + count, 0)) /
            group.count
        )
      }, 0)
      const label = context.inCheck
        ? it
          ? 'sotto scacco'
          : 'in check'
        : it
          ? 'con catture legali disponibili'
          : 'with legal captures available'
      lines.push(
        it
          ? `Nelle posizioni ${label}, circa ${Math.round(errorRate * 100)}% delle mosse osservate perde oltre 150 cp.`
          : `In positions ${label}, about ${Math.round(errorRate * 100)}% of observed moves lose over 150 cp.`
      )
    }
  }
  if (opening) {
    lines.push(
      it
        ? `Mosse osservate qui nella fascia ${opening.elo} (${opening.count} casi):`
        : `Moves observed here in band ${opening.elo} (${opening.count} cases):`
    )
    for (const move of opening.moves.slice(0, 6))
      lines.push(`${move.uci}: ${move.count}/${opening.count}`)
  }
  lines.push(
    it
      ? 'Le frequenze descrivono un gruppo, non una quota di errori da rispettare. Mantieni un piano coerente e le buone mosse che riconosci; non cercare una perdita di materiale. Le mosse assenti dall’archivio restano valide: puoi scegliere qualsiasi mossa legale.'
      : 'Frequencies describe a group, not an error quota. Keep a coherent plan and the good moves you recognise; do not seek material loss. Moves absent from the archive remain valid: you may choose any legal move.'
  )
  return lines
}
