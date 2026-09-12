import { legalMoves } from '@shared/chess/notation'
import { DIFFICULTY_LEVELS, nearestLevel, type DifficultyLevel, type OpponentDifficulty } from '@shared/types/session'
import { describe, expect, it } from 'vitest'
import { DRAW_OFFER_SCHEMA, OPPONENT_MOVE_SCHEMA, opponentBaseInstructions, opponentTurnText } from './prompts'

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
  it('writes the persona, the target Elo and the depth limit of every rated level', () => {
    const personas: Record<DifficultyLevel, RegExp> = {
      1: /Principiante/,
      2: /Facile/,
      3: /Medio/,
      4: /Impegnativo/,
      5: /Forte/,
      6: /Massimo/
    }
    for (const level of [1, 2, 3, 4, 5] as DifficultyLevel[]) {
      const text = opponentBaseInstructions({ color: 'b', difficulty: fixed(level), language: 'it' })
      expect(text).toMatch(personas[level])
      expect(text).toContain(String(DIFFICULTY_LEVELS[level].elo))
      expect(text).toContain(`Non calcolare oltre ${level} semimosse`)
      expect(text).toContain('preferisci la mossa naturale')
    }
  })

  it('forbids giving material away from level 3 up only', () => {
    const give = 'Non regalare mai materiale'
    expect(opponentBaseInstructions({ color: 'b', difficulty: fixed(2), language: 'it' })).not.toContain(give)
    expect(opponentBaseInstructions({ color: 'b', difficulty: fixed(3), language: 'it' })).toContain(give)
    expect(opponentBaseInstructions({ color: 'b', difficulty: fixed(5), language: 'it' })).toContain(give)
  })

  it('asks level 6 for the best play it can find, with no Elo and no depth limit', () => {
    const text = opponentBaseInstructions({ color: 'w', difficulty: fixed(6), language: 'it' })
    expect(text).toContain('Massimo')
    expect(text).toContain('la mossa migliore che riesci a trovare')
    expect(text).not.toMatch(/Elo obiettivo/)
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
    expect(opponentBaseInstructions({ color: 'w', difficulty: fixed(4), language: 'it' })).toContain('il Bianco')
    expect(opponentBaseInstructions({ color: 'b', difficulty: fixed(4), language: 'en' })).toContain('Black')
  })

  it('never mentions the engine or its evaluations', () => {
    for (const language of ['it', 'en'] as const) {
      for (const level of [1, 2, 3, 4, 5, 6] as DifficultyLevel[]) {
        expect(opponentBaseInstructions({ color: 'w', difficulty: fixed(level), language })).not.toMatch(ORACLE_WORDS)
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
    expect(opponentTurnText({ ...base, takebackNotice: 2 })).toContain('le ultime 2 semimosse sono state annullate')
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
