import type { Profile } from '@shared/types/profile'
import type { Language } from '@shared/types/settings'
import type { Exercise, OpeningOverviewEntry, StudyCatalogue } from '@shared/types/training'
import { THEMATIC_SET_SIZE } from '@shared/types/training'
import { THEMES } from '../profile/themes'

/**
 * Prompts of the training section (spec §6.5, §6.6, §6.8 and the explanations of §6.4).
 *
 * They all speak with the coach's voice but away from a live game: the user is not to move, and
 * every turn carries all of its own data. Three of them are structured — the theme of a set, the
 * items of a study plan — and two are plain text the renderer streams into a card.
 *
 * Strict-mode rules of §3.1 apply to every schema here: every property in `required`, no
 * `additionalProperties`, no cardinality keywords. Cardinalities are asked for in the text and
 * clamped on this side; the only constraint the schema itself carries is an `enum`, which is how
 * spec §6.5 pins the theme and spec §6.8 pins the references of the plan to a real catalogue.
 */

/** `baseInstructions` of a training thread: the coach reading a profile, not a position. */
export function trainingBaseInstructions(language: Language): string {
  if (language === 'it') {
    return [
      'Sei l’allenatore di scacchi della persona di cui stai leggendo i dati e per cui prepari gli allenamenti.',
      'Il tuo tono è chiaro, concreto e mai condiscendente: parti da ciò che i dati mostrano, senza complimenti di circostanza e senza gergo inutile.',
      'Non usi strumenti e non hai altre fonti: lavori soltanto su ciò che ricevi nel turno, e non inventi partite, mosse, esercizi o statistiche che non ti sono state date.',
      'Quando ti viene chiesto un oggetto JSON rispondi soltanto con quello, senza testo intorno e senza blocchi di codice.'
    ].join('\n')
  }
  return [
    'You are the chess coach of the person whose data you are reading and whose training you prepare.',
    'Your tone is clear, concrete and never condescending: you start from what the data shows, with no empty praise and no needless jargon.',
    'You use no tools and have no other sources: you work only on what the turn gives you, and you never invent games, moves, exercises or statistics you were not given.',
    'When a JSON object is requested, answer with that alone: no text around it and no code fences.'
  ].join('\n')
}

// ─────────────────────────────────────────────────────── thematic sets (§6.5)

/**
 * Structured output of the thematic choice (spec §6.5). `theme` is pinned with an `enum` to the
 * fixed taxonomy — the library has no bucket for anything else.
 */
export const THEME_PICK_SCHEMA = {
  type: 'object',
  required: ['theme', 'ratingMin', 'ratingMax', 'motivation'],
  additionalProperties: false,
  properties: {
    theme: { type: 'string', enum: [...THEMES] },
    ratingMin: { type: 'number' },
    ratingMax: { type: 'number' },
    motivation: { type: 'string' }
  }
} as const

/** How many rows of each aggregate a prompt shows: enough to judge, not a data dump. */
const TOP_THEMES = 6
const TOP_OPENINGS = 5
const RECENT_GAMES = 8

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

function levelLine(profile: Profile, language: Language): string {
  const it = language === 'it'
  if (profile.level.estimate <= 0 || profile.level.confidence <= 0)
    return it
      ? 'Livello stimato: non ancora disponibile; usa gli esercizi come diagnosi, senza presumere che la persona sia principiante.'
      : 'Estimated level: not available yet; use the exercises diagnostically without assuming the person is a beginner.'
  return `${it ? 'Livello stimato' : 'Estimated level'}: ${profile.level.estimate} (${BAND_NAME[language][profile.level.band]}), ${
    it ? 'confidenza' : 'confidence'
  } ${profile.level.confidence.toFixed(2)}`
}

export interface ThemePracticeSummary {
  theme: string
  attempted: number
  solved: number
  failed: number
  attempts: number
  averageRating: number | null
}

function themeLines(profile: Profile, language: Language): string[] {
  const it = language === 'it'
  const themes = Object.entries(profile.themeStats)
    .sort((a, b) => b[1].occurrences - a[1].occurrences || a[0].localeCompare(b[0]))
    .slice(0, TOP_THEMES)
  if (themes.length === 0)
    return [
      it
        ? 'Non ci sono ancora temi ricorrenti nei suoi errori.'
        : 'There are no recurring themes in their mistakes yet.'
    ]
  return [
    it
      ? 'Temi ricorrenti nei suoi errori (tema · occorrenze):'
      : 'Recurring themes in their mistakes (theme · occurrences):',
    ...themes.map(([theme, stat]) => `- ${theme} · ${stat.occurrences}`)
  ]
}

