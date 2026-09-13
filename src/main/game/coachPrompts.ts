import type { CoachLogEntry, Eval, Move, MoveClassification } from '@shared/types/game'
import { movetext } from './prompts'

/**
 * The coach's prompts (spec §4.2).
 *
 * The coach is a tutor, not a second opponent: it sees the position, the game so far and — when
 * Stockfish is available — the evaluations and the best lines of the position the move was played
 * from. It never sees the opponent thread, never learns what the opponent intends to play, and
 * uses no tools. With no engine it keeps working "senza oracolo": same texts, no numbers, an
 * explicit invitation to reason on the position alone.
 *
 * Every evaluation written into a prompt is already from White's point of view, so the model never
 * has to guess whose side a `+0.35` is on.
 */

/** Stockfish material handed to the coach for one call; `null` is the oracle-less mode. */
export interface EngineContext {
  /** Score of the position the move was played from, from White's point of view. */
  evalBefore: Eval | null
  /** Score of the position after the move, from White's point of view. */
  evalAfter: Eval | null
  /** Filled by the post-game pipeline (M3); in game the coach usually has no classification yet. */
  classification?: MoveClassification
  /** Best lines of the position the move was played from, best first. Moves are SAN. */
  bestLines: { san: string; pv: string[]; eval: Eval }[]
}

export const COLOR_NAME: Record<'it' | 'en', { w: string; b: string }> = {
  it: { w: 'il Bianco', b: 'il Nero' },
  en: { w: 'White', b: 'Black' }
}

export const CLASSIFICATION_NAME: Record<'it' | 'en', Record<MoveClassification, string>> = {
  it: {
    book: 'teoria',
    best: 'migliore',
    excellent: 'ottima',
    good: 'buona',
    inaccuracy: 'imprecisione',
    mistake: 'errore',
    blunder: 'errore grave'
  },
  en: {
    book: 'book',
    best: 'best',
    excellent: 'excellent',
    good: 'good',
    inaccuracy: 'inaccuracy',
    mistake: 'mistake',
    blunder: 'blunder'
  }
}

/** Pawns with a sign, or "matto in N": the notation a player reads on an evaluation bar. */
export function formatEval(value: Eval | null | undefined, language: 'it' | 'en'): string {
  if (!value) return language === 'it' ? 'non disponibile' : 'not available'
  if (typeof value.mate === 'number') {
    const side = value.mate >= 0 ? COLOR_NAME[language].w : COLOR_NAME[language].b
    const plies = Math.abs(value.mate)
    return language === 'it' ? `matto in ${plies} per ${side}` : `mate in ${plies} for ${side}`
  }
  if (typeof value.cp === 'number') {
    const pawns = value.cp / 100
    return `${pawns >= 0 ? '+' : ''}${pawns.toFixed(2)}`
  }
  return language === 'it' ? 'non disponibile' : 'not available'
}

/**
 * The block of Stockfish data shared by every coach call, or the oracle-less notice.
 * `evalAfter` is only written when the call is about a move that has already been played.
 */
export function engineBlock(engine: EngineContext | null, language: 'it' | 'en', opts: { withAfter: boolean }): string[] {
  const it = language === 'it'
  if (!engine) {
    return [
      it
        ? 'Non hai dati di Stockfish per questa posizione: ragiona senza oracolo e di’ chiaramente quando un giudizio è incerto.'
        : 'You have no Stockfish data for this position: reason without the oracle and say plainly when a judgement is uncertain.'
    ]
  }

  const lines: string[] = [
    it
      ? 'Dati di Stockfish (valutazioni dal punto di vista del Bianco, in pedoni):'
      : 'Stockfish data (evaluations from White’s point of view, in pawns):',
    `${it ? 'Valutazione prima' : 'Evaluation before'}: ${formatEval(engine.evalBefore, language)}`
  ]
  if (opts.withAfter) {
    lines.push(`${it ? 'Valutazione dopo' : 'Evaluation after'}: ${formatEval(engine.evalAfter, language)}`)
  }
  if (engine.classification) {
    lines.push(`${it ? 'Classificazione' : 'Classification'}: ${CLASSIFICATION_NAME[language][engine.classification]}`)
  }
  if (engine.bestLines.length > 0) {
    lines.push(it ? 'Migliori varianti dalla posizione di partenza:' : 'Best lines from the starting position:')
    for (const [index, line] of engine.bestLines.entries()) {
      const pv = line.pv.length > 0 ? line.pv.join(' ') : line.san
      lines.push(`${index + 1}. ${line.san} (${formatEval(line.eval, language)}) — ${pv}`)
    }
  }
  return lines
}

