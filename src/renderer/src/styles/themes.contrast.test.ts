import { describe, expect, it } from 'vitest'
// The contrast checker is the plain ESM module the shell script runs.
import {
  REQUIREMENTS,
  checkContrast,
  contrastRatio,
  failures
} from '../../../../scripts/check-contrast.mjs'

/**
 * Spec §7 asks for 4.5:1 on text and 3:1 on graphic elements, on both palettes. The check itself
 * lives in `scripts/check-contrast.mjs` so it can also be run from a terminal; this test runs the
 * very same function against the very same `themes.css`, which makes a token that breaks the
 * contrast a failing test rather than something noticed by eye.
 */

interface Row {
  theme: string
  fg: string
  bg: string
  ratio: number
  min: number
  ok: boolean
}

describe('palette contrast', () => {
  it('computes the WCAG ratio of known pairs', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 5)
    expect(contrastRatio('#000000', '#000000')).toBeCloseTo(1, 5)
    // Symmetric, and blind to the case of the digits.
    expect(contrastRatio('#E8E6E1', '#141517')).toBeCloseTo(contrastRatio('#141517', '#e8e6e1'), 5)
  })

  it('keeps every pair of both palettes above its minimum', () => {
    const rows = checkContrast() as Row[]
    expect(rows).toHaveLength(REQUIREMENTS.length * 2)
    expect(
      failures(rows).map((row: Row) => `${row.theme} ${row.fg} on ${row.bg} = ${row.ratio}`)
    ).toEqual([])
  })

  it('checks both palettes, text and graphic thresholds alike', () => {
    const rows = checkContrast() as Row[]
    expect(new Set(rows.map((row) => row.theme))).toEqual(new Set(['night', 'editorial']))
    expect(new Set(rows.map((row) => row.min))).toEqual(new Set([4.5, 3]))
  })
})
