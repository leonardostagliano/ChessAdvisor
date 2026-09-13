import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { THEME_MAP as LIBRARY_THEME_MAP } from '../src/main/data/puzzleLibrary'
import {
  ENDGAMES,
  eligiblePuzzle,
  epdOfPgn,
  mapPuzzleThemes,
  parsePuzzleRow,
  parseTsv,
  primaryTheme,
  PUZZLE_FILTERS,
  PUZZLE_THEME_MAP,
  ratingBucket,
  selectPuzzles,
  toPuzzle,
  validateEndgames
} from './build-datasets.mjs'

/** A real row of `lichess_db_puzzle.csv`, header order included. */
const ROW =
  '00008,r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24,f2g3 e6e7 b2b1 b3c1 b1c1 h6c1,1913,75,94,6157,crushing hangingPiece long middlegame,https://lichess.org/787zsVup/black#48,'

const row = (over = {}) => ({
  id: 'x1',
  fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
  moves: ['f2g3', 'e6e7', 'b2b1', 'b3c1'],
  rating: 1200,
  popularity: 90,
  nbPlays: 500,
  themes: ['fork', 'middlegame'],
  ...over
})

describe('parsePuzzleRow', () => {
  it('reads the eight fields the app needs from a CSV line', () => {
    expect(parsePuzzleRow(ROW)).toEqual({
      id: '00008',
      fen: 'r6k/pp2r2p/4Rp1Q/3p4/8/1N1P2R1/PqP2bPP/7K b - - 0 24',
      moves: ['f2g3', 'e6e7', 'b2b1', 'b3c1', 'b1c1', 'h6c1'],
      rating: 1913,
      popularity: 94,
      nbPlays: 6157,
      themes: ['crushing', 'hangingPiece', 'long', 'middlegame']
    })
  })

  it('ignores the header, blank lines and truncated rows', () => {
    expect(parsePuzzleRow('PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags')).toBeNull()
    expect(parsePuzzleRow('')).toBeNull()
    expect(parsePuzzleRow('00008,r6k/8 w - - 0 1,e2e4')).toBeNull()
    expect(parsePuzzleRow('00008,r6k/8 w - - 0 1,e2e4,abc,75,94,6157,fork,url,')).toBeNull()
  })
})

describe('mapPuzzleThemes', () => {
  it('translates the lichess vocabulary into the app taxonomy and drops the rest', () => {
    expect(mapPuzzleThemes(['crushing', 'hangingPiece', 'long', 'middlegame'])).toEqual(['hanging_piece'])
    expect(mapPuzzleThemes(['backRankMate', 'mateIn2'])).toEqual(['back_rank', 'missed_tactic'])
    expect(mapPuzzleThemes(['rookEndgame', 'endgame'])).toEqual(['endgame_technique'])
    expect(mapPuzzleThemes(['advantage', 'short'])).toEqual([])
  })

  it('answers in taxonomy order whatever the order of the source row', () => {
    expect(mapPuzzleThemes(['skewer', 'fork'])).toEqual(mapPuzzleThemes(['fork', 'skewer']))
  })
})

describe('the theme map', () => {
  it('is the same table the runtime library exports', () => {
    expect(PUZZLE_THEME_MAP).toEqual(LIBRARY_THEME_MAP)
  })
})

describe('eligiblePuzzle', () => {
  it('keeps a popular, well-played puzzle inside the rating window carrying a known theme', () => {
    expect(eligiblePuzzle(row())).toBe(true)
  })

  it('rejects everything outside the selection rules of the spec', () => {
    expect(eligiblePuzzle(row({ rating: PUZZLE_FILTERS.ratingMin - 1 }))).toBe(false)
    expect(eligiblePuzzle(row({ rating: PUZZLE_FILTERS.ratingMax + 1 }))).toBe(false)
    expect(eligiblePuzzle(row({ popularity: PUZZLE_FILTERS.popularityMin - 1 }))).toBe(false)
    expect(eligiblePuzzle(row({ nbPlays: PUZZLE_FILTERS.playsMin - 1 }))).toBe(false)
    expect(eligiblePuzzle(row({ themes: ['advantage'] }))).toBe(false)
    expect(eligiblePuzzle(row({ moves: ['f2g3'] }))).toBe(false)
  })

  it('accepts the boundaries themselves', () => {
    expect(eligiblePuzzle(row({ rating: PUZZLE_FILTERS.ratingMin }))).toBe(true)
    expect(eligiblePuzzle(row({ rating: PUZZLE_FILTERS.ratingMax }))).toBe(true)
    expect(eligiblePuzzle(row({ popularity: PUZZLE_FILTERS.popularityMin, nbPlays: PUZZLE_FILTERS.playsMin }))).toBe(true)
  })
})

