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
export type CoachEval = Eval & { mateWinner?: 'w' | 'b' }

export interface EngineContext {
  /** Score of the position the move was played from, from White's point of view. */
  evalBefore: CoachEval | null
  /** Score of the position after the move, from White's point of view. */
  evalAfter: CoachEval | null
  /** Filled by the post-game pipeline (M3); in game the coach usually has no classification yet. */
  classification?: MoveClassification
  /** Best lines of the position the move was played from, best first. Moves are SAN. */
  bestLines: { san: string; pv: string[]; eval: CoachEval; uciPv?: string[] }[]
  /** Concrete strongest continuation after the played move, never the private opponent plan. */
  replyLines?: { san: string; pv: string[]; eval: CoachEval; uciPv?: string[] }[]
  /** A checkmate FEN is authoritative when Stockfish reports mate in zero. */
  terminal?: { winner: 'w' | 'b'; at: 'before' | 'after' }
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
export function formatEval(value: CoachEval | null | undefined, language: 'it' | 'en'): string {
  if (!value) return language === 'it' ? 'non disponibile' : 'not available'
  if (typeof value.mate === 'number') {
    const winner = 'mateWinner' in value ? value.mateWinner : undefined
    const side = winner
      ? COLOR_NAME[language][winner]
      : value.mate >= 0
        ? COLOR_NAME[language].w
        : COLOR_NAME[language].b
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
export function engineBlock(
  engine: EngineContext | null,
  language: 'it' | 'en',
  opts: { withAfter: boolean; maxLines?: number; maxPlies?: number }
): string[] {
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
  if (engine.terminal) {
    lines.push(
      it
        ? 'Posizione terminale: scacco matto; ha vinto ' +
            COLOR_NAME.it[engine.terminal.winner] +
            '.'
        : 'Terminal position: checkmate; ' + COLOR_NAME.en[engine.terminal.winner] + ' won.'
    )
  }
  if (opts.withAfter) {
    lines.push(
      `${it ? 'Valutazione dopo' : 'Evaluation after'}: ${formatEval(engine.evalAfter, language)}`
    )
  }
  if (engine.classification) {
    lines.push(
      `${it ? 'Classificazione' : 'Classification'}: ${CLASSIFICATION_NAME[language][engine.classification]}`
    )
  }
  if (engine.bestLines.length > 0) {
    lines.push(
      it
        ? 'Migliori varianti dalla posizione di partenza:'
        : 'Best lines from the starting position:'
    )
    for (const [index, line] of engine.bestLines.slice(0, opts.maxLines).entries()) {
      const pv = line.pv.length > 0 ? line.pv.slice(0, opts.maxPlies).join(' ') : line.san
      lines.push(`${index + 1}. ${line.san} (${formatEval(line.eval, language)}) — ${pv}`)
    }
  }
  if (opts.withAfter && engine.replyLines?.length) {
    lines.push(
      it ? 'Risposta più forte dopo la mossa giocata:' : 'Strongest reply after the played move:'
    )
    for (const line of engine.replyLines.slice(0, opts.maxLines))
      lines.push(
        line.pv.slice(0, opts.maxPlies).join(' ') + ' (' + formatEval(line.eval, language) + ')'
      )
  }
  return lines
}

/** `FEN:` and `PGN:` lines, in the shape every prompt of the app uses. */
export function positionBlock(fen: string, pgn: string, language: 'it' | 'en'): string[] {
  const text = movetext(pgn)
  return [
    `FEN: ${fen}`,
    `PGN: ${text.length > 0 ? text : language === 'it' ? '(partita appena iniziata)' : '(game just started)'}`
  ]
}

/** The FEN carries the current position; automatic comments need only recent game context. */
function recentHistory(moves: Move[]): string {
  return moves
    .slice(-12)
    .map((move, index, recent) => {
      if (move.ply % 2 === 1) return `${(move.ply + 1) / 2}. ${move.san}`
      return recent[index - 1]?.ply === move.ply - 1 ? move.san : `${move.ply / 2}... ${move.san}`
    })
    .join(' ')
}

/**
 * `baseInstructions` of the coach thread: one per game, recreated on resume.
 * `userColor` is the colour of the person being taught, never the opponent's.
 */
export function coachBaseInstructions(p: {
  language: 'it' | 'en'
  userColor: 'w' | 'b'
  engineAvailable: boolean
}): string {
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
        : 'Il motore non è disponibile per nuove ricerche. Se il turno contiene valutazioni già registrate, usale come base; altrimenti lavori senza oracolo e devi dichiarare apertamente quando un giudizio è incerto.'
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
        : 'The engine is unavailable for new searches. If the turn provides recorded evaluations, use them as evidence; otherwise work without the engine oracle and say openly when a judgement is uncertain.'
    )
  }
  return lines.join('\n')
}

/**
 * Text of a comment on the move that has just been played, by either side (spec §4.2).
 * The comment is one structured card. Its text fields can still be saved as legacy prose.
 */
export function commentText(p: {
  move: Move
  by: 'user' | 'ai'
  fen: string
  pgn: string
  /** Canonical move list through the commented ply; bounds prompt growth in long games. */
  history?: Move[]
  engine: EngineContext | null
  language: 'it' | 'en'
}): string {
  const it = p.language === 'it'
  const who = it
    ? p.by === 'user'
      ? 'dalla persona che alleni'
      : 'dal suo avversario'
    : p.by === 'user'
      ? 'by the person you coach'
      : 'by their opponent'
  const lines: string[] = [
    it ? `Commenta la mossa appena giocata ${who}.` : `Comment on the move just played ${who}.`,
    `${it ? 'Mossa' : 'Move'}: ${p.move.ply}. ${p.move.san} (${p.move.uci})`,
    ...positionBlock(p.fen, p.history ? recentHistory(p.history) : p.pgn, p.language),
    ...engineBlock(p.engine, p.language, { withAfter: true, maxLines: 3, maxPlies: 6 }),
    p.engine?.replyLines?.length
      ? it
        ? 'La domanda deve invitare a trovare la prossima risposta legale mostrata nella variante dopo la mossa; gli indizi guidano a cercarla senza nominare la mossa.'
        : 'The question should invite finding the next legal reply shown in the line after the move; clues guide the search without naming the move.'
      : p.engine?.bestLines.length
        ? it
          ? 'La domanda deve invitare a trovare la prima mossa della variante migliore dalla posizione precedente; gli indizi non devono nominarla.'
          : 'The question should invite finding the first move of the best line from the previous position; clues must not name it.'
        : it
          ? 'Senza una variante calcolata, poni una domanda riflessiva senza suggerire una mossa forzata.'
          : 'Without a calculated line, ask a reflective question without implying a forced move.',
    it
      ? 'Usa la classificazione fornita anche per il giudizio scritto: è la stessa mostrata nel badge. Spiega una causa concreta e ciò che cambia; evita consigli generici come sviluppare i pezzi o arroccare se non sono il punto della mossa. Cita alternative e risposte soltanto se compaiono nelle varianti fornite; non attribuire intenzioni private all’avversario. Se i dati sono rapidi o incompleti, segnala l’incertezza.'
      : 'Use the supplied classification for the written judgement too: it is the badge judgement. Explain a concrete cause and what changes; avoid generic develop-pieces or castle advice unless it is the point of this move. Mention alternatives and replies only when they appear in supplied lines; never claim to know the opponent’s private intentions. Acknowledge fast or incomplete analysis.',
    it
      ? 'Rispondi con il solo oggetto JSON richiesto, con circa 80 parole in totale e senza ripetere la stessa idea nei campi. headline: massimo otto parole; explanation: due frasi causali brevi; priority: breve cosa osservare ora, oppure stringa vuota; question: una domanda per far ragionare la persona, oppure stringa vuota; hints: da zero a due indizi progressivi che non rivelano la soluzione; takeaway: una frase trasferibile breve, oppure stringa vuota. annotations: una o due case occupate e pertinenti nel FEN dopo la mossa, fino a quattro se servono. Usa focus per una casa importante e threat solo per un pezzo che attacca davvero un altro pezzo, con from casa dell’attaccante e square casa del bersaglio. Non inventare valutazioni o varianti nel JSON.'
      : 'Return only the requested JSON object, about 80 words total, without repeating the same idea across fields. headline: at most eight words; explanation: two short causal sentences; priority: brief point to watch now, or empty string; question: one question to invite thought, or empty string; hints: zero to two progressive clues that do not reveal the solution; takeaway: one short transferable sentence, or empty string. annotations: one or two relevant occupied squares in the FEN after the move, up to four when needed. Use focus for an important square and threat only for a piece actually attacking another piece, with from the attacker square and square the target square. Do not invent evaluations or variations in the JSON.'
  ]
  return lines.join('\n')
}

/** Strict output shape for one model call; engine evidence is attached separately. */
export const COMMENT_SCHEMA = {
  type: 'object',
  required: [
    'version',
    'headline',
    'explanation',
    'priority',
    'question',
    'hints',
    'takeaway',
    'annotations'
  ],
  additionalProperties: false,
  properties: {
    version: { type: 'integer', enum: [1] },
    headline: { type: 'string' },
    explanation: { type: 'string' },
    priority: { type: 'string' },
    question: { type: 'string' },
    hints: { type: 'array', items: { type: 'string' } },
    takeaway: { type: 'string' },
    annotations: {
      type: 'array',
      items: {
        type: 'object',
        required: ['square', 'label', 'kind', 'from'],
        additionalProperties: false,
        properties: {
          square: { type: 'string' },
          label: { type: 'string' },
          kind: { type: 'string', enum: ['focus', 'threat'] },
          from: { type: ['string', 'null'] }
        }
      }
    }
  }
} as const

/** Text of a free question asked from the Coach tab (spec §4.2, "Consiglio"). */
export function adviceText(p: {
  question: string
  userColor: 'w' | 'b'
  fen: string
  pgn: string
  engine: EngineContext | null
  language: 'it' | 'en'
}): string {
  const it = p.language === 'it'
  return [
    it
      ? 'La persona che alleni ti fa una domanda sulla partita in corso.'
      : 'The person you coach asks you a question about the game in progress.',
    `${it ? 'Domanda' : 'Question'}: ${p.question.trim()}`,
    ...positionBlock(p.fen, p.pgn, p.language),
    `${it ? 'Colore della persona' : 'Coached player color'}: ${COLOR_NAME[p.language][p.userColor]}`,
    ...engineBlock(p.engine, p.language, { withAfter: false }),
    p.engine?.bestLines.length
      ? it
        ? 'La domanda nella card invita a trovare la prima mossa della variante migliore; gli indizi non la nominano.'
        : 'The card question invites finding the first move of the best line; clues do not name it.'
      : it
        ? 'Senza varianti calcolate, poni una domanda riflessiva e non inventare una soluzione forzata.'
        : 'Without calculated lines, ask a reflective question and do not invent a forced solution.',
    it
      ? 'Confronta i candidati e la risposta più forte che compare nella variante prima di consigliare una mossa. Dai un’azione concreta, breve e adatta alla posizione; se le linee non bastano, dichiara l’incertezza invece di inventare continuazioni.'
      : 'Compare the candidate moves and the strongest reply shown in each line before recommending a move. Give one concise, concrete action for this position; when the lines are insufficient, state the uncertainty instead of inventing continuations.',
    it
      ? 'Rispondi soltanto con il JSON richiesto. "answer" contiene due-quattro frasi concrete; "move" è una mossa SAN legale solo se consigli esplicitamente di giocarla adesso, altrimenti null. "card" segue la struttura richiesta per il commento: una spiegazione causale, una domanda e fino a due indizi che non rivelano la soluzione, fino a quattro annotazioni su case occupate nel FEN corrente. Evita consigli generici e non inventare varianti o valutazioni. Non rivelare il piano dell’avversario.'
      : 'Return only the requested JSON. "answer" has two to four concrete sentences; "move" is a legal SAN move only if you explicitly recommend playing it now, otherwise null. "card" follows the requested comment structure: a causal explanation, a question and up to two clues that do not reveal the solution, up to four annotations on occupied squares in the current FEN. Avoid generic advice and invented lines or evaluations. Never reveal the opponent’s plan.'
  ].join('\n')
}

/**
 * Structured output of free-form advice. The move stays nullable because many useful answers
 * explain a position without recommending a move; any non-null move is still checked locally.
 */
export const ADVICE_SCHEMA = {
  type: 'object',
  required: ['answer', 'move', 'card'],
  additionalProperties: false,
  properties: {
    answer: { type: 'string' },
    move: { type: ['string', 'null'] },
    card: COMMENT_SCHEMA
  }
} as const

/** Text of the "Suggerimento" button: one move plus one reason, as structured output. */
export function hintText(p: {
  fen: string
  pgn: string
  engine: EngineContext | null
  language: 'it' | 'en'
}): string {
  const it = p.language === 'it'
  return [
    it
      ? 'Suggerisci alla persona che alleni la mossa da giocare adesso in questa posizione.'
      : 'Suggest to the person you coach the move to play now in this position.',
    ...positionBlock(p.fen, p.pgn, p.language),
    ...engineBlock(p.engine, p.language, { withAfter: false }),
    p.engine?.bestLines.length
      ? it
        ? 'La domanda nella card invita a trovare la prima mossa della variante migliore, senza nominarla nella domanda o negli indizi.'
        : 'The card question invites finding the first move of the best line without naming it in the question or clues.'
      : it
        ? 'Senza varianti calcolate, poni una domanda riflessiva senza suggerire una soluzione forzata.'
        : 'Without calculated lines, ask a reflective question without implying a forced solution.',
    it
      ? 'Scegli il candidato che regge meglio alla risposta avversaria mostrata nella variante. Mantieni il motivo concreto e breve; se Stockfish non chiarisce la posizione, segnala l’incertezza senza inventare varianti.'
      : 'Choose the candidate that holds up best against the opponent reply shown in its line. Keep the reason concrete and brief; if Stockfish does not settle the position, state the uncertainty without inventing variations.',
    it
      ? 'Rispondi soltanto con il JSON richiesto: "move" è una mossa SAN legale, "reason" ne spiega brevemente il perché; "card" segue la struttura del commento con una domanda e indizi progressivi che non rivelano la mossa. Le annotazioni indicano solo case occupate nel FEN corrente. Non inventare linee o valutazioni.'
      : 'Return only the requested JSON: "move" is a legal SAN move, "reason" briefly explains why; "card" follows the comment structure with a question and progressive clues that do not reveal the move. Annotate only occupied squares in the current FEN. Do not invent lines or evaluations.'
  ].join('\n')
}

/**
 * Structured output of the hint. Strict-mode rules of spec §3.1: every property required, no
 * `additionalProperties`, no format keywords; the legality is checked locally.
 */
export const HINT_SCHEMA = {
  type: 'object',
  required: ['move', 'reason', 'card'],
  additionalProperties: false,
  properties: {
    move: { type: 'string' },
    reason: { type: 'string' },
    card: COMMENT_SCHEMA
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
