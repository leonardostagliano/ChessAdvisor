import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { THEMES } from '@main/profile/themes'
import type { EndgamePosition, Puzzle } from '@shared/types/training'
import { makeTmpDir, removeTmpDir, withTmpDir } from '../../../test/helpers/tmpDir'
import { PuzzleLibrary, THEME_MAP } from './puzzleLibrary'

/** The datasets that ship with the app: built by `scripts/build-datasets.mjs`. */
const RESOURCES = resolve(__dirname, '../../../resources/data')

const puzzle = (over: Partial<Puzzle> = {}): Puzzle => ({
  id: 'p1',
  fen: 'r6k/pp2r2p/4R2Q/3p4/8/1N1P2p1/PqP2bPP/7K w - - 0 25',
  sideToMove: 'w',
  solution: ['e6e7', 'b2b1'],
  rating: 1200,
  themes: ['fork'],
  source: 'lichess',
  ...over
})

const endgame = (over: Partial<EndgamePosition> = {}): EndgamePosition => ({
  id: 'lucena',
  name: { it: 'Lucena', en: 'Lucena' },
  fen: '1K6/1P1k4/8/8/8/8/r7/2R5 w - - 0 1',
  sideToMove: 'w',
  goal: 'win',
  difficulty: 3,
  theme: 'endgame_technique',
  ...over
})

/** Resolves `resourcePath('data', <file>)` inside a fixture directory. */
const pathIn =
  (dir: string) =>
  (...segs: string[]): string =>
    join(dir, segs[segs.length - 1] ?? '')

/** A library backed by the fixtures written into `dir`. */
async function libraryOf(dir: string, puzzles: unknown, endgames: unknown): Promise<PuzzleLibrary> {
  writeFileSync(join(dir, 'puzzles.json'), JSON.stringify(puzzles), 'utf8')
  writeFileSync(join(dir, 'endgames.json'), JSON.stringify(endgames), 'utf8')
  const library = new PuzzleLibrary(pathIn(dir))
  await library.load()
  return library
}

describe('THEME_MAP', () => {
  it('only ever answers with a theme of the fixed taxonomy', () => {
    for (const theme of Object.values(THEME_MAP)) expect(THEMES).toContain(theme)
  })
})

describe('load', () => {
  it('reads the two datasets', async () => {
    await withTmpDir(async (dir) => {
      const library = await libraryOf(
        dir,
        [puzzle(), puzzle({ id: 'p2', rating: 1500 })],
        [endgame()]
      )
      expect(library.size).toBe(2)
      expect(library.endgames()).toHaveLength(1)
      expect(library.get('p2')?.rating).toBe(1500)
      expect(library.get('nope')).toBeNull()
    })
  })

  it('drops the rows that are not usable instead of failing', async () => {
    await withTmpDir(async (dir) => {
      const library = await libraryOf(
        dir,
        [
          puzzle(),
          { ...puzzle({ id: 'no-solution' }), solution: [] },
          { ...puzzle({ id: 'no-fen' }), fen: 42 },
          { ...puzzle({ id: 'unknown-theme' }), themes: ['zugzwang'] },
          'nonsense'
        ],
        [endgame(), { ...endgame({ id: 'bad-goal' }), goal: 'lose' }]
      )
      expect(library.size).toBe(1)
      expect(library.get('unknown-theme')).toBeNull()
      expect(library.endgames().map((e) => e.id)).toEqual(['lucena'])
    })
  })

  it('survives a missing or broken file with an empty library', async () => {
    const dir = await makeTmpDir('puzzles')
    try {
      const empty = new PuzzleLibrary(pathIn(dir))
      await empty.load()
      expect(empty.size).toBe(0)
      expect(empty.endgames()).toEqual([])
      expect(empty.themes()).toEqual([])

      writeFileSync(join(dir, 'puzzles.json'), '{ not json', 'utf8')
      writeFileSync(join(dir, 'endgames.json'), '{"a":1}', 'utf8')
      const broken = new PuzzleLibrary(pathIn(dir))
      await broken.load()
      expect(broken.size).toBe(0)
      expect(broken.endgames()).toEqual([])
    } finally {
      await removeTmpDir(dir)
    }
  })
})

describe('themes', () => {
  it('counts the puzzles of every theme, most frequent first', async () => {
    await withTmpDir(async (dir) => {
      const library = await libraryOf(
        dir,
        [
          puzzle({ id: 'a', themes: ['fork'] }),
          puzzle({ id: 'b', themes: ['fork', 'pin'] }),
          puzzle({ id: 'c', themes: ['pin'] }),
          puzzle({ id: 'd', themes: ['fork'] })
        ],
        []
      )
      expect(library.themes()).toEqual([
        { theme: 'fork', count: 3 },
        { theme: 'pin', count: 2 }
      ])
    })
  })
})

