import type { CoachLogEntry, Move } from '@shared/types/game'
import { describe, expect, it } from 'vitest'
import {
  ADVICE_SCHEMA,
  HINT_SCHEMA,
  adviceText,
  coachBaseInstructions,
  commentText,
  hintText,
  formatEval,
  resumeSummaryText,
  type EngineContext
} from './coachPrompts'

const FEN_BEFORE = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2'
const FEN_AFTER = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq - 1 2'
const PGN = '[Event "?"]\n[Site "?"]\n\n1. e4 e5 2. Nf3 *'

/** Nothing that belongs to the opponent thread may leak into a coach prompt (spec §4.2). */
const OPPONENT_WORDS = /thread|avversario gioca|il tuo piano|intenzioni dell/i

const move: Move = {
  ply: 3,
  san: 'Nf3',
  uci: 'g1f3',
  fenAfter: FEN_AFTER,
  epdAfter: 'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq -',
  by: 'user'
}

const engine: EngineContext = {
  evalBefore: { cp: 35 },
  evalAfter: { cp: 24 },
  bestLines: [
    { san: 'Nf3', pv: ['Nf3', 'Nc6', 'Bb5'], eval: { cp: 35 } },
    { san: 'Bc4', pv: ['Bc4', 'Nf6'], eval: { cp: 20 } },
    { san: 'Nc3', pv: ['Nc3'], eval: { cp: 10 } }
  ]
}

describe('coachBaseInstructions', () => {
  it('describes the tutor and the engine data it will receive', () => {
    const text = coachBaseInstructions({ language: 'it', userColor: 'w', engineAvailable: true })
    expect(text).toContain('il Bianco')
    expect(text).toMatch(/mai condiscendente/)
    expect(text).toMatch(/Stockfish/)
    expect(text).toMatch(/Non usi strumenti/)
    // The coach must never speak for the opponent (spec §4.2).
    expect(text).toMatch(/non riveli il suo piano/i)
    expect(text).not.toMatch(/senza oracolo/)
  })

  it('switches to the oracle-less persona when the engine is unavailable', () => {
    const it_ = coachBaseInstructions({ language: 'it', userColor: 'b', engineAvailable: false })
    expect(it_).toContain('il Nero')
    expect(it_).toMatch(/senza oracolo/)
    expect(it_).not.toMatch(/usali come base/)

    const en = coachBaseInstructions({ language: 'en', userColor: 'b', engineAvailable: false })
    expect(en).toMatch(/without the engine oracle/)
    expect(en).toContain('Black')
  })
})

