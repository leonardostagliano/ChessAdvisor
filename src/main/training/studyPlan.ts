import type { EndgamePosition, Exercise, StudyActivityType, StudyCatalogue, StudyPlan, StudyPlanItem, StudyPlanView } from '@shared/types/training'
import { THEMES } from '../profile/themes'
import { PLAN_ACTIVITY_TYPES, PLAN_MAX_ITEMS, PLAN_MIN_ITEMS } from './trainingPrompts'

/**
 * The study plan (spec §6.8).
 *
 * A plan is a list of things to do, and every one of them has to point at material that really
 * exists: a theme of the taxonomy, an exercise waiting to be solved, an opening the user plays, a
 * curated endgame — or nothing at all, which means "go and play a game". That is why the prompt
 * carries an explicit catalogue and the schema pins `activity.ref` to it; and why the answer is
 * validated here anyway, because an `enum` in a schema is a hint and not a guarantee.
 *
 * Validity is checked twice, for two different reasons. On arrival: a reference outside the
 * catalogue is an invention, so the item is dropped, and if too few items survive the generation
 * is repeated once. On every read: a reference that *was* valid can go stale — the exercise was
 * solved and cleaned away, the opening never came back — so the item is kept and marked
 * `invalidRef`, and the screen degrades it to the generic activity of its type.
 */

export { PLAN_MAX_ITEMS, PLAN_MIN_ITEMS }

/** Analysed matches after which the app proposes a fresh plan (spec §6.8). */
export const PLAN_STALE_GAMES = 5
/** Dangling references after which the app proposes a fresh plan (spec §6.8). */
export const PLAN_MAX_INVALID = 2

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The catalogue of everything a plan may point at (spec §6.8): the whole taxonomy, the exercises
 * still to be solved, the openings the profile knows and the curated endgames.
 */
export function buildCatalogue(p: { exercises: Exercise[]; openings: string[]; endgames: EndgamePosition[] }): StudyCatalogue {
  return {
    themes: [...THEMES],
    exercises: p.exercises.filter((exercise) => exercise.status === 'new').map((exercise) => exercise.id),
    openings: [...new Set(p.openings)],
    endgames: p.endgames.map((endgame) => endgame.id)
  }
}

/** The ids a given activity type may point at; `play` points at nothing. */
function refsOf(catalogue: StudyCatalogue, type: StudyActivityType): string[] | null {
  switch (type) {
    case 'thematic':
      return catalogue.themes
    case 'own_game':
      return catalogue.exercises
    case 'opening':
      return catalogue.openings
    case 'endgame':
      return catalogue.endgames
    case 'play':
      return null
  }
}

/** True when the reference of an item still points at something that exists. */
export function isValidRef(catalogue: StudyCatalogue, activity: StudyPlanItem['activity']): boolean {
  const refs = refsOf(catalogue, activity.type)
  if (refs === null) return true
  return activity.ref !== null && refs.includes(activity.ref)
}

/**
 * The items of a freshly generated plan (spec §6.8): whatever came back, made into plan items and
 * stripped of everything that does not exist. Duplicated references are dropped too — a plan that
 * says the same thing twice has four items and three ideas.
 */
export function validatePlanItems(raw: unknown, catalogue: StudyCatalogue): StudyPlanItem[] {
  const rows = isRecord(raw) && Array.isArray(raw.items) ? raw.items : []
  const items: StudyPlanItem[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    if (items.length >= PLAN_MAX_ITEMS) break
    if (!isRecord(row)) continue
    const activity = isRecord(row.activity) ? row.activity : {}
    const type = typeof activity.type === 'string' && (PLAN_ACTIVITY_TYPES as readonly string[]).includes(activity.type) ? (activity.type as StudyActivityType) : null
    if (!type) continue
    const title = typeof row.title === 'string' ? row.title.trim() : ''
    if (title.length === 0) continue

    const ref = typeof activity.ref === 'string' && activity.ref.trim().length > 0 ? activity.ref.trim() : null
    const candidate = { type, ref: type === 'play' ? null : ref }
    // Spec §6.8: an unknown reference is an invention, and the item goes with it.
    if (!isValidRef(catalogue, candidate)) continue
    const key = `${candidate.type}:${candidate.ref ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)

    items.push({
      id: `item-${items.length + 1}`,
      title,
      why: typeof row.why === 'string' ? row.why.trim() : '',
      activity: candidate,
      done: false
    })
  }
  return items
}

/** The plan as it is read: every item carries whether its reference is still good (spec §6.8). */
export function decoratePlan(plan: StudyPlan | null, catalogue: StudyCatalogue): StudyPlan | null {
  if (!plan) return null
  return {
    generatedAt: plan.generatedAt,
    items: plan.items.map((item) => {
      const valid = isValidRef(catalogue, item.activity)
      return { ...item, activity: { ...item.activity }, ...(valid ? {} : { invalidRef: true }) }
    })
  }
}

/**
 * What `training.plan.get()` answers (spec §6.8): the decorated plan and the two reasons to
 * propose a new one — too many analysed games since it was written, or too many dangling
 * references inside it.
 */
export function planView(plan: StudyPlan | null, catalogue: StudyCatalogue, gamesSincePlan: number): StudyPlanView {
  const decorated = decoratePlan(plan, catalogue)
  const invalidRefs = decorated?.items.filter((item) => item.invalidRef).length ?? 0
  return {
    plan: decorated,
    suggestRegenerate: decorated !== null && (gamesSincePlan >= PLAN_STALE_GAMES || invalidRefs > PLAN_MAX_INVALID),
    invalidRefs,
    gamesSincePlan
  }
}
