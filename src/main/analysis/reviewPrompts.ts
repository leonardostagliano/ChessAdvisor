import type { Game, Move } from '@shared/types/game'
import { CLASSIFICATION_NAME, COLOR_NAME, engineBlock, formatEval, positionBlock, type EngineContext } from '../game/coachPrompts'

/**
 * Prompts of the post-game review (spec §4.4).
 *
 * They are the coach's own voice — the thread is opened with {@link coachBaseInstructions} — but
 * they speak about a game that is over: the outcome is known, the analysis is already on the
 * table, and nothing has to be kept secret any more. Everything the model needs is written into
 * the turn: the position, the movetext up to the move, the engine's verdict and, when the
 * pipeline has run, the classification and the best line of that very ply.
 */

export interface ReviewMoveContext {
  move: Move
  /** Position the move was played from, and the one it reached. */
  fenBefore: string
  fenAfter: string
  /** Movetext up to and including the move. */
  pgn: string
  /** Stockfish material; `null` is the oracle-less mode of spec §4.2. */
  engine: EngineContext | null
  language: 'it' | 'en'
  userColor: 'w' | 'b'
}

const moveHeader = (move: Move, language: 'it' | 'en'): string => `${language === 'it' ? 'Mossa' : 'Move'}: ${move.ply}. ${move.san} (${move.uci})`

const playedBy = (move: Move, language: 'it' | 'en'): string =>
  language === 'it'
    ? move.by === 'user'
      ? 'dalla persona che alleni'
      : 'dal suo avversario'
    : move.by === 'user'
      ? 'by the person you coach'
      : 'by their opponent'

/** "Commenta questa mossa" of the review screen: one past ply, with the engine's best line. */
export function commentMoveText(p: ReviewMoveContext): string {
  const it = p.language === 'it'
  return [
    it ? `Rivedi la mossa ${p.move.ply} di una partita già conclusa, giocata ${playedBy(p.move, p.language)}.` : `Review move ${p.move.ply} of a finished game, played ${playedBy(p.move, p.language)}.`,
    moveHeader(p.move, p.language),
    ...positionBlock(p.fenBefore, p.pgn, p.language),
    ...engineBlock(p.engine, p.language, { withAfter: true }),
    it
      ? 'Scrivi da due a quattro frasi di testo semplice: che cosa fa questa mossa, che cosa sarebbe stato meglio e perché, e che cosa portarsi via da questa posizione. Niente elenchi e niente JSON.'
      : 'Write two to four sentences of plain text: what the move does, what would have been better and why, and what to take away from this position. No lists and no JSON.'
  ].join('\n')
}

/** One of the key moments (spec §4.4): same material, said as part of a short series. */
export function keyMomentsCommentText(p: ReviewMoveContext & { index: number; count: number }): string {
  const it = p.language === 'it'
  return [
    it
      ? `Rivedi la mossa ${p.move.ply}: è il momento chiave ${p.index} di ${p.count} di questa partita, giocato ${playedBy(p.move, p.language)}.`
      : `Review move ${p.move.ply}: it is key moment ${p.index} of ${p.count} of this game, played ${playedBy(p.move, p.language)}.`,
    moveHeader(p.move, p.language),
    ...positionBlock(p.fenBefore, p.pgn, p.language),
    ...engineBlock(p.engine, p.language, { withAfter: true }),
    it
      ? 'Scrivi da due a tre frasi: che cosa è andato storto qui, quale idea era migliore e come riconoscere questa situazione la prossima volta. Niente elenchi e niente JSON.'
      : 'Write two to three sentences: what went wrong here, which idea was better and how to recognise this situation next time. No lists and no JSON.'
  ].join('\n')
}

/**
 * Structured output of the lesson (spec §4.4). Strict-mode rules of §3.1: every property in
 * `required`, no `additionalProperties`, no cardinality keywords — three takeaways are asked for
 * in the text and clamped to three on this side.
 */
export const LESSON_SCHEMA = {
  type: 'object',
  required: ['takeaways', 'summary'],
  additionalProperties: false,
  properties: {
    takeaways: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' }
  }
} as const