/**
 * "Nuova serie" (spec §6.5): the coach picks the theme and the rating window of the next ten
 * puzzles. The window is a suggestion — the library answers with fewer puzzles rather than
 * stepping outside it — and the motivation is shown to the user as the reason for the set.
 */
export function themePickText(p: {
  profile: Profile
  language: Language
  available: { theme: string; count: number }[]
  practice?: ThemePracticeSummary[]
  suggestedWindow?: { min: number; max: number; reason: string }
}): string {
  const it = p.language === 'it'
  const lines: string[] = [
    it
      ? `Scegli il tema e la fascia di rating dei prossimi ${THEMATIC_SET_SIZE} puzzle tattici per la persona che alleni.`
      : `Choose the theme and the rating window of the next ${THEMATIC_SET_SIZE} tactical puzzles for the person you coach.`,
    levelLine(p.profile, p.language),
    ...themeLines(p.profile, p.language)
  ]

  const available = p.available.filter((entry) => entry.count > 0)
  if (available.length > 0) {
    lines.push(
      it
        ? 'Temi disponibili nella libreria (tema · puzzle disponibili):'
        : 'Themes available in the library (theme · puzzles available):',
      ...available.map((entry) => `- ${entry.theme} · ${entry.count}`)
    )
  }

  if (p.practice && p.practice.length > 0) {
    lines.push(
      it
        ? 'Risultati degli esercizi già proposti (tema · esercizi provati · risolti · falliti · mosse provate · rating medio):'
        : 'Results from exercises already offered (theme · exercises attempted · solved · failed · move attempts · average rating):',
      ...p.practice.map(
        (row) =>
          `- ${row.theme} · ${row.attempted} · ${row.solved} · ${row.failed} · ${row.attempts} · ${row.averageRating ?? (it ? 'non noto' : 'unknown')}`
      )
    )
  }
  if (p.suggestedWindow) {
    lines.push(
      `${it ? 'Fascia diagnostica suggerita' : 'Suggested diagnostic window'}: ${p.suggestedWindow.min}–${p.suggestedWindow.max} (${p.suggestedWindow.reason})`
    )
  }

  lines.push(
    it
      ? `Rispondi soltanto con il JSON richiesto: "theme" è uno dei temi ammessi; dai priorità a errori ricorrenti e temi falliti, alternandoli quando serve; "ratingMin" e "ratingMax" delimitano una fascia di circa 400 punti compresa fra 400 e 2200. Parti dalla fascia diagnostica suggerita e cambiala solo se i risultati forniti lo giustificano. "motivation" cita il dato concreto che motiva la scelta.`
      : `Answer with the requested JSON only: "theme" is one of the allowed themes; prioritise recurring mistakes and failed themes while rotating when useful; "ratingMin" and "ratingMax" bound a window of about 400 points inside 400–2200. Start from the suggested diagnostic window and change it only when the supplied results justify that. "motivation" cites the concrete evidence behind the choice.`
  )
  return lines.join('\n')
}

// ───────────────────────────────────────────── explanation of an exercise (§6.4)

/**
 * "Spiega" of the exercise player (spec §6.4): plain text, streamed into a card. The word
 * *Spiega* opens the turn on purpose — it is what makes this a request for an explanation and
 * not for a comment on a game.
 */
export function explainExerciseText(p: {
  exercise: Exercise
  solutionSan: string[]
  language: Language
  playedSan?: string
  profile?: Profile
  engineLines?: string[]
}): string {
  const it = p.language === 'it'
  const colour =
    p.exercise.sideToMove === 'w' ? (it ? 'il Bianco' : 'White') : it ? 'il Nero' : 'Black'
  const lines: string[] = [
    it
      ? `Spiega la soluzione di questo esercizio: muove ${colour}.`
      : `Spiega — explain the solution of this exercise: ${colour} to move.`,
    `FEN: ${p.exercise.fen}`,
    `${it ? 'Tema' : 'Theme'}: ${p.exercise.theme}`
  ]
  if (typeof p.exercise.rating === 'number')
    lines.push(`${it ? 'Rating' : 'Rating'}: ${p.exercise.rating}`)
  if (p.solutionSan.length > 0)
    lines.push(`${it ? 'Soluzione' : 'Solution'}: ${p.solutionSan.join(' ')}`)
  if (p.playedSan)
    lines.push(`${it ? 'Mossa giocata in partita' : 'Move played in the game'}: ${p.playedSan}`)
  if (p.exercise.kind === 'own_game') {
    lines.push(
      it
        ? 'La posizione viene da una partita della persona che alleni.'
        : 'The position comes from a game of the person you coach.'
    )
  }
  if (p.profile) lines.push(levelLine(p.profile, p.language))
  lines.push(
    `${it ? 'Esperienza su questo esercizio' : 'Experience on this exercise'}: ${p.exercise.attempts} ${it ? 'tentativi' : 'attempts'} · ${p.exercise.status}`
  )
  if (p.engineLines && p.engineLines.length > 0) {
    lines.push(
      it
        ? 'Varianti Stockfish dalla posizione iniziale (valutazione per chi muove):'
        : 'Stockfish lines from the starting position (evaluation for the side to move):',
      ...p.engineLines.map((line) => `- ${line}`)
    )
  }
  lines.push(
    it
      ? 'Scrivi da quattro a sei frasi di testo semplice, adatte al livello indicato: spiega il meccanismo tattico o strategico, calcola la linea principale, confronta almeno un’alternativa se è fornita e chiudi con il segnale da riconoscere la prossima volta. Non inventare varianti oltre quelle date. Niente elenchi e niente JSON.'
      : 'Write four to six plain-text sentences suited to the stated level: explain the tactical or strategic mechanism, calculate the main line, compare at least one alternative when supplied, and finish with the signal to recognise next time. Do not invent variations beyond those supplied. No lists and no JSON.'
  )
  return lines.join('\n')
}

