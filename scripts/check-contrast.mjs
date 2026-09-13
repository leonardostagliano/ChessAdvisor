#!/usr/bin/env node
/**
 * Contrast check of both palettes (spec §7: 4.5:1 for text, 3:1 for graphic elements).
 *
 * The values are read from `src/renderer/src/styles/themes.css` itself, so the check can never
 * drift from what the app paints: a token changed there is checked here on the next run. The
 * module exports its functions so the unit suite runs the same check (`themes.contrast.test.ts`),
 * and `node scripts/check-contrast.mjs` prints the table and fails the shell on a violation.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const THEMES_CSS = join(ROOT, 'src', 'renderer', 'src', 'styles', 'themes.css')

/** Minimum ratio for text and for graphic elements (WCAG 2.1 AA, spec §7). */
export const TEXT_MIN = 4.5
export const GRAPHIC_MIN = 3

/**
 * Every pair the app actually paints. `fg` over `bg`, both as token names.
 * `min` says which of the two thresholds the pair has to clear.
 */
export const REQUIREMENTS = [
  { fg: '--text', bg: '--bg', min: TEXT_MIN },
  { fg: '--text', bg: '--bg-2', min: TEXT_MIN },
  { fg: '--text', bg: '--bg-3', min: TEXT_MIN },
  { fg: '--text', bg: '--surface', min: TEXT_MIN },
  { fg: '--text', bg: '--surface-2', min: TEXT_MIN },
  { fg: '--text-2', bg: '--bg', min: TEXT_MIN },
  { fg: '--text-2', bg: '--surface', min: TEXT_MIN },
  { fg: '--text-2', bg: '--surface-2', min: TEXT_MIN },
  { fg: '--text-3', bg: '--bg', min: TEXT_MIN },
  { fg: '--text-3', bg: '--surface', min: TEXT_MIN },
  { fg: '--accent', bg: '--bg', min: TEXT_MIN },
  { fg: '--accent', bg: '--surface', min: TEXT_MIN },
  { fg: '--on-accent', bg: '--accent', min: TEXT_MIN },
  { fg: '--text-3', bg: '--surface-2', min: TEXT_MIN },
  { fg: '--danger', bg: '--bg', min: TEXT_MIN },
  { fg: '--danger', bg: '--surface', min: TEXT_MIN },
  { fg: '--danger', bg: '--surface-2', min: TEXT_MIN },
  // The danger button fills itself on hover and writes the page background over it.
  { fg: '--bg', bg: '--danger', min: TEXT_MIN },
  // Graphic: the eval colours are bars, dots and markers, never body text.
  { fg: '--eval-good', bg: '--bg', min: GRAPHIC_MIN },
  { fg: '--eval-good', bg: '--surface', min: GRAPHIC_MIN },
  { fg: '--eval-bad', bg: '--bg', min: GRAPHIC_MIN },
  { fg: '--eval-bad', bg: '--surface', min: GRAPHIC_MIN },
  { fg: '--accent', bg: '--surface-2', min: GRAPHIC_MIN }
  // Borders are not in the list: they only separate surfaces that already differ in colour, and
  // nothing is ever understood from a border alone (spec §7 asks for a non-chromatic cue for
  // everything that carries meaning).
]

const BLOCKS = {
  night: /:root\[data-theme='night'\]\s*\{([^}]*)\}/,
  editorial: /:root\[data-theme='editorial'\]\s*\{([^}]*)\}/
}

/** `{ night: { '--text': '#e8e6e1', … }, editorial: { … } }` read from the stylesheet. */
export function parsePalettes(css) {
  // Comments are dropped first: a note next to a token would otherwise be read as part of it.
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const palettes = {}
  for (const [name, pattern] of Object.entries(BLOCKS)) {
    const body = pattern.exec(clean)?.[1]
    if (!body) throw new Error(`themes.css has no ${name} palette`)
    const tokens = {}
    for (const line of body.split(';')) {
      const match = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(line)
      if (match) tokens[match[1]] = match[2]
    }
    palettes[name] = tokens
  }
  return palettes
}

/** `#rgb` or `#rrggbb` to the three channels, 0–255. */
export function parseHex(value) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(value).trim())
  if (!hex) throw new Error(`not a hexadecimal colour: ${value}`)
  const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d).join('') : hex[1]
  return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16))
}

/** Relative luminance (WCAG 2.1). */
export function luminance(color) {
  const [r, g, b] = parseHex(color).map((channel) => {
    const c = channel / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** Contrast ratio between two colours, 1…21. */
export function contrastRatio(a, b) {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (high + 0.05) / (low + 0.05)
}

/** One row per pair and per palette, rounded to two decimals. */
export function checkContrast(css = readFileSync(THEMES_CSS, 'utf8')) {
  const palettes = parsePalettes(css)
  const rows = []
  for (const [theme, tokens] of Object.entries(palettes)) {
    for (const { fg, bg, min } of REQUIREMENTS) {
      const foreground = tokens[fg]
      const background = tokens[bg]
      if (!foreground || !background) throw new Error(`${theme} has no ${foreground ? bg : fg}`)
      const ratio = Math.round(contrastRatio(foreground, background) * 100) / 100
      rows.push({ theme, fg, bg, ratio, min, ok: ratio >= min })
    }
  }
  return rows
}

/** The pairs that do not clear their threshold. */
export function failures(rows = checkContrast()) {
  return rows.filter((row) => !row.ok)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rows = checkContrast()
  for (const row of rows) {
    const mark = row.ok ? 'ok  ' : 'FAIL'
    console.log(
      `${mark} ${row.theme.padEnd(9)} ${row.fg.padEnd(12)} on ${row.bg.padEnd(12)} ${row.ratio.toFixed(2)} (min ${row.min})`
    )
  }
  const bad = failures(rows)
  console.log(
    bad.length === 0
      ? `\n${rows.length} pairs checked, all above the minimum.`
      : `\n${bad.length} pair(s) below the minimum.`
  )
  process.exit(bad.length === 0 ? 0 : 1)
}
