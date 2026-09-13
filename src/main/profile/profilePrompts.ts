import type { Language } from '@shared/types/settings'
import type { MoveClassification } from '@shared/types/game'
import type { Profile } from '@shared/types/profile'
import { CLASSIFICATION_NAME, COLOR_NAME } from '../game/coachPrompts'
import { THEMES } from './themes'

/**
 * Prompts of the profile (spec §6.1 and §6.3).
 *
 * Two calls, both structured: the labelling of the key moments of a game that has just been
 * analysed, and the qualitative assessment written from the aggregated numbers every three games.
 * Neither of them is about a position to play: they run in their own short-lived `training`
 * thread, opened with {@link profileBaseInstructions}.
 *
 * The taxonomy travels inside the text (spec §6.2): the schema below keeps `theme` a plain string
 * — strict mode forbids the cardinality keywords, and an `enum` of eighteen values buys nothing
 * that {@link normalizeTheme} does not already guarantee on this side.
 */

/** `baseInstructions` of the profile thread: the coach's voice, reading data instead of a board. */
export function profileBaseInstructions(language: Language): string {
  if (language === 'it') {
    return [
      'Sei l’allenatore di scacchi della persona di cui stai leggendo i dati.',
      'Il tuo tono è chiaro, concreto e mai condiscendente: parli di ciò che i numeri mostrano, senza complimenti di circostanza e senza gergo inutile.',
      'Non usi strumenti e non hai altre fonti: lavori soltanto su ciò che ricevi nel turno, e non inventi partite, mosse o statistiche che non ti sono state date.',
      'Quando ti viene chiesto un oggetto JSON rispondi soltanto con quello, senza testo intorno e senza blocchi di codice.'
    ].join('\n')
  }
  return [
    'You are the chess coach of the person whose data you are reading.',
    'Your tone is clear, concrete and never condescending: you talk about what the numbers show, with no empty praise and no needless jargon.',
    'You use no tools and have no other sources: you work only on what the turn gives you, and you never invent games, moves or statistics you were not given.',
    'When a JSON object is requested, answer with that alone: no text around it and no code fences.'
  ].join('\n')
}

/** One key moment as the labelling call sees it: the move played, the better one, the variation. */
export interface LabelMoment {
  ply: number
  san: string
  uci: string
  /** Position the move was played from. */
  fenBefore: string
  classification?: MoveClassification
  /** Engine's own move in SAN, and the line that follows it. */
  bestSan?: string
  bestLine?: string[]
  /** Winning chance thrown away by the move, in points. */
  winPercentLoss?: number
}

/**
 * Structured output of the labelling (spec §6.3). Strict-mode rules of §3.1: every property in
 * `required`, no `additionalProperties`, no cardinality keywords.
 */
export const LABELS_SCHEMA = {
  type: 'object',
  required: ['labels'],
  additionalProperties: false,
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        required: ['ply', 'theme', 'note'],
        additionalProperties: false,
        properties: {
          ply: { type: 'number' },
          theme: { type: 'string' },
          note: { type: 'string' }
        }
      }
    }
  }
} as const

/**
 * "Etichetta i momenti chiave" (spec §6.3): one call for the whole game, one label per moment.
 * Every moment is written on a line that starts with `- <ply>.` so the answer can be matched back
 * to the move even when the model renumbers things.
 */
export function labelsText(p: {
  moments: LabelMoment[]
  language: Language
  userColor: 'w' | 'b'
  opening?: { eco: string; name: string } | null
}): string {
  const it = p.language === 'it'
  const lines: string[] = [
    it
      ? `Etichetta i momenti chiave di una partita appena analizzata dal motore. Li ha giocati tutti la persona che alleni, che aveva ${COLOR_NAME.it[p.userColor]}.`
      : `Label the key moments of a game the engine has just analysed. They were all played by the person you coach, who had ${COLOR_NAME.en[p.userColor]}.`
  ]
  if (p.opening) lines.push(`${it ? 'Apertura' : 'Opening'}: ${p.opening.eco} ${p.opening.name}`)

  for (const moment of p.moments) {
    const parts: string[] = [`- ${moment.ply}. ${moment.san} (${moment.uci})`]
    if (moment.classification) parts.push(CLASSIFICATION_NAME[p.language][moment.classification])
    if (typeof moment.winPercentLoss === 'number') {
      parts.push(
        `${it ? 'probabilità di vittoria persa' : 'winning chance lost'}: ${moment.winPercentLoss.toFixed(1)}`
      )
    }
    if (moment.bestSan) {
      const line =
        moment.bestLine && moment.bestLine.length > 0 ? ` — ${moment.bestLine.join(' ')}` : ''
      parts.push(`${it ? 'migliore' : 'best'}: ${moment.bestSan}${line}`)
    }
    parts.push(`FEN: ${moment.fenBefore}`)
    lines.push(parts.join(' · '))
  }

  lines.push(
    it
      ? 'Etichette ammesse (usa esattamente una di queste stringhe):'
      : 'Allowed labels (use exactly one of these strings):',
    THEMES.join(', '),
    it
      ? 'Rispondi soltanto con il JSON richiesto: un elemento di "labels" per ogni momento elencato, con lo stesso "ply", il "theme" scelto fra le etichette ammesse e una "note" di una frase che spiega perché quel tema. Niente altri temi e niente momenti inventati.'
      : 'Answer with the requested JSON only: one entry of "labels" per listed moment, with the same "ply", the "theme" picked from the allowed labels and a one-sentence "note" saying why that theme. No other themes and no invented moments.'
  )
  return lines.join('\n')
}

