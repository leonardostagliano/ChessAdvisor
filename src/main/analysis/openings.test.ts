import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { detectOpening, loadOpenings, MAX_BOOK_PLIES } from './openings'

/** The dataset that ships with the app: built by `scripts/build-datasets.mjs openings`. */
const DATASET = resolve(__dirname, '../../../resources/data/openings.json')

/** Positions of a game given as SAN moves, starting position included. */
function fensOf(sans: string[]): string[] {
  const chess = new Chess()
  const fens = [chess.fen()]
  for (const san of sans) {
    chess.move(san)
    fens.push(chess.fen())
  }
  return fens
}

describe('loadOpenings', () => {
  it('reads the bundled dataset into a map keyed by EPD', () => {
    const book = loadOpenings(DATASET)
    expect(book.byEpd.size).toBeGreaterThan(3000)
    const [, afterE4] = fensOf(['e4'])
    expect(book.byEpd.get(afterE4!.split(/\s+/).slice(0, 4).join(' '))).toEqual({ eco: 'B00', name: "King's Pawn Game" })
  })

  it('survives a missing or broken file with an empty book', async () => {
    const dir = await makeTmpDir('openings')
    try {
      expect(loadOpenings(join(dir, 'nope.json')).byEpd.size).toBe(0)
      const broken = join(dir, 'broken.json')
      writeFileSync(broken, '{ not json', 'utf8')
      expect(loadOpenings(broken).byEpd.size).toBe(0)
      const wrongShape = join(dir, 'object.json')
      writeFileSync(wrongShape, '{"a":1}', 'utf8')
      expect(loadOpenings(wrongShape).byEpd.size).toBe(0)
    } finally {
      await removeTmpDir(dir)
    }
  })

  it('skips rows that are not openings', async () => {
    const dir = await makeTmpDir('openings')
    try {
      const path = join(dir, 'mixed.json')
      writeFileSync(path, JSON.stringify([{ eco: 'A00', name: 'Fake', epd: 'x' }, { eco: 'A01' }, 42, null]), 'utf8')
      const book = loadOpenings(path)
      expect(book.byEpd.size).toBe(1)
      expect(book.byEpd.get('x')).toEqual({ eco: 'A00', name: 'Fake' })
    } finally {
      await removeTmpDir(dir)
    }
  })
})

describe('detectOpening', () => {
  const book = loadOpenings(DATASET)

  it('names the deepest book position of the game', () => {
    expect(detectOpening(fensOf(['e4', 'e5', 'Nf3']), book)).toEqual({ eco: 'C40', name: "King's Knight Opening", lastBookPly: 3 })
  })

  it('recognises a transposition by position, not by move order', () => {
    const direct = detectOpening(fensOf(['d4', 'Nf6', 'c4', 'e6', 'Nf3']), book)
    const transposed = detectOpening(fensOf(['Nf3', 'Nf6', 'd4', 'e6', 'c4']), book)
    expect(direct).not.toBeNull()
    expect(transposed?.name).toBe(direct?.name)
    expect(transposed?.eco).toBe(direct?.eco)
  })

  it('stops looking after the first twenty plies', () => {
    const book2 = { byEpd: new Map(book.byEpd) }
    const fens = fensOf(['e4', 'e5', 'Nf3'])
    // A position parked past the limit is never reached, even when it is in the book.
    const padded = [...fens, ...Array.from({ length: MAX_BOOK_PLIES }, () => 'nothing'), 'later']
    expect(padded.indexOf('later')).toBeGreaterThan(MAX_BOOK_PLIES)
    book2.byEpd.set('later', { eco: 'Z99', name: 'Too deep' })
    expect(detectOpening(padded, book2)?.eco).toBe('C40')
  })

  it('answers null when nothing matches, and never touches an empty book', () => {
    expect(detectOpening(fensOf(['a3', 'a6', 'h3']), { byEpd: new Map() })).toBeNull()
    expect(detectOpening([], book)).toBeNull()
    expect(detectOpening(fensOf([]), book)).toBeNull()
  })
})
