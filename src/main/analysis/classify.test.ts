import { describe, expect, it } from 'vitest'
import { classify } from './classify'

const move = (
  loss: number,
  patch: Partial<Parameters<typeof classify>[0]> = {}
): ReturnType<typeof classify> =>
  classify({ loss, playedUci: 'e2e4', bestUci: 'd2d4', inBook: false, ...patch })

describe('classify', () => {
  it('calls a theoretical move book, whatever it cost', () => {
    expect(move(0, { inBook: true })).toBe('book')
    expect(move(40, { inBook: true })).toBe('book')
  })

  it('calls the engine’s own first choice best, outside the book', () => {
    expect(move(0, { playedUci: 'd2d4', bestUci: 'd2d4' })).toBe('best')
    expect(move(0, { playedUci: 'd2d4', bestUci: 'd2d4', inBook: true })).toBe('book')
  })

  it('puts the boundaries exactly where the spec does', () => {
    expect(move(0)).toBe('excellent')
    expect(move(1.99)).toBe('excellent')
    expect(move(2)).toBe('good')
    expect(move(5)).toBe('good')
    // 5 to 10 deliberately stays good.
    expect(move(9.99)).toBe('good')
    expect(move(10)).toBe('inaccuracy')
    expect(move(19.99)).toBe('inaccuracy')
    expect(move(20)).toBe('mistake')
    expect(move(29.99)).toBe('mistake')
    expect(move(30)).toBe('blunder')
    expect(move(80)).toBe('blunder')
  })

  it('treats a nonsensical loss as no loss at all', () => {
    expect(move(-5)).toBe('excellent')
    expect(move(Number.NaN)).toBe('excellent')
  })
})
