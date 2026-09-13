import type { EndgamePosition, Exercise, StudyCatalogue, StudyPlan } from '@shared/types/training'
import { describe, expect, it } from 'vitest'
import { THEMES } from '../profile/themes'
import { buildCatalogue, decoratePlan, planView, validatePlanItems, PLAN_MAX_ITEMS, PLAN_STALE_GAMES } from './studyPlan'

const exercise = (id: string, status: Exercise['status']): Exercise => ({
  id,
  kind: 'own_game',
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  sideToMove: 'w',
  solution: ['e2e4'],
  theme: 'fork',
  status,
  attempts: 0,
  createdAt: '2026-03-01T10:00:00.000Z'
})

const endgame = (id: string): EndgamePosition => ({
  id,
  name: { it: 'Finale', en: 'Endgame' },
  fen: '8/8/8/4k3/8/8/8/3QK3 w - - 0 1',
  sideToMove: 'w',
  goal: 'win',
  difficulty: 1,
  theme: 'endgame_technique'
})

const catalogue: StudyCatalogue = buildCatalogue({
  exercises: [exercise('og-g1-7', 'new'), exercise('og-g1-9', 'solved')],
  openings: ['C60', 'C60', 'B20'],
  endgames: [endgame('queen_mate')]
})

describe('buildCatalogue', () => {
  it('offers the whole taxonomy, the unsolved exercises, the openings once and the endgames', () => {
    expect(catalogue.themes).toEqual([...THEMES])
    expect(catalogue.exercises).toEqual(['og-g1-7'])
    expect(catalogue.openings).toEqual(['C60', 'B20'])
    expect(catalogue.endgames).toEqual(['queen_mate'])
  })
})

describe('validatePlanItems', () => {
  const item = (type: string, ref: string | null, title = 'Titolo'): unknown => ({ title, why: 'perché', activity: { type, ref } })

  it('keeps the items whose reference exists', () => {
    const items = validatePlanItems({ items: [item('thematic', 'fork'), item('own_game', 'og-g1-7'), item('play', null)] }, catalogue)
    expect(items.map((entry) => entry.activity.ref)).toEqual(['fork', 'og-g1-7', null])
    expect(items.map((entry) => entry.id)).toEqual(['item-1', 'item-2', 'item-3'])
    expect(items.every((entry) => entry.done === false)).toBe(true)
  })

  it('drops an item whose reference is not in the catalogue', () => {
    const items = validatePlanItems({ items: [item('own_game', 'og-does-not-exist'), item('opening', 'C60'), item('endgame', 'lucena')] }, catalogue)
    expect(items.map((entry) => entry.activity.ref)).toEqual(['C60'])
  })

  it('drops an item with no usable type or title, and a repeated reference', () => {
    const items = validatePlanItems({ items: [item('reading', 'fork'), item('thematic', 'pin', '  '), item('thematic', 'pin'), item('thematic', 'pin')] }, catalogue)
    expect(items).toHaveLength(1)
  })

  it('clamps the number of items', () => {
    const many = Array.from({ length: 12 }, (_, index) => item('thematic', THEMES[index]!))
    expect(validatePlanItems({ items: many }, catalogue)).toHaveLength(PLAN_MAX_ITEMS)
  })

  it('answers nothing for an answer that is not a plan at all', () => {
    expect(validatePlanItems(null, catalogue)).toEqual([])
    expect(validatePlanItems({ items: 'nope' }, catalogue)).toEqual([])
  })
})

describe('decoratePlan and planView', () => {
  const plan: StudyPlan = {
    generatedAt: '2026-03-02T09:00:00.000Z',
    items: [
      { id: 'item-1', title: 'Tattica', why: '', activity: { type: 'thematic', ref: 'fork' }, done: false },
      { id: 'item-2', title: 'Esercizio', why: '', activity: { type: 'own_game', ref: 'og-gone-3' }, done: false },
      { id: 'item-3', title: 'Gioca', why: '', activity: { type: 'play', ref: null }, done: true }
    ]
  }

  it('marks the references that went stale, and only those', () => {
    const decorated = decoratePlan(plan, catalogue)!
    expect(decorated.items.map((item) => item.invalidRef)).toEqual([undefined, true, undefined])
  })

  it('proposes a new plan when too many games were analysed since', () => {
    expect(planView(plan, catalogue, PLAN_STALE_GAMES - 1).suggestRegenerate).toBe(false)
    expect(planView(plan, catalogue, PLAN_STALE_GAMES).suggestRegenerate).toBe(true)
  })

  it('proposes a new plan when more than two references are dangling', () => {
    const stale: StudyPlan = {
      generatedAt: plan.generatedAt,
      items: ['a', 'b', 'c'].map((ref, index) => ({
        id: `item-${index + 1}`,
        title: ref,
        why: '',
        activity: { type: 'own_game' as const, ref: `og-${ref}` },
        done: false
      }))
    }
    const view = planView(stale, catalogue, 0)
    expect(view.invalidRefs).toBe(3)
    expect(view.suggestRegenerate).toBe(true)
  })

  it('never proposes anything when there is no plan at all', () => {
    expect(planView(null, catalogue, 99)).toEqual({ plan: null, suggestRegenerate: false, invalidRefs: 0, gamesSincePlan: 99 })
  })
})
