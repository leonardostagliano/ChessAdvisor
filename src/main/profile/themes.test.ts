import { describe, expect, it } from 'vitest'
import { FALLBACK_THEME, normalizeTheme, THEMES } from './themes'

describe('the taxonomy of spec §6.2', () => {
  it('is the fixed list of eighteen themes, without duplicates', () => {
    expect(THEMES).toHaveLength(18)
    expect(new Set(THEMES).size).toBe(THEMES.length)
    expect(THEMES).toContain('fork')
    expect(THEMES).toContain('endgame_technique')
    expect(THEMES[THEMES.length - 1]).toBe(FALLBACK_THEME)
  })
})

describe('normalizeTheme', () => {
  it('keeps a theme that already belongs to the taxonomy', () => {
    for (const theme of THEMES) expect(normalizeTheme(theme)).toBe(theme)
  })

  it('accepts case, spaces, dashes and camelCase', () => {
    expect(normalizeTheme('Fork')).toBe('fork')
    expect(normalizeTheme('hanging piece')).toBe('hanging_piece')
    expect(normalizeTheme('back-rank')).toBe('back_rank')
    expect(normalizeTheme('hangingPiece')).toBe('hanging_piece')
    expect(normalizeTheme('  KING_SAFETY  ')).toBe('king_safety')
  })

  it('maps the spellings the model and the puzzle datasets use', () => {
    expect(normalizeTheme('backRankMate')).toBe('back_rank')
    expect(normalizeTheme('discoveredAttack')).toBe('discovered_attack')
    expect(normalizeTheme('endgame')).toBe('endgame_technique')
    expect(normalizeTheme('deflection')).toBe('overloaded_piece')
  })

  it('sends everything else to missed_tactic (spec §6.3)', () => {
    expect(normalizeTheme('zugzwang')).toBe(FALLBACK_THEME)
    expect(normalizeTheme('')).toBe(FALLBACK_THEME)
    expect(normalizeTheme(null)).toBe(FALLBACK_THEME)
    expect(normalizeTheme(42)).toBe(FALLBACK_THEME)
    expect(normalizeTheme({ theme: 'fork' })).toBe(FALLBACK_THEME)
  })
})
