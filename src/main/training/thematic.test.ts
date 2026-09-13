import type { Puzzle } from '@shared/types/training'
import { describe, expect, it } from 'vitest'
import { THEMES } from '../profile/themes'
import {
  puzzleToExercise,
  rotationPick,
  rotationTheme,
  sanitizeThemePick,
  thematicExerciseId,
  RATING_CEILING,
  RATING_FLOOR
} from './thematic'

describe('sanitizeThemePick', () => {
  it('takes the coach answer as it is when it makes sense', () => {
    const pick = sanitizeThemePick({
      theme: 'fork',
      ratingMin: 900,
      ratingMax: 1300,
      motivation: 'perché'
    })
    expect(pick).toEqual({
      theme: 'fork',
      ratingMin: 900,
      ratingMax: 1300,
      motivation: 'perché',
      fallback: false
    })
  })

  it('squeezes an unknown theme back into the taxonomy', () => {
    expect(
      sanitizeThemePick({ theme: 'zwischenzug', ratingMin: 900, ratingMax: 1300 })?.theme
    ).toBe('missed_tactic')
  })

  it('turns an upside-down window around and clamps it to the dataset', () => {
    const pick = sanitizeThemePick({ theme: 'pin', ratingMin: 3000, ratingMax: 100 })
    expect(pick?.ratingMin).toBe(RATING_FLOOR)
    expect(pick?.ratingMax).toBe(RATING_CEILING)
  })

  it('widens a window too narrow to draw from', () => {
    const pick = sanitizeThemePick({ theme: 'pin', ratingMin: 1200, ratingMax: 1200 })
    expect(pick!.ratingMax - pick!.ratingMin).toBeGreaterThanOrEqual(100)
  })

  it('falls back to the default window when the coach gave none', () => {
    const pick = sanitizeThemePick({ theme: 'pin' })
    expect(pick?.ratingMin).toBe(800)
    expect(pick?.ratingMax).toBe(1200)
  })

  it('answers null when there is nothing to use', () => {
    expect(sanitizeThemePick(null)).toBeNull()
    expect(sanitizeThemePick({ ratingMin: 800, ratingMax: 1200 })).toBeNull()
  })
})

describe('rotationTheme', () => {
  it('walks the available themes in taxonomy order', () => {
    const available = ['pin', 'fork', 'back_rank']
    expect(rotationTheme(0, available)).toBe('fork')
    expect(rotationTheme(1, available)).toBe('pin')
    expect(rotationTheme(2, available)).toBe('back_rank')
    expect(rotationTheme(3, available)).toBe('fork')
  })

  it('falls back to the whole taxonomy when the library says nothing', () => {
    expect(rotationTheme(0, [])).toBe(THEMES[0])
  })

  it('draws in the default window and says it is a fallback', () => {
    expect(rotationPick(0, ['fork'])).toEqual({
      theme: 'fork',
      ratingMin: 800,
      ratingMax: 1200,
      motivation: '',
      fallback: true
    })
  })
})

describe('puzzleToExercise', () => {
  const puzzle: Puzzle = {
    id: 'abc12',
    fen: '8/8/8/4k3/8/8/4P3/4K3 w - - 0 1',
    sideToMove: 'w',
    solution: ['e2e4', 'e5e6', 'e1e2'],
    rating: 1100,
    themes: ['fork', 'endgame_technique'],
    source: 'lichess'
  }

  it('copies the puzzle over without replaying anything', () => {
    const exercise = puzzleToExercise(puzzle, 'fork', '2026-03-01T10:00:00.000Z')
    expect(exercise.id).toBe(thematicExerciseId('abc12'))
    expect(exercise.kind).toBe('thematic')
    expect(exercise.fen).toBe(puzzle.fen)
    expect(exercise.solution).toEqual(puzzle.solution)
    expect(exercise.rating).toBe(1100)
    expect(exercise.status).toBe('new')
    expect(exercise.attempts).toBe(0)
  })

  it('keeps the theme of the set only when the puzzle really has it', () => {
    expect(puzzleToExercise(puzzle, 'fork', 'x').theme).toBe('fork')
    expect(puzzleToExercise(puzzle, 'king_safety', 'x').theme).toBe('fork')
  })
})
