import type { Profile } from '@shared/types/profile'
import { describe, expect, it } from 'vitest'
import {
  LABELS_SCHEMA,
  QUALITATIVE_SCHEMA,
  labelsText,
  profileBaseInstructions,
  qualitativeText
} from './profilePrompts'
import { THEMES } from './themes'

const moment = {
  ply: 13,
  san: 'Nxe5',
  uci: 'f3e5',
  fenBefore: 'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
  classification: 'blunder' as const,
  bestSan: 'O-O',
  bestLine: ['O-O', 'Nf6'],
  winPercentLoss: 31.42
}

const profile: Profile = {
  level: {
    band: 'intermediate',
    estimate: 1440,
    confidence: 0.7,
    updatedAt: '2026-03-03T12:00:00.000Z'
  },
  themeStats: {
    fork: { occurrences: 4, lastSeen: '2026-03-03T12:00:00.000Z' },
    pin: { occurrences: 1, lastSeen: '2026-03-01T12:00:00.000Z' }
  },
  openingStats: {
    C40: {
      eco: 'C40',
      name: "King's Knight Opening",
      games: 3,
      wins: 1,
      draws: 1,
      losses: 1,
      avgAccuracyFirst10: 82.5
    }
  },
  history: [
    { gameId: 'g1', date: '2026-03-01T12:00:00.000Z', accuracy: 71.5, acpl: 62 },
    { gameId: 'g2', date: '2026-03-03T12:00:00.000Z', accuracy: 80.25, acpl: 41 }
  ],
  gamesSincePlan: 2
}

describe('the schemas of M4', () => {
  it('follow the strict-mode rules of spec §3.1', () => {
    const schemas: {
      type: string
      required: readonly string[]
      additionalProperties: boolean
      properties: object
    }[] = [LABELS_SCHEMA, QUALITATIVE_SCHEMA]
    for (const schema of schemas) {
      expect(schema.type).toBe('object')
      expect(schema.additionalProperties).toBe(false)
      expect([...schema.required].sort()).toEqual(Object.keys(schema.properties).sort())
      expect(JSON.stringify(schema)).not.toMatch(/minItems|maxItems|pattern/)
    }
    expect(LABELS_SCHEMA.properties.labels.items.required).toEqual(['ply', 'theme', 'note'])
    // The taxonomy travels in the text, not as an enum: every label is checked on this side.
    expect(LABELS_SCHEMA.properties.labels.items.properties.theme).toEqual({ type: 'string' })
  })
})

describe('labelsText', () => {
  it('lists every moment on a line the answer can be matched to, with the taxonomy', () => {
    const text = labelsText({
      moments: [moment],
      language: 'it',
      userColor: 'w',
      opening: { eco: 'C40', name: "King's Knight Opening" }
    })
    expect(text).toContain('- 13. Nxe5 (f3e5)')
    expect(text).toContain(`FEN: ${moment.fenBefore}`)
    expect(text).toContain('migliore: O-O — O-O Nf6')
    expect(text).toContain('errore grave')
    expect(text).toContain('C40')
    expect(text).toContain(THEMES.join(', '))
    expect(text).toContain('JSON')
  })

  it('speaks English when the UI does', () => {
    const text = labelsText({ moments: [moment], language: 'en', userColor: 'b' })
    expect(text).toContain('Label the key moments')
    expect(text).toContain('Black')
    expect(text).toContain('blunder')
  })
})

describe('qualitativeText', () => {
  it('hands over the level, the recent games and the aggregates', () => {
    const text = qualitativeText({ profile, language: 'it' })
    expect(text).toContain('1440')
    expect(text).toContain('intermedio')
    expect(text).toContain('0.70')
    expect(text).toContain('2026-03-03: 80.3% · 41')
    expect(text).toContain('- fork · 4')
    expect(text).toContain("C40 King's Knight Opening · 3 · 1/1/1 · 82.5%")
    expect(text).toContain('"strengths"')
  })

  it('says plainly when there is nothing to judge yet', () => {
    const text = qualitativeText({
      profile: { ...profile, history: [], themeStats: {}, openingStats: {} },
      language: 'en'
    })
    expect(text).toContain('There are no analysed games yet.')
  })
})

describe('profileBaseInstructions', () => {
  it('opens the thread as the coach, with no tools and no invented data', () => {
    expect(profileBaseInstructions('it')).toContain('allenatore')
    expect(profileBaseInstructions('it')).toContain('Non usi strumenti')
    expect(profileBaseInstructions('en')).toContain('chess coach')
    expect(profileBaseInstructions('en')).toContain('no tools')
  })
})