// ───────────────────────────────────────────────────── openings mini-lesson (§6.6)

/** "Mini-lezione" of an opening (spec §6.6): plain text built on the user's own numbers. */
export function openingLessonText(p: {
  entry: OpeningOverviewEntry
  language: Language
  profile?: Profile
  engineLines?: Record<string, string[]>
}): string {
  const it = p.language === 'it'
  const entry = p.entry
  const lines: string[] = [
    it
      ? `Spiega alla persona che alleni come stanno andando le sue partite con ${entry.eco} ${entry.name}.`
      : `Spiega — tell the person you coach how their games with ${entry.eco} ${entry.name} are going.`,
    `${it ? 'Partite' : 'Games'}: ${entry.games} · ${it ? 'punteggio' : 'score'} ${entry.score.toFixed(1)}% · ${
      it ? 'accuratezza nelle prime 10 semimosse' : 'accuracy over the first ten plies'
    } ${entry.avgAccuracyFirst10.toFixed(1)}%`
  ]
  if (entry.deviations.length > 0) {
    lines.push(
      it
        ? 'Deviazioni ricorrenti (mossa giocata · volte · mossa migliore · FEN):'
        : 'Recurring deviations (move played · times · best move · FEN):'
    )
    for (const deviation of entry.deviations) {
      lines.push(
        `- ${deviation.san} · ${deviation.count} · ${deviation.bestSan || (it ? 'non nota' : 'unknown')} · ${deviation.epd}`
      )
      const linesForPosition = p.engineLines?.[deviation.epd] ?? []
      if (linesForPosition.length > 0)
        lines.push(
          `${it ? '  Varianti Stockfish' : '  Stockfish lines'}: ${linesForPosition.join(' | ')}`
        )
    }
  } else {
    lines.push(
      it
        ? 'Non ci sono deviazioni ricorrenti registrate in questa apertura.'
        : 'No recurring deviation is on record for this opening.'
    )
  }
  if (p.profile) lines.push(levelLine(p.profile, p.language))
  lines.push(
    it
      ? 'Scrivi da cinque a sette frasi di testo semplice, adatte al livello indicato: collega le idee strategiche dell’apertura ai dati reali, analizza la deviazione più frequente con le varianti fornite e proponi una sola regola concreta per la prossima partita. Non inventare teoria o varianti mancanti. Niente elenchi e niente JSON.'
      : 'Write five to seven plain-text sentences suited to the stated level: connect the opening’s strategic ideas to the real data, analyse the most frequent deviation with the supplied lines, and give one concrete rule for the next game. Do not invent missing theory or variations. No lists and no JSON.'
  )
  return lines.join('\n')
}

// ───────────────────────────────────────────────────────────── study plan (§6.8)

/** Activity types a plan item may carry; `play` is the only one that needs no reference. */
export const PLAN_ACTIVITY_TYPES = ['thematic', 'own_game', 'opening', 'endgame', 'play'] as const

/**
 * Structured output of the plan (spec §6.8), built around the catalogue it was generated from:
 * `activity.ref` is pinned with an `enum` to the ids that really exist, plus `null` for `play`.
 * Everything is still validated on this side — an `enum` is a hint, not a guarantee.
 */
export function planSchema(catalogue: StudyCatalogue): object {
  const refs = [
    ...catalogue.themes,
    ...catalogue.exercises,
    ...catalogue.openings,
    ...catalogue.endgames
  ]
  return {
    type: 'object',
    required: ['items'],
    additionalProperties: false,
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'why', 'activity'],
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            why: { type: 'string' },
            activity: {
              type: 'object',
              required: ['type', 'ref'],
              additionalProperties: false,
              properties: {
                type: { type: 'string', enum: [...PLAN_ACTIVITY_TYPES] },
                ref: { type: ['string', 'null'], enum: [...refs, null] }
              }
            }
          }
        }
      }
    }
  }
}

