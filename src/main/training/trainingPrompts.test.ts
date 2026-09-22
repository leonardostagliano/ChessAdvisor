import type { Profile } from '@shared/types/profile'
import { EMPTY_PROFILE } from '@shared/types/profile'
import type { Exercise, OpeningOverviewEntry, StudyCatalogue } from '@shared/types/training'
import { describe, expect, it } from 'vitest'
import { THEMES } from '../profile/themes'
import {
  explainExerciseText,
  openingLessonText,
  planSchema,
  planText,
  themePickText,
  trainingBaseInstructions,
  PLAN_ACTIVITY_TYPES,
  THEME_PICK_SCHEMA
} from './trainingPrompts'

const profile: Profile = {
  ...EMPTY_PROFILE,
  level: { band: 'novice', estimate: 950, confidence: 0.4, updatedAt: '2026-03-01T10:00:00.000Z' },
  themeStats: { fork: { occurrences: 5, lastSeen: '2026-03-01T10:00:00.000Z' } },
  history: [{ gameId: 'g1', date: '2026-03-01T10:00:00.000Z', accuracy: 71.5, acpl: 62 }]
}

const catalogue: StudyCatalogue = {
  themes: ['fork', 'pin'],
  exercises: ['og-g1-7'],
  openings: ['C60'],
  endgames: ['queen_mate']
}

/** Strict-mode rules of spec §3.1, checked on every schema of the task. */
function expectStrict(schema: unknown): void {
  if (typeof schema !== 'object' || schema === null) throw new Error('not a schema')
  const record = schema as Record<string, unknown>
  if (record.type === 'object') {
    const properties = (record.properties ?? {}) as Record<string, unknown>
    expect(record.additionalProperties).toBe(false)
    expect([...(record.required as string[])].sort()).toEqual(Object.keys(properties).sort())
    for (const value of Object.values(properties)) expectStrict(value)
  }
  if (record.type === 'array') {
    expect(record.minItems).toBeUndefined()
    expect(record.maxItems).toBeUndefined()
    expectStrict(record.items)
  }
  expect(record.pattern).toBeUndefined()
}

describe('trainingBaseInstructions', () => {
  it('speaks the language of the UI and forbids code fences', () => {
    expect(trainingBaseInstructions('it')).toContain('allenatore')
    expect(trainingBaseInstructions('en')).toContain('coach')
    expect(trainingBaseInstructions('it')).toContain('blocchi di codice')
  })
})

describe('THEME_PICK_SCHEMA', () => {
  it('follows the strict-mode rules and pins the theme to the taxonomy', () => {
    expectStrict(THEME_PICK_SCHEMA)
    expect(THEME_PICK_SCHEMA.properties.theme.enum).toEqual([...THEMES])
  })
})

describe('themePickText', () => {
  it('writes the level, the recurring themes and what the library holds', () => {
    const text = themePickText({
      profile,
      language: 'it',
      available: [
        { theme: 'fork', count: 120 },
        { theme: 'pin', count: 0 }
      ]
    })
    expect(text).toContain('950')
    expect(text).toContain('- fork · 5')
    expect(text).toContain('- fork · 120')
    expect(text).not.toContain('- pin · 0')
  })

  it('treats a reset profile as unknown and includes measured exercise outcomes', () => {
    const text = themePickText({
      profile: EMPTY_PROFILE,
      language: 'en',
      available: [{ theme: 'fork', count: 10 }],
      practice: [
        { theme: 'fork', attempted: 3, solved: 1, failed: 2, attempts: 7, averageRating: 1200 }
      ],
      suggestedWindow: { min: 900, max: 1300, reason: 'results from completed exercises' }
    })
    expect(text).toContain('not available yet')
    expect(text).not.toContain('Estimated level: 0 (beginner)')
    expect(text).toContain('exercises attempted')
    expect(text).toContain('900–1300')
  })
})