/** `FEN:` and `PGN:` lines, in the shape every prompt of the app uses. */
export function positionBlock(fen: string, pgn: string, language: 'it' | 'en'): string[] {
  const text = movetext(pgn)
  return [`FEN: ${fen}`, `PGN: ${text.length > 0 ? text : language === 'it' ? '(partita appena iniziata)' : '(game just started)'}`]
}

/**
 * `baseInstructions` of the coach thread: one per game, recreated on resume.
 * `userColor` is the colour of the person being taught, never the opponent's.
 */
export function coachBaseInstructions(p: { language: 'it' | 'en'; userColor: 'w' | 'b'; engineAvailable: boolean }): string {
  const { language } = p
  const lines: string[] = []

  if (language === 'it') {
    lines.push(
      `Sei l’allenatore di scacchi della persona che sta giocando questa partita con ${COLOR_NAME.it[p.userColor]}.`,
      'Il tuo tono è chiaro, concreto e mai condiscendente: spieghi il perché delle mosse in parole semplici, senza gergo inutile e senza complimenti di circostanza.',
      'Non sei l’avversario e non parli mai con lui: non conosci e non riveli il suo piano né le sue intenzioni, commenti soltanto ciò che è già successo sulla scacchiera.',
      'Non usi strumenti e non hai altre fonti: lavori soltanto su ciò che ricevi nel turno.',
      'Scrivi in italiano, in prosa, senza elenchi puntati e senza JSON, tranne quando ti viene chiesto esplicitamente un oggetto JSON.'
    )
    lines.push(
      p.engineAvailable
        ? 'Quando il turno contiene i dati di Stockfish (valutazioni e varianti migliori) usali come base del tuo giudizio e traducili in parole: non contraddirli e non inventarne altri.'
        : 'In questa partita lavori senza oracolo: non ricevi valutazioni né varianti di Stockfish, quindi ragiona sulla posizione con le tue forze e dichiara apertamente quando un giudizio è incerto.'
    )
  } else {
    lines.push(
      `You are the chess coach of the person playing this game with ${COLOR_NAME.en[p.userColor]}.`,
      'Your tone is clear, concrete and never condescending: you explain why a move works in plain words, with no needless jargon and no empty praise.',
      'You are not the opponent and you never talk to them: you neither know nor reveal their plan or their intentions, and you only comment on what has already happened on the board.',
      'You use no tools and have no other sources: you work only on what the turn gives you.',
      'Write in English, in prose, with no bullet lists and no JSON, except when an explicit JSON object is requested.'
    )
    lines.push(
      p.engineAvailable
        ? 'When the turn carries Stockfish data (evaluations and best lines) use it as the basis of your judgement and put it into words: never contradict it and never invent more of it.'
        : 'In this game you work without the engine oracle: you receive no Stockfish evaluation and no best line, so reason on the position with your own eyes and say openly when a judgement is uncertain.'
    )
  }
  return lines.join('\n')
}

/**
 * Text of a comment on the move that has just been played, by either side (spec §4.2).
 * Two to four sentences of plain text: the answer is streamed straight into the feed.
 */
export function commentText(p: {
  move: Move
  by: 'user' | 'ai'
  fen: string
  pgn: string
  engine: EngineContext | null
  language: 'it' | 'en'
}): string {
  const it = p.language === 'it'
  const who = it ? (p.by === 'user' ? 'dalla persona che alleni' : 'dal suo avversario') : p.by === 'user' ? 'by the person you coach' : 'by their opponent'
  const lines: string[] = [
    it ? `Commenta la mossa appena giocata ${who}.` : `Comment on the move just played ${who}.`,
    `${it ? 'Mossa' : 'Move'}: ${p.move.ply}. ${p.move.san} (${p.move.uci})`,
    ...positionBlock(p.fen, p.pgn, p.language),
    ...engineBlock(p.engine, p.language, { withAfter: true }),
    it
      ? 'Scrivi da due a quattro frasi di testo semplice: che cosa fa questa mossa, che cosa cambia nella posizione e che cosa conviene tenere d’occhio adesso. Niente elenchi, niente JSON, nessun accenno al piano dell’avversario.'
      : 'Write two to four sentences of plain text: what the move does, what it changes in the position and what to watch now. No lists, no JSON, no hint about the opponent’s plan.'
  ]
  return lines.join('\n')
}

