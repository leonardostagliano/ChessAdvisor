import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Exercise } from '@shared/types/training'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { ExerciseStore, sanitizeExercise } from './exerciseStore'

const exercise = (id: string, patch: Partial<Exercise> = {}): Exercise => ({
  id,
  kind: 'thematic',
  fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  sideToMove: 'w',
  solution: ['e2e4', 'e7e5'],
  theme: 'fork',
  status: 'new',
  attempts: 0,
  createdAt: '2026-03-01T10:00:00.000Z',
  ...patch
})

describe('ExerciseStore', () => {
  let root: string
  let store: ExerciseStore

  beforeEach(async () => {
    root = await makeTmpDir()
    store = new ExerciseStore(join(root, 'exercises.json'))
    await store.load()
  })

  afterEach(async () => {
    await removeTmpDir(root)
  })

  it('starts empty and survives a file that is not there', () => {
    expect(store.list()).toEqual([])
    expect(store.get('nothing')).toBeNull()
  })

  it('writes, reads back and never duplicates an id', async () => {
    await store.put(exercise('tac-1'))
    await store.put(exercise('tac-1', { attempts: 2 }))
    const reopened = new ExerciseStore(join(root, 'exercises.json'))
    await reopened.load()
    expect(reopened.list()).toHaveLength(1)
    expect(reopened.get('tac-1')?.attempts).toBe(2)
  })

  it('lists the newest first and filters by kind', async () => {
    await store.putMany([
      exercise('tac-1', { createdAt: '2026-03-01T10:00:00.000Z' }),
      exercise('og-1', { kind: 'own_game', createdAt: '2026-03-02T10:00:00.000Z' })
    ])
    expect(store.list().map((entry) => entry.id)).toEqual(['og-1', 'tac-1'])
    expect(store.list('thematic').map((entry) => entry.id)).toEqual(['tac-1'])
  })

  it('answers with copies, so a caller cannot write through the store', async () => {
    await store.put(exercise('tac-1'))
    const read = store.get('tac-1')!
    read.solution.push('h2h4')
    read.status = 'solved'
    expect(store.get('tac-1')?.solution).toEqual(['e2e4', 'e7e5'])
    expect(store.get('tac-1')?.status).toBe('new')
  })

  it('merges a patch and removes the keys set to undefined', async () => {
    await store.put(
      exercise('tac-1', { status: 'solved', solvedAt: '2026-03-02T10:00:00.000Z', attempts: 3 })
    )
    const updated = await store.update('tac-1', { status: 'new', attempts: 0, solvedAt: undefined })
    expect(updated?.solvedAt).toBeUndefined()
    expect(
      JSON.parse(await readFile(join(root, 'exercises.json'), 'utf8'))[0].solvedAt
    ).toBeUndefined()
  })

  it('collects the ids of one status', async () => {
    await store.putMany([
      exercise('tac-1', { status: 'solved' }),
      exercise('tac-2'),
      exercise('og-1', { kind: 'own_game', status: 'solved' })
    ])
    expect([...store.idsWithStatus('solved', 'thematic')]).toEqual(['tac-1'])
  })

  it('drops the rows of a broken file instead of crashing', async () => {
    await writeFile(
      join(root, 'exercises.json'),
      JSON.stringify([exercise('tac-1'), { id: 'broken' }, 42]),
      'utf8'
    )
    await store.load()
    expect(store.list().map((entry) => entry.id)).toEqual(['tac-1'])
  })

  it('reads an exercise of an older version back to a usable shape', () => {
    expect(
      sanitizeExercise({
        id: 'x',
        kind: 'thematic',
        fen: '8/8/8/8/8/8/8/8 w - - 0 1',
        sideToMove: 'w',
        theme: 'fork'
      })
    ).toMatchObject({
      solution: [],
      status: 'new',
      attempts: 0
    })
    expect(
      sanitizeExercise({ id: 'x', kind: 'nope', fen: 'f', sideToMove: 'w', theme: 'fork' })
    ).toBeNull()
  })
})
