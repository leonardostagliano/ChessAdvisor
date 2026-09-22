import { describe, expect, it } from 'vitest'
import {
  RAPID_DATA,
  estimateRapidProfile,
  rapidContextText,
  rapidLossAt,
  rapidOpening,
  usableProfile,
  type RapidDataset,
  type RapidProfile
} from './rapidCalibration'

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const profile = (elo: number, overrides: Partial<RapidProfile> = {}): RapidProfile => ({
  elo,
  phase: 'all',
  count: 100,
  players: 20,
  games: 60,
  quantilesCp: [0, 10, 40, 100, 200, 500, 900],
  lossCounts: [60, 20, 10, 5, 3, 1, 1],
  ...overrides
})
const dataset = (profiles: RapidProfile[]): RapidDataset => ({
  schemaVersion: 1,
  source: 'Chess.com PubAPI',
  timeClass: 'rapid',
  profiles,
  openings: []
})

describe('empirical Rapid reference', () => {
  it('ships supported real cohorts and opening context for every rated fixed tier', () => {
    for (const elo of [600, 900, 1200, 1500, 1800]) {
      const actual = RAPID_DATA.profiles.find((entry) => entry.elo === elo && entry.phase === 'all')
      expect(actual).toBeDefined()
      expect(usableProfile(actual!)).toBe(true)
      expect(rapidOpening(START, elo)?.count).toBeGreaterThanOrEqual(8)
    }
  })
  it('uses observed anchors and interpolates intermediate targets', () => {
    const data = dataset([
      profile(600),
      profile(900, { quantilesCp: [0, 0, 20, 80, 150, 300, 700] })
    ])
    expect(estimateRapidProfile(600, 'all', data)?.quantilesCp[1]).toBe(10)
    expect(estimateRapidProfile(750, 'all', data)?.quantilesCp[1]).toBe(5)
    expect(estimateRapidProfile(900, 'all', data)?.quantilesCp[1]).toBe(0)
    expect(estimateRapidProfile(2400, 'all', data)).toBeNull()
    expect(estimateRapidProfile(500, 'all', data)?.sources.map((s) => s.profile.elo)).toEqual([600])
  })
  it('falls back from sparse phase cells without inventing observations', () => {
    const data = dataset([profile(900), profile(900, { phase: 'opening', players: 2 })])
    const result = estimateRapidProfile(900, 'opening', data)!
    expect(result.phaseSpecific).toBe(false)
    expect(result.sources[0]?.profile.phase).toBe('all')
    expect(estimateRapidProfile(900, 'all', dataset([profile(900, { count: 0 })]))).toBeNull()
  })
  it('rejects invalid distributions and a different time class', () => {
    expect(usableProfile(profile(900, { quantilesCp: [0, 100, 40, 100, 200, 500, 900] }))).toBe(
      false
    )
    expect(usableProfile(profile(900, { lossCounts: [60, 20, 10, 5, 3, 1, 100] }))).toBe(false)
    expect(
      estimateRapidProfile(900, 'all', { ...dataset([profile(900)]), timeClass: 'blitz' })
    ).toBeNull()
    expect(rapidLossAt([0, 0, 20, 60, 100, 300, 600], 0.5)).toBe(0)
    expect(rapidLossAt([0, 0, 20, 60, 100, 300, 600], 0.625)).toBe(10)
    expect(
      estimateRapidProfile(900, 'all', {
        ...dataset([]),
        profiles: null
      } as unknown as RapidDataset)
    ).toBeNull()
    expect(
      rapidOpening(START, 900, { ...dataset([]), openings: null } as unknown as RapidDataset)
    ).toBeNull()
  })
  it('compares the same phase population at both ends of an interpolation', () => {
    const data = dataset([profile(600), profile(900), profile(900, { phase: 'opening' })])
    const estimate = estimateRapidProfile(750, 'opening', data)!
    expect(estimate.sources.map((entry) => entry.profile.phase)).toEqual(['all', 'all'])
  })
  it('uses observed opening moves while excluding illegal or distant-band suggestions', () => {
    const data = dataset([profile(900)])
    data.openings = [
      {
        epd: START.split(' ').slice(0, 4).join(' '),
        elo: 900,
        count: 10,
        moves: [
          { uci: 'e2e4', count: 6 },
          { uci: 'e2e5', count: 4 }
        ]
      }
    ]
    expect(rapidOpening(START, 900, data)?.moves).toEqual([{ uci: 'e2e4', count: 6 }])
    expect(rapidOpening(START, 1800, data)).toBeNull()
    for (const language of ['it', 'en'] as const) {
      const text = rapidContextText(
        { mode: 'fixed', level: 2, targetElo: 900 },
        START,
        language,
        data
      ).join('\n')
      expect(text).toContain('Chess.com Rapid')
      expect(text).toContain('e2e4: 6/10')
      expect(text).not.toContain('e2e5')
      expect(text).toContain(language === 'it' ? 'non una quota di errori' : 'not an error quota')
    }
  })
  it('leaves Maximum unrestricted and handles missing observations explicitly', () => {
    expect(
      rapidContextText(
        { mode: 'fixed', level: 6, targetElo: null },
        START,
        'en',
        dataset([profile(2400)])
      )
    ).toEqual([])
    expect(
      rapidContextText({ mode: 'fixed', level: 2, targetElo: 900 }, START, 'en', dataset([]))
    ).toEqual([])
  })
})