/** Text of a free question asked from the Coach tab (spec §4.2, "Consiglio"). */
export function adviceText(p: { question: string; fen: string; pgn: string; engine: EngineContext | null; language: 'it' | 'en' }): string {
  const it = p.language === 'it'
  return [
    it ? 'La persona che alleni ti fa una domanda sulla partita in corso.' : 'The person you coach asks you a question about the game in progress.',
    `${it ? 'Domanda' : 'Question'}: ${p.question.trim()}`,
    ...positionBlock(p.fen, p.pgn, p.language),
    ...engineBlock(p.engine, p.language, { withAfter: false }),
    it
      ? 'Rispondi in due-quattro frasi di testo semplice, concrete e utili subito. Niente elenchi, niente JSON, e non rivelare il piano dell’avversario.'
      : 'Answer in two to four sentences of plain text, concrete and immediately useful. No lists, no JSON, and do not reveal the opponent’s plan.'
  ].join('\n')
}

/** Text of the "Suggerimento" button: one move plus one reason, as structured output. */
export function hintText(p: { fen: string; pgn: string; engine: EngineContext | null; language: 'it' | 'en' }): string {
  const it = p.language === 'it'
  return [
    it
      ? 'Suggerisci alla persona che alleni la mossa da giocare adesso in questa posizione.'
      : 'Suggest to the person you coach the move to play now in this position.',
    ...positionBlock(p.fen, p.pgn, p.language),
    ...engineBlock(p.engine, p.language, { withAfter: false }),
    it
      ? 'Rispondi soltanto con il JSON richiesto: "move" è la mossa in SAN, legale in questa posizione; "reason" è una frase breve che spiega perché. Non rivelare il piano dell’avversario.'
      : 'Answer with the requested JSON only: "move" is the move in SAN, legal in this position; "reason" is one short sentence explaining why. Do not reveal the opponent’s plan.'
  ].join('\n')
}

/**
 * Structured output of the hint. Strict-mode rules of spec §3.1: every property required, no
 * `additionalProperties`, no format keywords; the legality is checked locally.
 */
export const HINT_SCHEMA = {
  type: 'object',
  required: ['move', 'reason'],
  additionalProperties: false,
  properties: {
    move: { type: 'string' },
    reason: { type: 'string' }
  }
} as const

/** How many log entries the recap carries, and how much of each one. */
const RECAP_ENTRIES = 10
const RECAP_CHARS = 200

const RECAP_KIND: Record<'it' | 'en', Record<CoachLogEntry['kind'], string>> = {
  it: { question: 'domanda', answer: 'risposta', hint: 'suggerimento', comment: 'commento' },
  en: { question: 'question', answer: 'answer', hint: 'hint', comment: 'comment' }
}

/**
 * Compact recap of the coach log, prepended to the first turn of a thread recreated on resume
 * (spec §4.2). It is never a turn of its own: a recap must not cost the user a model call.
 */
export function resumeSummaryText(log: CoachLogEntry[], language: 'it' | 'en'): string {
  const it = language === 'it'
  const entries = log.slice(-RECAP_ENTRIES)
  if (entries.length === 0) {
    return it
      ? 'Questa partita riprende da un salvataggio: finora non ci siamo ancora detti nulla.'
      : 'This game resumes from a save: we have not said anything to each other yet.'
  }
  const lines = entries.map((entry) => {
    const text = entry.text.replace(/\s+/g, ' ').trim().slice(0, RECAP_CHARS)
    const move = entry.move ? ` (${entry.move})` : ''
    return `- ${it ? 'mossa' : 'ply'} ${entry.ply}${move} · ${RECAP_KIND[language][entry.kind]}: ${text}`
  })
  return [
    it
      ? 'Questa partita riprende da un salvataggio. Ecco in breve ciò che ci siamo detti finora:'
      : 'This game resumes from a save. Here is, in short, what we said to each other so far:',
    ...lines,
    it ? 'Tienine conto senza ripeterlo.' : 'Keep it in mind without repeating it.'
  ].join('\n')
}
