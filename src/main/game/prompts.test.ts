import { legalMoves } from '@shared/chess/notation'
import {
  DIFFICULTY_LEVELS,
  nearestLevel,
  type DifficultyLevel,
  type OpponentDifficulty
} from '@shared/types/session'
import { describe, expect, it } from 'vitest'
import {
  DRAW_OFFER_SCHEMA,
  OPPONENT_MOVE_SCHEMA,
  opponentBaseInstructions,
  opponentTurnText
} from './prompts'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

const fixed = (level: DifficultyLevel): OpponentDifficulty => ({
  mode: 'fixed',
  level,
  targetElo: DIFFICULTY_LEVELS[level].elo
})

/** Nothing about the engine may reach the opponent: it plays on the position alone (spec §4.1). */
const ORACLE_WORDS = /stockfish|valutazion|evaluation|motore|engine|centipawn/i

describe('nearestLevel', () => {
  it('picks the nearest rated level, ties going to the higher one', () => {
    expect(nearestLevel(749)).toBe(1)
    expect(nearestLevel(750)).toBe(2)
    expect(nearestLevel(1049)).toBe(2)
    expect(nearestLevel(1050)).toBe(3)
    expect(nearestLevel(1350)).toBe(4)
    expect(nearestLevel(1651)).toBe(5)
    expect(nearestLevel(2400)).toBe(5)
  })

  it('never returns the unrated level 6', () => {
    for (let elo = 400; elo <= 2600; elo += 37) expect(nearestLevel(elo)).toBeLessThan(6)
  })
})

describe('opponentBaseInstructions', () => {
  it('writes the persona and target Elo of every rated level without an artificial depth cap', () => {
    const personas: Record<DifficultyLevel, RegExp> = {
      1: /Principiante/,
      2: /Facile/,
      3: /Medio/,
      4: /Impegnativo/,
      5: /Forte/,
      6: /Massimo/
    }
    for (const level of [1, 2, 3, 4, 5] as DifficultyLevel[]) {
      const text = opponentBaseInstructions({
        color: 'b',
        difficulty: fixed(level),
        language: 'it'
      })
      expect(text).toMatch(personas[level])
      expect(text).toContain(String(DIFFICULTY_LEVELS[level].elo))
      expect(text).toContain('Riferimento Chess.com Rapid')
      expect(text).toContain('preferisci la mossa naturale')
      expect(text).not.toMatch(/calcolare oltre \d+ semimosse/i)
    }
  })

  it('gives Medium and every stronger tier the same immediate tactical floor', () => {
    for (const language of ['it', 'en'] as const) {
      for (const level of [3, 4, 5, 6] as DifficultyLevel[]) {
        const text = opponentBaseInstructions({ color: 'b', difficulty: fixed(level), language })
        if (language === 'it') {
          expect(text).toMatch(/scacchi, catture(?:,| e) minacce/)
          expect(text).toContain('risposta immediata più forte dell’avversario')
          expect(text).not.toContain('Rispetta sempre i controlli tattici')
        } else {
          expect(text).toMatch(/checks, captures(?:,| and) threats/)
          expect(text).toContain("opponent's strongest immediate reply")
          expect(text).not.toContain('Always perform the')
        }
      }
    }
  })

  it('escalates from immediate checks to stable forcing lines without numeric ply ceilings', () => {
    const medium = opponentBaseInstructions({ color: 'b', difficulty: fixed(3), language: 'en' })
    const challenging = opponentBaseInstructions({
      color: 'b',
      difficulty: fixed(4),
      language: 'en'
    })
    const strong = opponentBaseInstructions({ color: 'b', difficulty: fixed(5), language: 'en' })
    expect(medium).toContain("opponent's strongest immediate reply")
    expect(medium).not.toContain('tactically stable')
    expect(challenging).toContain('forcing lines until the position is tactically stable')
    expect(strong).toContain('every forcing line until the position is tactically stable')
    for (const text of [medium, challenging, strong]) {
      expect(text).not.toMatch(/deeper than \d+ plies/i)
    }
  })

  it('asks level 6 for the best play it can find, with no Elo and no depth limit', () => {
    const text = opponentBaseInstructions({ color: 'w', difficulty: fixed(6), language: 'it' })
    expect(text).toContain('Massimo')
    expect(text).toContain('la mossa migliore che riesci a trovare')
    expect(text).not.toMatch(/Riferimento Chess\.com Rapid/)
    expect(text).not.toMatch(/Non calcolare oltre/)
  })

  it('plays the persona of the nearest level in adaptive mode and writes the exact Elo', () => {
    const text = opponentBaseInstructions({
      color: 'b',
      difficulty: { mode: 'adaptive', level: 3, targetElo: 1300 },
      language: 'it'
    })
    expect(text).toContain('Medio')
    expect(text).toContain('1300')
    expect(text).not.toContain('1200')
  })

  it('states the colour the model plays, in both languages', () => {
    expect(
      opponentBaseInstructions({ color: 'w', difficulty: fixed(4), language: 'it' })
    ).toContain('il Bianco')
    expect(
      opponentBaseInstructions({ color: 'b', difficulty: fixed(4), language: 'en' })
    ).toContain('Black')
  })

  it('never mentions the engine or its evaluations', () => {
    for (const language of ['it', 'en'] as const) {
      for (const level of [1, 2, 3, 4, 5, 6] as DifficultyLevel[]) {
        expect(
          opponentBaseInstructions({ color: 'w', difficulty: fixed(level), language })
        ).not.toMatch(ORACLE_WORDS)
      }
    }
  })
})

