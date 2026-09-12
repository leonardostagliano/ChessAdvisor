import { describe, expect, it } from 'vitest'
import { parseBestMove, parseInfoLine } from './uci'

describe('parseInfoLine', () => {
  it('parses a centipawn line with multipv and pv', () => {
    const parsed = parseInfoLine(
      'info depth 14 seldepth 20 multipv 2 score cp -35 nodes 123456 nps 900000 hashfull 120 tbhits 0 time 340 pv d2d4 d7d5 c2c4'
    )
    expect(parsed).toEqual({
      multipv: 2,
      depth: 14,
      scoreCp: -35,
      pv: ['d2d4', 'd7d5', 'c2c4']
    })
  })

  it('parses a mate score and keeps the sign', () => {
    const parsed = parseInfoLine('info depth 20 multipv 1 score mate -3 pv h5h7 g8h7 f3f7')
    expect(parsed?.scoreMate).toBe(-3)
    expect(parsed?.scoreCp).toBeUndefined()
    expect(parsed?.pv).toEqual(['h5h7', 'g8h7', 'f3f7'])
  })

  it('defaults multipv to 1 when the engine omits it', () => {
    expect(parseInfoLine('info depth 8 score cp 12 pv e2e4')?.multipv).toBe(1)
  })

  it('keeps promotion moves in the pv verbatim', () => {
    expect(parseInfoLine('info depth 30 multipv 1 score mate 1 pv a7a8q')?.pv).toEqual(['a7a8q'])
  })

  it('ignores currmove, string and bound lines', () => {
    expect(parseInfoLine('info depth 12 currmove e2e4 currmovenumber 1')).toBeNull()
    expect(parseInfoLine('info string NNUE evaluation using nn-1234.nnue')).toBeNull()
    expect(parseInfoLine('info depth 14 multipv 1 score cp 40 lowerbound pv e2e4')).toBeNull()
    expect(parseInfoLine('info depth 14 multipv 1 score cp 40 upperbound pv e2e4')).toBeNull()
  })

  it('returns null for lines without a depth or without a pv', () => {
    expect(parseInfoLine('info nodes 1000 nps 50000 time 20 hashfull 0')).toBeNull()
    expect(parseInfoLine('info depth 12 multipv 1 score cp 40')).toBeNull()
    expect(parseInfoLine('info depth 12 multipv 1 score cp 40 pv')).toBeNull()
  })

  it('ignores non-info lines and blank input', () => {
    expect(parseInfoLine('bestmove e2e4 ponder e7e5')).toBeNull()
    expect(parseInfoLine('readyok')).toBeNull()
    expect(parseInfoLine('   ')).toBeNull()
  })

  it('tolerates leading whitespace, CR and repeated spaces', () => {
    const parsed = parseInfoLine('  info  depth 9   multipv 1  score cp 7  pv  g1f3  g8f6 \r')
    expect(parsed).toEqual({ multipv: 1, depth: 9, scoreCp: 7, pv: ['g1f3', 'g8f6'] })
  })
})

describe('parseBestMove', () => {
  it('extracts the move and drops the ponder move', () => {
    expect(parseBestMove('bestmove e2e4 ponder e7e5')).toBe('e2e4')
  })

  it('accepts a bestmove without ponder and with a promotion', () => {
    expect(parseBestMove('bestmove a7a8q')).toBe('a7a8q')
  })

  it('returns null for (none)', () => {
    expect(parseBestMove('bestmove (none)')).toBeNull()
    expect(parseBestMove('bestmove 0000')).toBeNull()
  })

  it('returns null for any other line', () => {
    expect(parseBestMove('info depth 1 score cp 10 pv e2e4')).toBeNull()
    expect(parseBestMove('uciok')).toBeNull()
    expect(parseBestMove('')).toBeNull()
  })
})
