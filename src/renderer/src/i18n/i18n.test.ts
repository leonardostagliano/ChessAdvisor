import { describe, expect, it } from 'vitest'
import { PROMOTION_ROLES } from '@renderer/board/Board'
import enResource from './en.json'
import itResource from './it.json'

const flat = (o: object, p = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' && v ? flat(v as object, `${p}${k}.`) : [`${p}${k}`]
  )

const values = (o: object): string[] =>
  Object.values(o).flatMap((v) => (typeof v === 'object' && v ? values(v as object) : [String(v)]))

describe('i18n resources', () => {
  it('it and en expose the same keys', () => {
    expect(flat(itResource).sort()).toEqual(flat(enResource).sort())
  })

  it('exposes the initial key set required by the shell', () => {
    const keys = flat(itResource)
    for (const key of [
      'rail.play',
      'rail.training',
      'rail.progress',
      'rail.settings',
      'empty.training.title',
      'empty.training.body',
      'empty.progress.title',
      'empty.progress.body',
      'settings.title',
      'common.close',
      'common.cancel',
      'common.confirm',
      'common.retry'
    ]) {
      expect(keys).toContain(key)
    }
  })

  it('has no empty string in either language', () => {
    expect(values(itResource).filter((v) => v.trim() === '')).toEqual([])
    expect(values(enResource).filter((v) => v.trim() === '')).toEqual([])
  })

  // The shortcuts sheet names the promotion pieces in the order keys 1-4 pick them, which is the
  // order of the promotion column itself (PROMOTION_ROLES). If the column is ever reordered, the
  // help text has to follow, so read the expected order out of PROMOTION_ROLES rather than repeat it.
  it.each([
    ['it', itResource],
    ['en', enResource]
  ])('describes the promotion keys in board order (%s)', (_language, resource) => {
    const sentence = resource.shortcuts.promotion.toLowerCase()
    const positions = PROMOTION_ROLES.map(({ role }) => {
      const piece = resource.board.promotion[role].toLowerCase()
      const at = sentence.indexOf(piece)
      expect(at, `${piece} is missing from the promotion shortcut text`).toBeGreaterThanOrEqual(0)
      return at
    })
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })
})