describe('toPuzzle', () => {
  it('applies the opponent premove so the record starts at the position the user sees', () => {
    const parsed = parsePuzzleRow(ROW)
    const puzzle = toPuzzle(parsed)
    const board = new Chess(parsed.fen)
    board.move({ from: 'f2', to: 'g3' })
    expect(puzzle).toEqual({
      id: '00008',
      fen: board.fen(),
      sideToMove: 'w',
      solution: ['e6e7', 'b2b1', 'b3c1', 'b1c1', 'h6c1'],
      rating: 1913,
      themes: ['hanging_piece'],
      source: 'lichess'
    })
  })

  it('answers null when the premove does not fit the position', () => {
    expect(toPuzzle(row({ moves: ['a1a8', 'e6e7'] }))).toBeNull()
    expect(toPuzzle(row({ fen: 'not a fen' }))).toBeNull()
  })
})

describe('ratingBucket', () => {
  it('floors the rating to a hundred', () => {
    expect(ratingBucket(400)).toBe(400)
    expect(ratingBucket(1499)).toBe(1400)
    expect(ratingBucket(2200)).toBe(2200)
  })
})

describe('selectPuzzles', () => {
  const many = (theme, bucket, n) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${theme}-${bucket}-${i}`,
      fen: '8/8/8/8/8/8/8/8 w - - 0 1',
      sideToMove: 'w',
      solution: ['e2e4'],
      rating: bucket + 10,
      themes: [theme],
      source: 'lichess'
    }))

  it('spreads the quota over the rating buckets and the themes instead of taking the first rows', () => {
    const pool = [...many('fork', 800, 100), ...many('pin', 800, 100), ...many('fork', 1500, 100)]
    const picked = selectPuzzles(pool, 30)
    expect(picked).toHaveLength(30)
    const cells = new Map()
    for (const p of picked) {
      const key = `${ratingBucket(p.rating)}|${primaryTheme(p.themes)}`
      cells.set(key, (cells.get(key) ?? 0) + 1)
    }
    expect([...cells.keys()].sort()).toEqual(['1500|fork', '800|fork', '800|pin'])
    expect([...cells.values()]).toEqual([10, 10, 10])
  })

  it('takes everything available when the pool is smaller than the target, without duplicates', () => {
    const pool = [...many('fork', 800, 3), ...many('pin', 1200, 2)]
    const picked = selectPuzzles(pool, 100)
    expect(picked).toHaveLength(5)
    expect(new Set(picked.map((p) => p.id)).size).toBe(5)
  })

  it('is deterministic', () => {
    const pool = [...many('fork', 800, 40), ...many('skewer', 1900, 40)]
    expect(selectPuzzles(pool, 17).map((p) => p.id)).toEqual(selectPuzzles(pool, 17).map((p) => p.id))
  })
})

describe('the curated endgames', () => {
  it('ships twenty positions with unique ids and both languages', () => {
    expect(ENDGAMES).toHaveLength(20)
    expect(new Set(ENDGAMES.map((e) => e.id)).size).toBe(20)
    for (const endgame of ENDGAMES) {
      expect(endgame.name.it.length).toBeGreaterThan(0)
      expect(endgame.name.en.length).toBeGreaterThan(0)
      expect(['win', 'draw']).toContain(endgame.goal)
      expect([1, 2, 3]).toContain(endgame.difficulty)
      expect(typeof endgame.theme).toBe('string')
    }
  })

  it('only carries positions chess.js can play, with the declared side to move', () => {
    expect(validateEndgames(ENDGAMES)).toBe(ENDGAMES)
    for (const endgame of ENDGAMES) {
      const board = new Chess(endgame.fen)
      expect(board.turn()).toBe(endgame.sideToMove)
      expect(board.moves().length).toBeGreaterThan(0)
    }
  })

  it('refuses a broken position instead of writing it to the dataset', () => {
    expect(() => validateEndgames([{ ...ENDGAMES[0], fen: 'not a fen' }])).toThrow(/fen/i)
    expect(() => validateEndgames([{ ...ENDGAMES[0], sideToMove: ENDGAMES[0].sideToMove === 'w' ? 'b' : 'w' }])).toThrow(/side to move/i)
  })
})

describe('the openings helpers still answer', () => {
  it('parses a TSV row and computes its EPD', () => {
    const rows = parseTsv('eco\tname\tpgn\nB00\tKing\'s Pawn Game\t1. e4\n')
    expect(rows).toEqual([{ eco: 'B00', name: "King's Pawn Game", pgn: '1. e4' }])
    expect(epdOfPgn('1. e4')).toBe('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -')
  })
})