/**
 * Structured output of the qualitative assessment (spec §6.1). Same strict-mode rules: the two
 * arrays are asked for in the text and clamped on this side.
 */
export const QUALITATIVE_SCHEMA = {
  type: 'object',
  required: ['strengths', 'weaknesses'],
  additionalProperties: false,
  properties: {
    strengths: { type: 'array', items: { type: 'string' } },
    weaknesses: { type: 'array', items: { type: 'string' } }
  }
} as const

/** How many rows of each aggregate the model is shown: enough to judge, not a data dump. */
const TOP_THEMES = 6
const TOP_OPENINGS = 5
const RECENT_GAMES = 10

const BAND_NAME: Record<Language, Record<Profile['level']['band'], string>> = {
  it: {
    beginner: 'principiante',
    novice: 'base',
    intermediate: 'intermedio',
    advanced: 'avanzato',
    expert: 'esperto'
  },
  en: {
    beginner: 'beginner',
    novice: 'novice',
    intermediate: 'intermediate',
    advanced: 'advanced',
    expert: 'expert'
  }
}

/** "Valutazione qualitativa" (spec §6.1): the aggregated profile in, strengths and weaknesses out. */
export function qualitativeText(p: { profile: Profile; language: Language }): string {
  const it = p.language === 'it'
  const profile = p.profile
  const lines: string[] = [
    it
      ? 'Valuta il gioco della persona che alleni a partire dai suoi dati aggregati.'
      : 'Assess the play of the person you coach from their aggregated data.',
    `${it ? 'Livello stimato' : 'Estimated level'}: ${profile.level.estimate} (${BAND_NAME[p.language][profile.level.band]}), ${
      it ? 'confidenza' : 'confidence'
    } ${profile.level.confidence.toFixed(2)}`
  ]

  const recent = profile.history.slice(-RECENT_GAMES)
  if (recent.length > 0) {
    lines.push(
      it
        ? `Ultime ${recent.length} partite analizzate (accuratezza · ACPL):`
        : `Last ${recent.length} analysed games (accuracy · ACPL):`
    )
    for (const entry of recent)
      lines.push(
        `- ${entry.date.slice(0, 10)}: ${entry.accuracy.toFixed(1)}% · ${Math.round(entry.acpl)}`
      )
  } else {
    lines.push(it ? 'Non ci sono ancora partite analizzate.' : 'There are no analysed games yet.')
  }

  const themes = Object.entries(profile.themeStats)
    .sort((a, b) => b[1].occurrences - a[1].occurrences || a[0].localeCompare(b[0]))
    .slice(0, TOP_THEMES)
  if (themes.length > 0) {
    lines.push(
      it
        ? 'Temi ricorrenti nei suoi errori (tema · occorrenze):'
        : 'Recurring themes in their mistakes (theme · occurrences):'
    )
    for (const [theme, stat] of themes) lines.push(`- ${theme} · ${stat.occurrences}`)
  }

  const openings = Object.values(profile.openingStats)
    .sort((a, b) => b.games - a.games || a.eco.localeCompare(b.eco))
    .slice(0, TOP_OPENINGS)
  if (openings.length > 0) {
    lines.push(
      it
        ? 'Aperture giocate (codice, nome, partite, V/P/S, accuratezza nelle prime 10 semimosse):'
        : 'Openings played (code, name, games, W/D/L, accuracy over the first ten plies):'
    )
    for (const opening of openings) {
      lines.push(
        `- ${opening.eco} ${opening.name} · ${opening.games} · ${opening.wins}/${opening.draws}/${opening.losses} · ${opening.avgAccuracyFirst10.toFixed(1)}%`
      )
    }
  }

  lines.push(
    it
      ? 'Rispondi soltanto con il JSON richiesto: "strengths" sono da due a quattro punti di forza, "weaknesses" da due a quattro punti deboli, ciascuno una frase breve e concreta, riferita ai dati qui sopra. Parla alla persona che alleni, senza compiacenza.'
      : 'Answer with the requested JSON only: "strengths" are two to four strengths, "weaknesses" two to four weaknesses, each one short, concrete sentence grounded in the data above. Speak to the person you coach, with no flattery.'
  )
  return lines.join('\n')
}
