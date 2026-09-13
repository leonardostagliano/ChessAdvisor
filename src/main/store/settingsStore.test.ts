import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types/settings'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { SettingsStore } from './settingsStore'

let dir = ''
const fileIn = (d: string): string => join(d, 'settings.json')

beforeEach(async () => {
  dir = await makeTmpDir()
})

afterEach(async () => {
  await removeTmpDir(dir)
})

describe('SettingsStore.load', () => {
  it('returns the defaults when the file is missing', async () => {
    const store = new SettingsStore(fileIn(dir))
    expect(await store.load()).toEqual(DEFAULT_SETTINGS)
    expect(store.get()).toEqual(DEFAULT_SETTINGS)
  })

  it('merges a partial file over the defaults', async () => {
    await writeFile(
      fileIn(dir),
      JSON.stringify({ language: 'en', turnTimeoutSec: 90, updates: {} }),
      'utf8'
    )
    const store = new SettingsStore(fileIn(dir))
    const settings = await store.load()
    expect(settings.language).toBe('en')
    expect(settings.turnTimeoutSec).toBe(90)
    expect(settings.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(settings.updates.autoCheck).toBe(true)
  })

  it('ignores invalid enums, invalid numbers and unknown keys', async () => {
    await writeFile(
      fileIn(dir),
      JSON.stringify({
        language: 'de',
        theme: 'neon',
        engineBinary: 'sse',
        pieceSet: 'alpha',
        turnTimeoutSec: 'soon',
        showReasoning: 'yes',
        defaultModel: 42,
        updates: { autoCheck: 'nope' },
        somethingElse: true
      }),
      'utf8'
    )
    const store = new SettingsStore(fileIn(dir))
    const settings = await store.load()
    expect(settings).toEqual(DEFAULT_SETTINGS)
    expect('somethingElse' in settings).toBe(false)
  })

  it('falls back to the defaults when the file is corrupt', async () => {
    await writeFile(fileIn(dir), 'not json at all', 'utf8')
    const store = new SettingsStore(fileIn(dir))
    expect(await store.load()).toEqual(DEFAULT_SETTINGS)
  })
})

describe('SettingsStore.save', () => {
  it('persists the patch and notifies listeners once', async () => {
    const store = new SettingsStore(fileIn(dir))
    await store.load()
    const seen: Settings[] = []
    const off = store.onChange((s) => seen.push(s))

    const saved = await store.save({ language: 'en', updates: { autoCheck: false } })

    expect(saved.language).toBe('en')
    expect(saved.updates.autoCheck).toBe(false)
    expect(store.get().language).toBe('en')
    expect(seen).toHaveLength(1)
    expect(seen[0].language).toBe('en')

    const onDisk = JSON.parse(await readFile(fileIn(dir), 'utf8'))
    expect(onDisk.language).toBe('en')
    expect(onDisk.updates.autoCheck).toBe(false)

    off()
    await store.save({ language: 'it' })
    expect(seen).toHaveLength(1)
  })

  it('drops invalid values in a patch and keeps the previous ones', async () => {
    const store = new SettingsStore(fileIn(dir))
    await store.load()
    await store.save({ theme: 'night' })
    const saved = await store.save({ theme: 'sepia' as Settings['theme'], turnTimeoutSec: -3 })
    expect(saved.theme).toBe('night')
    expect(saved.turnTimeoutSec).toBe(DEFAULT_SETTINGS.turnTimeoutSec)
  })

  it('survives a listener that throws', async () => {
    const store = new SettingsStore(fileIn(dir))
    await store.load()
    store.onChange(() => {
      throw new Error('listener exploded')
    })
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(store.save({ showReasoning: true })).resolves.toMatchObject({
      showReasoning: true
    })
    spy.mockRestore()
  })
})