describe('commentText', () => {
  it('carries the move, the position, the game and the engine lines', () => {
    const text = commentText({ move, by: 'user', fen: FEN_AFTER, pgn: PGN, engine, language: 'it' })
    expect(text).toContain('Commenta')
    expect(text).toContain('3. Nf3 (g1f3)')
    expect(text).toContain(`FEN: ${FEN_AFTER}`)
    // The PGN is written as movetext only: the seven-tag roster says nothing the FEN does not.
    expect(text).toContain('PGN: 1. e4 e5 2. Nf3')
    expect(text).not.toContain('[Event')
    expect(text).toContain('+0.35')
    expect(text).toContain('+0.24')
    expect(text).toContain('1. Nf3 (+0.35) — Nf3 Nc6 Bb5')
    expect(text).toContain('3. Nc3')
    expect(text).toMatch(/due a quattro frasi/)
    expect(text).not.toMatch(OPPONENT_WORDS)
  })

  it('writes a mate score and the classification when the pipeline provides one', () => {
    const text = commentText({
      move,
      by: 'ai',
      fen: FEN_AFTER,
      pgn: PGN,
      engine: { ...engine, evalAfter: { mate: -3 }, classification: 'blunder' },
      language: 'it'
    })
    expect(text).toContain('matto in 3 per il Nero')
    expect(text).toContain('Classificazione: errore grave')
  })

  it('keeps the winner explicit for mate in zero on a terminal position', () => {
    expect(formatEval({ mate: 0, mateWinner: 'b' }, 'it')).toBe('matto in 0 per il Nero')
    const text = commentText({
      move,
      by: 'user',
      fen: FEN_AFTER,
      pgn: PGN,
      engine: {
        ...engine,
        evalAfter: { mate: 0, mateWinner: 'b' },
        terminal: { winner: 'b', at: 'after' }
      },
      language: 'it'
    })
    expect(text).toContain('matto in 0 per il Nero')
    expect(text).toContain('Posizione terminale: scacco matto; ha vinto il Nero.')
  })

  it('says there is no engine data at all in the oracle-less mode', () => {
    const text = commentText({
      move,
      by: 'user',
      fen: FEN_AFTER,
      pgn: PGN,
      engine: null,
      language: 'it'
    })
    expect(text).toMatch(/senza oracolo/)
    expect(text).not.toMatch(/Stockfish \(valutazioni/)
    expect(text).not.toContain('+0.35')
    expect(text).toContain(`FEN: ${FEN_AFTER}`)
  })

  it('writes the English variant when the UI language is English', () => {
    const text = commentText({ move, by: 'user', fen: FEN_AFTER, pgn: PGN, engine, language: 'en' })
    expect(text).toContain('Comment on the move')
    expect(text).toContain('Best lines')
    expect(text).toMatch(/two to four sentences/)
  })
})

describe('adviceText', () => {
  it('quotes the question and the position, and asks for prose', () => {
    const text = adviceText({
      question: '  Perché non posso arroccare?  ',
      userColor: 'w',
      fen: FEN_BEFORE,
      pgn: PGN,
      engine,
      language: 'it'
    })
    expect(text).toContain('Domanda: Perché non posso arroccare?')
    expect(text).toContain(`FEN: ${FEN_BEFORE}`)
    expect(text).toContain('PGN: 1. e4 e5 2. Nf3')
    expect(text).toContain('1. Nf3 (+0.35)')
    // A question is about the position now: there is no "after" evaluation to write.
    expect(text).not.toContain('Valutazione dopo')
    expect(text).toContain('"answer"')
    expect(text).toContain('"move"')
    expect(text).toContain('Colore della persona: il Bianco')
    expect(text).toContain('usa null')
    expect(text).not.toMatch(OPPONENT_WORDS)
  })

  it('uses a strict nullable-move schema', () => {
    expect(ADVICE_SCHEMA.required).toEqual(['answer', 'move'])
    expect(ADVICE_SCHEMA.additionalProperties).toBe(false)
    expect(Object.keys(ADVICE_SCHEMA.properties)).toEqual(ADVICE_SCHEMA.required)
    expect(ADVICE_SCHEMA.properties.move.type).toEqual(['string', 'null'])
  })

  it('keeps working without the engine', () => {
    const text = adviceText({
      question: 'che piano ho?',
      userColor: 'w',
      fen: FEN_BEFORE,
      pgn: PGN,
      engine: null,
      language: 'it'
    })
    expect(text).toMatch(/senza oracolo/)
    expect(text).toContain('Domanda: che piano ho?')
  })
})

describe('hintText', () => {
  it('asks for the JSON object and never for prose', () => {
    const text = hintText({ fen: FEN_BEFORE, pgn: PGN, engine, language: 'it' })
    expect(text).toContain(`FEN: ${FEN_BEFORE}`)
    expect(text).toContain('"move"')
    expect(text).toContain('"reason"')
    expect(text).toContain('1. Nf3 (+0.35)')
    expect(text).not.toContain('Commenta')
    expect(text).not.toContain('Domanda:')
    expect(text).not.toMatch(OPPONENT_WORDS)
  })

  it('follows the strict-mode rules of the structured output', () => {
    expect(HINT_SCHEMA.required).toEqual(['move', 'reason'])
    expect(HINT_SCHEMA.additionalProperties).toBe(false)
    expect(Object.keys(HINT_SCHEMA.properties)).toEqual(HINT_SCHEMA.required)
    expect(JSON.stringify(HINT_SCHEMA)).not.toMatch(/minItems|maxItems|pattern/)
  })
})

describe('resumeSummaryText', () => {
  const entry = (index: number, kind: CoachLogEntry['kind']): CoachLogEntry => ({
    id: `c${index}`,
    ply: index,
    kind,
    text: `testo ${index}`,
    language: 'it',
    createdAt: '2026-01-01T00:00:00.000Z'
  })

  it('keeps only the last ten entries, in order', () => {
    const log = Array.from({ length: 14 }, (_, index) =>
      entry(index + 1, index % 2 === 0 ? 'question' : 'answer')
    )
    const text = resumeSummaryText(log, 'it')
    expect(text).not.toContain('testo 4')
    expect(text).toContain('testo 5')
    expect(text).toContain('testo 14')
    expect(text.indexOf('testo 5')).toBeLessThan(text.indexOf('testo 14'))
    expect(text).toContain('domanda')
    expect(text).toContain('risposta')
  })

  it('truncates a long entry and keeps the move it refers to', () => {
    const long = { ...entry(7, 'comment'), text: 'x'.repeat(400), move: 'Nf3' }
    const text = resumeSummaryText([long], 'it')
    expect(text).toContain('(Nf3)')
    expect(text).toContain('x'.repeat(200))
    expect(text).not.toContain('x'.repeat(201))
  })

  it('still says something when the log is empty', () => {
    expect(resumeSummaryText([], 'it')).toMatch(/riprende da un salvataggio/)
    expect(resumeSummaryText([], 'en')).toMatch(/resumes from a save/)
  })
})