describe('explainExerciseText', () => {
  const exercise: Exercise = {
    id: 'og-g1-7',
    kind: 'own_game',
    fen: 'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4',
    sideToMove: 'w',
    solution: ['f3g5', 'd7d5'],
    theme: 'fork',
    rating: 1100,
    sourceGameId: 'g1',
    sourcePly: 7,
    status: 'new',
    attempts: 0,
    createdAt: '2026-03-01T10:00:00.000Z'
  }

  it('opens with the word the fake app-server answers to, and carries the material', () => {
    const text = explainExerciseText({
      exercise,
      solutionSan: ['Ng5', 'd5'],
      language: 'it',
      playedSan: 'd3'
    })
    expect(text.startsWith('Spiega')).toBe(true)
    expect(text).toContain(`FEN: ${exercise.fen}`)
    expect(text).toContain('Ng5 d5')
    expect(text).toContain('d3')
    expect(text).toContain('Niente elenchi e niente JSON.')
  })

  it('grounds the explanation in level and supplied engine variations', () => {
    const text = explainExerciseText({
      exercise: { ...exercise, status: 'failed', attempts: 2 },
      solutionSan: ['Ng5', 'd5'],
      language: 'en',
      profile,
      engineLines: ['1. Ng5 d5 · +0.32 · depth 20']
    })
    expect(text).toContain('Estimated level: 950')
    expect(text).toContain('Stockfish lines from the starting position')
    expect(text).toContain('Ng5 d5 · +0.32')
  })
})

describe('openingLessonText', () => {
  const entry: OpeningOverviewEntry = {
    eco: 'C60',
    name: 'Partita spagnola',
    games: 4,
    score: 62.5,
    avgAccuracyFirst10: 82.5,
    deviations: [
      {
        epd: 'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq -',
        san: 'a6',
        count: 3,
        bestSan: 'Nf6'
      }
    ]
  }

  it('writes the numbers of the user and their recurring deviations', () => {
    const text = openingLessonText({ entry, language: 'it' })
    expect(text.startsWith('Spiega')).toBe(true)
    expect(text).toContain('C60 Partita spagnola')
    expect(text).toContain('- a6 · 3 · Nf6')
  })

  it('adds concrete engine context and the learner level when available', () => {
    const epd = entry.deviations[0]!.epd
    const text = openingLessonText({
      entry,
      language: 'en',
      profile,
      engineLines: { [epd]: ['1. ... Nf6 2. O-O · +0.18 · depth 20'] }
    })
    expect(text).toContain('Stockfish lines')
    expect(text).toContain('Nf6 2. O-O')
    expect(text).toContain('Estimated level: 950')
  })

  it('says plainly when there is no deviation on record', () => {
    expect(openingLessonText({ entry: { ...entry, deviations: [] }, language: 'en' })).toContain(
      'No recurring deviation'
    )
  })
})

describe('the plan prompt', () => {
  it('pins every reference of the schema to the catalogue', () => {
    const schema = planSchema(catalogue) as {
      properties: {
        items: {
          items: {
            properties: {
              activity: { properties: { ref: { enum: unknown[] }; type: { enum: unknown[] } } }
            }
          }
        }
      }
    }
    expectStrict(schema)
    const activity = schema.properties.items.items.properties.activity.properties
    expect(activity.type.enum).toEqual([...PLAN_ACTIVITY_TYPES])
    expect(activity.ref.enum).toEqual(['fork', 'pin', 'og-g1-7', 'C60', 'queen_mate', null])
  })

  it('writes the catalogue as one line per activity type', () => {
    const text = planText({
      catalogue,
      profile,
      language: 'it',
      labels: { queen_mate: 'Matto con la donna' }
    })
    expect(text).toContain('- thematic: fork | pin')
    expect(text).toContain('- own_game: og-g1-7')
    expect(text).toContain('- opening: C60')
    expect(text).toContain('- endgame: queen_mate')
    expect(text).toMatch(/- play: nessun ref/)
    expect(text).toContain('- queen_mate: Matto con la donna')
  })

  it('says when a kind of material is not available at all', () => {
    const text = planText({
      catalogue: { themes: ['fork'], exercises: [], openings: [], endgames: [] },
      profile,
      language: 'en'
    })
    expect(text).toContain('- own_game: none available')
  })

  it('carries exercise outcomes into the requested progression', () => {
    const text = planText({
      catalogue,
      profile: EMPTY_PROFILE,
      language: 'en',
      practice: [
        { theme: 'pin', attempted: 2, solved: 0, failed: 2, attempts: 4, averageRating: 1100 }
      ]
    })
    expect(text).toContain('Recent exercise results')
    expect(text).toContain('- pin · 2 · 0 · 2 · 4')
    expect(text).toContain('without assuming a level')
  })
})