describe('opponentTurnText', () => {
  const legal = legalMoves(START_FEN)

  it('carries the FEN, the PGN and the legal moves as SAN = UCI', () => {
    const text = opponentTurnText({
      lastUserMove: 'e4',
      fen: START_FEN,
      pgn: '1. e4',
      legal,
      takebackNotice: null,
      language: 'it'
    })
    expect(text).toContain(`FEN: ${START_FEN}`)
    expect(text).toContain('PGN: 1. e4')
    expect(text).toContain('Mosse legali (SAN = UCI): ')
    expect(text).toContain('e4 = e2e4')
    expect(text).toContain('Nf3 = g1f3')
    expect(text).toContain('Ultima mossa dell’avversario: e4')
  })

  it('mentions a takeback only when there was one', () => {
    const base = { lastUserMove: 'e4', fen: START_FEN, pgn: '', legal, language: 'it' as const }
    expect(opponentTurnText({ ...base, takebackNotice: null })).not.toMatch(/annullate/)
    expect(opponentTurnText({ ...base, takebackNotice: 0 })).not.toMatch(/annullate/)
    expect(opponentTurnText({ ...base, takebackNotice: 2 })).toContain(
      'le ultime 2 semimosse sono state annullate'
    )
  })

  it('keeps the FEN on one parsable line even when the PGN spans several', () => {
    const text = opponentTurnText({
      lastUserMove: null,
      fen: START_FEN,
      pgn: '1. e4 e5\n2. Nf3 Nc6',
      legal,
      takebackNotice: null,
      language: 'en'
    })
    const fenLines = text.split('\n').filter((line) => line.startsWith('FEN: '))
    expect(fenLines).toEqual([`FEN: ${START_FEN}`])
    expect(text).toContain('PGN: 1. e4 e5 2. Nf3 Nc6')
    expect(text).toContain('Legal moves (SAN = UCI): ')
  })

  it('presents every database continuation as incomplete non-binding context', () => {
    const legal = legalMoves(START_FEN)
    const text = opponentTurnText({
      lastUserMove: null,
      fen: START_FEN,
      pgn: '',
      legal,
      opening: {
        current: { eco: 'A00', name: 'Starting position' },
        continuations: [
          { san: 'd4', uci: 'd2d4', eco: 'A40', name: "Queen's Pawn Game" },
          { san: 'e4', uci: 'e2e4', eco: 'B00', name: "King's Pawn Game" }
        ]
      },
      takebackNotice: null,
      language: 'en'
    })

    expect(text).toContain('A00 — Starting position')
    expect(text).toContain("d4 (d2d4) → A40 — Queen's Pawn Game")
    expect(text).toContain("e4 (e2e4) → B00 — King's Pawn Game")
    expect(text).toContain('archive is incomplete')
    expect(text).toContain('not restricted to the listed continuations')
    expect(text).toContain('prioritize the current position and your own calculation')
    expect(text).toContain('Nf3 = g1f3')
  })

  it('includes empirical context as soft guidance without removing legal moves', () => {
    const text = opponentTurnText({
      lastUserMove: null,
      fen: START_FEN,
      pgn: '',
      legal,
      humanContext: ['Rapid sample: 35% of comparable positions chose a developing move.'],
      takebackNotice: null,
      language: 'en'
    })

    expect(text).toContain('Rapid sample: 35% of comparable positions chose a developing move.')
    expect(text).toContain('e4 = e2e4')
    expect(text).toContain('Nf3 = g1f3')
    expect(text).toContain('Choose a move taken exactly from this list')
  })
})

describe('output schemas', () => {
  it('follow the strict structured-output rules of spec §3.1', () => {
    for (const schema of [OPPONENT_MOVE_SCHEMA, DRAW_OFFER_SCHEMA] as const) {
      expect(schema.additionalProperties).toBe(false)
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort())
      expect(JSON.stringify(schema)).not.toMatch(/minItems|maxItems|pattern/)
    }
    expect(OPPONENT_MOVE_SCHEMA.properties.shortComment.type).toEqual(['string', 'null'])
  })
})