describe('pick', () => {
  const pool = (): Puzzle[] => [
    ...Array.from({ length: 20 }, (_, i) =>
      puzzle({ id: `fork-${i}`, rating: 800 + i * 10, themes: ['fork'] })
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      puzzle({ id: `pin-${i}`, rating: 1600 + i * 10, themes: ['pin'] })
    )
  ]

  it('answers puzzles of the theme inside the rating window, sorted from the easiest', async () => {
    await withTmpDir(async (dir) => {
      const library = await libraryOf(dir, pool(), [])
      const picked = library.pick({
        theme: 'fork',
        ratingMin: 800,
        ratingMax: 900,
        exclude: new Set(),
        count: 5,
        seed: 7
      })
      expect(picked).toHaveLength(5)
      for (const p of picked) {
        expect(p.themes).toContain('fork')
        expect(p.rating).toBeGreaterThanOrEqual(800)
        expect(p.rating).toBeLessThanOrEqual(900)
      }
      expect(picked.map((p) => p.rating)).toEqual(
        [...picked.map((p) => p.rating)].sort((a, b) => a - b)
      )
    })
  })

  it('never answers an excluded puzzle and never repeats one', async () => {
    await withTmpDir(async (dir) => {
      const library = await libraryOf(dir, pool(), [])
      const exclude = new Set(['fork-0', 'fork-1', 'fork-2'])
      const picked = library.pick({
        theme: 'fork',
        ratingMin: 0,
        ratingMax: 3000,
        exclude,
        count: 10,
        seed: 3
      })
      expect(picked).toHaveLength(10)
      expect(picked.some((p) => exclude.has(p.id))).toBe(false)
      expect(new Set(picked.map((p) => p.id)).size).toBe(10)
    })
  })

  it('is deterministic for a seed and varies with it', async () => {
    await withTmpDir(async (dir) => {
      const library = await libraryOf(dir, pool(), [])
      const ids = (seed: number): string[] =>
        library
          .pick({
            theme: 'fork',
            ratingMin: 0,
            ratingMax: 3000,
            exclude: new Set(),
            count: 6,
            seed
          })
          .map((p) => p.id)
      expect(ids(11)).toEqual(ids(11))
      expect(ids(11)).not.toEqual(ids(12))
    })
  })

  it('answers fewer puzzles than asked rather than widening the window', async () => {
    await withTmpDir(async (dir) => {
      const library = await libraryOf(dir, pool(), [])
      expect(
        library.pick({
          theme: 'fork',
          ratingMin: 2500,
          ratingMax: 2600,
          exclude: new Set(),
          count: 10,
          seed: 1
        })
      ).toEqual([])
      expect(
        library.pick({
          theme: 'skewer',
          ratingMin: 0,
          ratingMax: 3000,
          exclude: new Set(),
          count: 10,
          seed: 1
        })
      ).toEqual([])
    })
  })
})

describe('the bundled datasets', () => {
  const bundled = async (): Promise<PuzzleLibrary> => {
    const library = new PuzzleLibrary(pathIn(RESOURCES))
    await library.load()
    return library
  }

  it('carry several thousand puzzles spread over the rating window', async () => {
    const library = await bundled()
    expect(library.size).toBeGreaterThan(5000)
    const themes = library.themes()
    expect(themes.length).toBeGreaterThan(4)
    const easy = library.pick({
      theme: themes[0]!.theme,
      ratingMin: 400,
      ratingMax: 800,
      exclude: new Set(),
      count: 3,
      seed: 1
    })
    const hard = library.pick({
      theme: themes[0]!.theme,
      ratingMin: 1800,
      ratingMax: 2200,
      exclude: new Set(),
      count: 3,
      seed: 1
    })
    expect(easy.length).toBe(3)
    expect(hard.length).toBe(3)
  })

  it('start at the position the user has to solve, with a legal first solution move', async () => {
    const library = await bundled()
    const sample = library.pick({
      theme: 'fork',
      ratingMin: 400,
      ratingMax: 2200,
      exclude: new Set(),
      count: 20,
      seed: 42
    })
    expect(sample.length).toBe(20)
    for (const p of sample) {
      const board = new Chess(p.fen)
      expect(board.turn()).toBe(p.sideToMove)
      const first = p.solution[0]!
      expect(
        board.moves({ verbose: true }).some((m) => `${m.from}${m.to}${m.promotion ?? ''}` === first)
      ).toBe(true)
    }
  })

  it('carry the twenty curated endgames, all of them legal positions', async () => {
    const library = await bundled()
    const endgames = library.endgames()
    expect(endgames).toHaveLength(20)
    for (const e of endgames) {
      const board = new Chess(e.fen)
      expect(board.turn()).toBe(e.sideToMove)
      expect(board.moves().length).toBeGreaterThan(0)
      expect(e.name.it.length).toBeGreaterThan(0)
      expect(e.name.en.length).toBeGreaterThan(0)
    }
  })
})
