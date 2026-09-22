import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { LEARNING_POLICY_VERSION, migrateLearningData } from './learningMigration'

describe('migrateLearningData', () => {
  let dir: string

  beforeEach(async () => {
    dir = await makeTmpDir()
  })

  afterEach(async () => {
    await removeTmpDir(dir)
  })

  it('backs up derived data, retires existing games, and preserves non-own-game training', async () => {
    const gameId = 'old-game'
    await mkdir(join(dir, 'games'), { recursive: true })
    const rawGame = JSON.stringify({ id: gameId, moves: [], status: 'finished' })
    await writeFile(join(dir, 'games', gameId + '.json'), rawGame)
    const profile = { level: { estimate: 1400 }, history: [{ gameId }], themeStats: { fork: {} } }
    const exercises = [
      { id: 'old-own', kind: 'own_game', sourceGameId: gameId },
      { id: 'thematic', kind: 'thematic', status: 'solved' },
      { id: 'end', kind: 'endgame', status: 'failed' }
    ]
    const plan = { generatedAt: '2026-01-01T00:00:00.000Z', items: [{ id: 'item-1' }] }
    await writeFile(join(dir, 'profile.json'), JSON.stringify(profile))
    await writeFile(join(dir, 'exercises.json'), JSON.stringify(exercises))
    await writeFile(join(dir, 'study-plan.json'), JSON.stringify(plan))

    const result = await migrateLearningData(dir, () => Date.parse('2026-09-22T00:00:00.000Z'))

    expect(result.migrated).toBe(true)
    expect(result.learningPolicyVersion).toBe(LEARNING_POLICY_VERSION)
    expect(result.retiredGameIds).toEqual([gameId])
    expect(JSON.parse(await readFile(join(dir, 'games', gameId + '.json'), 'utf8'))).toEqual(
      JSON.parse(rawGame)
    )
    expect(JSON.parse(await readFile(join(dir, 'profile.json'), 'utf8'))).toMatchObject({
      learningPolicyVersion: 2,
      retiredGameIds: [gameId],
      history: [],
      themeStats: {},
      openingStats: {},
      gamesSincePlan: 0
    })
    expect(JSON.parse(await readFile(join(dir, 'exercises.json'), 'utf8'))).toEqual([
      exercises[1],
      exercises[2]
    ])
    await expect(readFile(join(dir, 'study-plan.json'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    })
    const backups = await readdir(join(dir, 'backups'))
    expect(backups).toHaveLength(1)
    const backupFiles = await readdir(join(dir, 'backups', backups[0]!))
    expect(backupFiles.sort()).toEqual(['exercises.json', 'profile.json', 'study-plan.json'])
  })

  it('reuses the original backup when a run is interrupted before the marker', async () => {
    await mkdir(join(dir, 'games'), { recursive: true })
    await writeFile(join(dir, 'games', 'g.json'), JSON.stringify({ id: 'g' }))
    await writeFile(join(dir, 'profile.json'), JSON.stringify({ legacy: true }))
    const first = await migrateLearningData(dir, () => 1000)
    await writeFile(join(dir, 'learning-policy.json'), '{')
    await writeFile(join(dir, 'profile.json'), JSON.stringify({ partial: true }))

    const second = await migrateLearningData(dir, () => 2000)

    expect(second.migrated).toBe(true)
    expect(second.backupDir).toBe(first.backupDir)
    expect(await readdir(join(dir, 'backups'))).toHaveLength(1)
    expect(JSON.parse(await readFile(join(first.backupDir!, 'profile.json'), 'utf8'))).toEqual({
      legacy: true
    })
  })

  it('is idempotent after the marker is written', async () => {
    await mkdir(join(dir, 'games'), { recursive: true })
    await writeFile(join(dir, 'games', 'g.json'), JSON.stringify({ id: 'g' }))
    const first = await migrateLearningData(dir, () => 1000)
    const second = await migrateLearningData(dir, () => 2000)
    expect(second.migrated).toBe(false)
    expect(second.backupDir).toBe(first.backupDir)
    expect(await readdir(join(dir, 'backups'))).toHaveLength(1)
  })
})