const OUTCOME_NAME: Record<'it' | 'en', Record<string, string>> = {
  it: { '1-0': 'vittoria del Bianco', '0-1': 'vittoria del Nero', '1/2-1/2': 'patta' },
  en: { '1-0': 'White wins', '0-1': 'Black wins', '1/2-1/2': 'draw' }
}

const REASON_NAME: Record<'it' | 'en', Record<string, string>> = {
  it: {
    checkmate: 'scacco matto',
    stalemate: 'stallo',
    resign: 'abbandono',
    draw_agreed: 'patta concordata',
    repetition: 'ripetizione',
    fifty: 'regola delle cinquanta mosse',
    insufficient: 'materiale insufficiente',
    timeout: 'tempo scaduto'
  },
  en: {
    checkmate: 'checkmate',
    stalemate: 'stalemate',
    resign: 'resignation',
    draw_agreed: 'draw agreed',
    repetition: 'repetition',
    fifty: 'fifty-move rule',
    insufficient: 'insufficient material',
    timeout: 'flag fall'
  }
}

/** "Lezione della partita": the whole game summarised for the model, answer as {@link LESSON_SCHEMA}. */
export function lessonText(p: { game: Game; language: 'it' | 'en'; pgn: string }): string {
  const it = p.language === 'it'
  const game = p.game
  const lines: string[] = [
    it
      ? `Ricava la lezione di questa partita per la persona che alleni, che giocava con ${COLOR_NAME.it[game.userColor]}.`
      : `Draw the lesson of this game for the person you coach, who played with ${COLOR_NAME.en[game.userColor]}.`
  ]

  if (game.result) {
    const outcome = OUTCOME_NAME[p.language][game.result.outcome] ?? game.result.outcome
    const reason = REASON_NAME[p.language][game.result.reason] ?? game.result.reason
    lines.push(`${it ? 'Risultato' : 'Result'}: ${game.result.outcome} (${outcome}, ${reason})`)
  }
  if (game.opening) lines.push(`${it ? 'Apertura' : 'Opening'}: ${game.opening.eco} ${game.opening.name}`)
  lines.push(`PGN: ${p.pgn}`)

  const analysis = game.analysis
  if (analysis) {
    lines.push(
      `${it ? 'Accuratezza' : 'Accuracy'}: ${it ? 'Bianco' : 'White'} ${analysis.accuracy.w.toFixed(1)}%, ${it ? 'Nero' : 'Black'} ${analysis.accuracy.b.toFixed(1)}%`,
      `ACPL: ${it ? 'Bianco' : 'White'} ${analysis.acpl.w}, ${it ? 'Nero' : 'Black'} ${analysis.acpl.b}`
    )
    const moments = analysis.keyMoments
      .map((ply) => game.moves[ply - 1])
      .filter((move): move is Move => Boolean(move))
      .slice(0, 8)
    if (moments.length > 0) {
      lines.push(it ? 'Momenti chiave (mosse della persona che alleni):' : 'Key moments (moves by the person you coach):')
      for (const move of moments) {
        const evaluation = move.eval
        const label = evaluation ? CLASSIFICATION_NAME[p.language][evaluation.classification] : it ? 'da rivedere' : 'to review'
        const best = evaluation?.bestMove ? ` — ${it ? 'migliore' : 'best'}: ${evaluation.bestMove}` : ''
        const after = evaluation ? ` (${it ? 'dopo' : 'after'} ${formatEval(evaluation.after, p.language)})` : ''
        lines.push(`- ${move.ply}. ${move.san} · ${label}${after}${best}`)
      }
    }
  } else {
    lines.push(it ? 'Questa partita non è stata analizzata dal motore: giudica con le tue forze.' : 'This game was not analysed by the engine: judge with your own eyes.')
  }

  lines.push(
    it
      ? 'Rispondi soltanto con il JSON richiesto: "takeaways" sono esattamente tre insegnamenti brevi e concreti, "summary" è un riepilogo di due o tre frasi della partita. Parla alla persona che alleni, senza compiacenza e senza gergo inutile.'
      : 'Answer with the requested JSON only: "takeaways" are exactly three short, concrete lessons, "summary" is a two or three sentence recap of the game. Speak to the person you coach, with no flattery and no needless jargon.'
  )
  return lines.join('\n')
}