/** How many items the plan is asked for (spec §6.8); the answer is clamped on this side. */
export const PLAN_MIN_ITEMS = 4
export const PLAN_MAX_ITEMS = 8

/**
 * "Genera il piano" (spec §6.8). The catalogue is written into the prompt line by line, one line
 * per activity type, with the ids separated by ` | `: the model has to choose inside it, and the
 * validation on this side drops whatever it invents anyway.
 */
export function planText(p: {
  catalogue: StudyCatalogue
  profile: Profile
  language: Language
  labels?: Record<string, string>
  practice?: ThemePracticeSummary[]
}): string {
  const it = p.language === 'it'
  const lines: string[] = [
    it
      ? `Prepara il piano di studio della persona che alleni: da ${PLAN_MIN_ITEMS} a ${PLAN_MAX_ITEMS} voci, ciascuna una cosa sola da fare.`
      : `Prepare the study plan of the person you coach: from ${PLAN_MIN_ITEMS} to ${PLAN_MAX_ITEMS} items, each one single thing to do.`,
    levelLine(p.profile, p.language),
    ...themeLines(p.profile, p.language)
  ]

  const recent = p.profile.history.slice(-RECENT_GAMES)
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
  }
  if (p.practice && p.practice.length > 0) {
    lines.push(
      it
        ? 'Risultati recenti degli esercizi (tema · esercizi provati · risolti · falliti · mosse provate):'
        : 'Recent exercise results (theme · exercises attempted · solved · failed · move attempts):',
      ...p.practice.map(
        (row) =>
          `- ${row.theme} · ${row.attempted} · ${row.solved} · ${row.failed} · ${row.attempts}`
      )
    )
  }

  const openings = Object.values(p.profile.openingStats)
    .sort((a, b) => b.games - a.games || a.eco.localeCompare(b.eco))
    .slice(0, TOP_OPENINGS)
  if (openings.length > 0) {
    lines.push(
      it
        ? 'Aperture giocate (codice, nome, partite, V/P/S):'
        : 'Openings played (code, name, games, W/D/L):'
    )
    for (const opening of openings)
      lines.push(
        `- ${opening.eco} ${opening.name} · ${opening.games} · ${opening.wins}/${opening.draws}/${opening.losses}`
      )
  }

  // The catalogue: one line per activity type, ids separated by " | ". Nothing outside it is a
  // valid reference, and a reference that is not in it is dropped when the answer comes back.
  lines.push(
    it
      ? 'Catalogo delle attività ammesse (usa esattamente questi ref):'
      : 'Catalogue of the allowed activities (use exactly these refs):'
  )
  lines.push(`- thematic: ${catalogueLine(p.catalogue.themes, p.language)}`)
  lines.push(`- own_game: ${catalogueLine(p.catalogue.exercises, p.language)}`)
  lines.push(`- opening: ${catalogueLine(p.catalogue.openings, p.language)}`)
  lines.push(`- endgame: ${catalogueLine(p.catalogue.endgames, p.language)}`)
  lines.push(`- play: ${it ? 'nessun ref, usa null' : 'no ref, use null'}`)
  if (p.labels && Object.keys(p.labels).length > 0) {
    lines.push(
      it
        ? 'Per orientarti, che cosa sono alcuni di quei ref:'
        : 'For your orientation, what some of those refs are:'
    )
    for (const [ref, label] of Object.entries(p.labels)) lines.push(`- ${ref}: ${label}`)
  }

  lines.push(
    it
      ? 'Rispondi soltanto con il JSON richiesto: costruisci una progressione dal bisogno più provato verso applicazione e verifica; dai priorità agli esercizi falliti o ai temi ricorrenti, senza presumere un livello quando la stima manca. Ogni voce ha un "title" breve, un "why" che cita un dato fornito e un "activity" con tipo e ref presi dal catalogo (ref null solo per "play"). Non ripetere ref e non inventare attività.'
      : 'Answer with the requested JSON only: build a progression from the strongest evidenced need toward application and verification; prioritise failed exercises or recurring themes without assuming a level when no estimate exists. Every item has a short "title", a "why" citing supplied evidence, and an "activity" whose type and ref come from the catalogue (a null ref only for "play"). Never repeat refs or invent activities.'
  )
  return lines.join('\n')
}

const catalogueLine = (ids: string[], language: Language): string =>
  ids.length > 0 ? ids.join(' | ') : language === 'it' ? 'nessuno disponibile' : 'none available'
