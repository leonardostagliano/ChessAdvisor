import type { StudyActivityType, StudyPlan, StudyPlanItem } from '@shared/types/training'
import { readJson, writeJsonAtomic } from './atomicWrite'

/**
 * `study-plan.json` (spec §5, `StudyPlan`; spec §6.8).
 *
 * There is exactly one plan at a time: generating a new one replaces it, and `done` is the only
 * thing the user writes into it. `invalidRef` is deliberately *not* stored — it is recomputed
 * every time the plan is read, because what makes a reference invalid (an exercise that is gone,
 * an opening that never came back) happens long after the plan was written.
 */
export class StudyPlanStore {
  private current: StudyPlan | null = null

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    this.current = sanitizePlan(await readJson<unknown>(this.file, null))
  }

  get(): StudyPlan | null {
    return this.current ? clone(this.current) : null
  }

  async save(plan: StudyPlan): Promise<StudyPlan> {
    const stored = clone(plan)
    await writeJsonAtomic(this.file, stored)
    this.current = stored
    return clone(stored)
  }

  /** Ticks one item off; answers the plan unchanged when the id is unknown. */
  async markDone(itemId: string, done = true): Promise<StudyPlan | null> {
    const plan = this.current
    if (!plan) return null
    const item = plan.items.find((entry) => entry.id === itemId)
    if (!item || item.done === done) return clone(plan)
    item.done = done
    return this.save(plan)
  }
}

function clone(plan: StudyPlan): StudyPlan {
  return { generatedAt: plan.generatedAt, items: plan.items.map((item) => ({ ...item, activity: { ...item.activity } })) }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const TYPES = new Set<StudyActivityType>(['thematic', 'own_game', 'opening', 'endgame', 'play'])

/** A file from an older version, or a hand-edited one, must never crash the app. */
export function sanitizePlan(raw: unknown): StudyPlan | null {
  if (!isRecord(raw) || !Array.isArray(raw.items)) return null
  const items: StudyPlanItem[] = []
  for (const [index, value] of raw.items.entries()) {
    if (!isRecord(value)) continue
    const activity = isRecord(value.activity) ? value.activity : {}
    const type = typeof activity.type === 'string' && TYPES.has(activity.type as StudyActivityType) ? (activity.type as StudyActivityType) : null
    if (!type) continue
    const title = typeof value.title === 'string' ? value.title.trim() : ''
    if (title.length === 0) continue
    items.push({
      id: typeof value.id === 'string' && value.id ? value.id : `item-${index + 1}`,
      title,
      why: typeof value.why === 'string' ? value.why.trim() : '',
      activity: { type, ref: typeof activity.ref === 'string' && activity.ref.length > 0 ? activity.ref : null },
      done: value.done === true
    })
  }
  if (items.length === 0) return null
  return { generatedAt: typeof raw.generatedAt === 'string' && raw.generatedAt ? raw.generatedAt : new Date(0).toISOString(), items }
}
