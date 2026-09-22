import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { StudyPlanStore, sanitizePlan } from './studyPlanStore'
import { writeJsonAtomic } from './atomicWrite'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('StudyPlanStore', () => {
  let root: string
  let store: StudyPlanStore

  beforeEach(async () => {
    root = await makeTmpDir()
    store = new StudyPlanStore(join(root, 'study-plan.json'))
    await store.load()
  })

  afterEach(async () => {
    await removeTmpDir(root)
  })

  const plan = {
    generatedAt: '2026-03-02T09:00:00.000Z',
    items: [
      {
        id: 'item-1',
        title: 'Tattica',
        why: 'perché',
        activity: { type: 'thematic' as const, ref: 'fork' },
        done: false
      },
      {
        id: 'item-2',
        title: 'Gioca',
        why: '',
        activity: { type: 'play' as const, ref: null },
        done: false
      }
    ]
  }

  it('has no plan until one is written', () => {
    expect(store.get()).toBeNull()
  })

  it('saves the plan and reads it back from disk', async () => {
    await store.save(plan)
    const reopened = new StudyPlanStore(join(root, 'study-plan.json'))
    await reopened.load()
    expect(reopened.get()).toEqual(plan)
  })

  it('serializes concurrent saves so a slow older plan cannot overwrite the newer one', async () => {
    const file = join(root, 'concurrent-study-plan.json')
    const started = deferred()
    const release = deferred()
    let writes = 0
    const delayedWrite: typeof writeJsonAtomic = async (path, value) => {
      writes += 1
      if (writes === 1) {
        started.resolve()
        await release.promise
      }
      await writeJsonAtomic(path, value)
    }
    const concurrent = new StudyPlanStore(file, delayedWrite)
    await concurrent.load()

    const first = concurrent.save(plan)
    await started.promise
    const newer = { ...plan, generatedAt: '2026-03-03T09:00:00.000Z' }
    const second = concurrent.save(newer)
    release.resolve()
    await Promise.all([first, second])

    const reopened = new StudyPlanStore(file)
    await reopened.load()
    expect(reopened.get()).toEqual(newer)
  })

  it('ticks one item off and leaves the others alone', async () => {
    await store.save(plan)
    const updated = await store.markDone('item-2')
    expect(updated?.items.map((item) => item.done)).toEqual([false, true])
    expect((await store.markDone('nothing'))?.items.map((item) => item.done)).toEqual([false, true])
  })

  it('answers null when there is no plan to tick off', async () => {
    expect(await store.markDone('item-1')).toBeNull()
  })

  it('drops the items of a broken file and the file itself when nothing is left', () => {
    expect(
      sanitizePlan({ items: [{ title: 'ok', activity: { type: 'play', ref: null } }] })?.items
    ).toHaveLength(1)
    expect(
      sanitizePlan({ items: [{ title: 'ok', activity: { type: 'reading', ref: null } }] })
    ).toBeNull()
    expect(sanitizePlan('nope')).toBeNull()
  })
})
