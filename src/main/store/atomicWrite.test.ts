import { readdir, readFile, writeFile, utimes, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { cleanupTmp, readJson, writeJsonAtomic } from './atomicWrite'

// `rename` is the only step that can fail transiently on Windows; the hook lets a test
// make it fail without touching the rest of node:fs/promises.
const hook = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => Promise<void>)
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    rename: (from: string, to: string) =>
      hook.rename ? hook.rename(from, to) : actual.rename(from, to)
  }
})

const { rename: realRename } =
  await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')

let dir = ''

beforeEach(async () => {
  dir = await makeTmpDir()
})

afterEach(async () => {
  hook.rename = null
  vi.restoreAllMocks()
  await removeTmpDir(dir)
})

const tmpLeftovers = async (): Promise<string[]> =>
  (await readdir(dir)).filter((f) => f.endsWith('.tmp'))

describe('writeJsonAtomic', () => {
  it('writes a file that reads back identically', async () => {
    const file = join(dir, 'settings.json')
    await writeJsonAtomic(file, { a: 1, nested: { b: 'x' } })
    expect(await readJson(file, null)).toEqual({ a: 1, nested: { b: 'x' } })
    expect(await tmpLeftovers()).toEqual([])
  })

  it('creates missing directories', async () => {
    const file = join(dir, 'deep', 'nested', 'game.json')
    await writeJsonAtomic(file, [1, 2, 3])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([1, 2, 3])
  })

  it('retries a rename that fails with EPERM and leaves no tmp file behind', async () => {
    const file = join(dir, 'retry.json')
    let calls = 0
    hook.rename = async (from, to) => {
      calls += 1
      if (calls <= 2) {
        const error: NodeJS.ErrnoException = new Error('EPERM: operation not permitted')
        error.code = 'EPERM'
        throw error
      }
      return realRename(from, to)
    }

    await writeJsonAtomic(file, { ok: true })

    expect(calls).toBe(3)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ok: true })
    expect(await tmpLeftovers()).toEqual([])
  })

  it('throws ATOMIC_WRITE_FAILED and removes the tmp file when every retry fails', async () => {
    const file = join(dir, 'doomed.json')
    hook.rename = async () => {
      const error: NodeJS.ErrnoException = new Error('EBUSY: resource busy')
      error.code = 'EBUSY'
      throw error
    }

    await expect(writeJsonAtomic(file, { ok: true })).rejects.toThrow(
      `ATOMIC_WRITE_FAILED: ${file}`
    )
    expect(await tmpLeftovers()).toEqual([])
  })
})

describe('readJson', () => {
  it('returns the fallback when the file does not exist', async () => {
    expect(await readJson(join(dir, 'missing.json'), { fallback: true })).toEqual({
      fallback: true
    })
  })

  it('quarantines a corrupt file and returns the fallback', async () => {
    const file = join(dir, 'corrupt.json')
    await writeFile(file, '{ not json', 'utf8')

    expect(await readJson(file, { fallback: true })).toEqual({ fallback: true })

    const quarantined = (await readdir(dir)).filter((f) => f.startsWith('corrupt.json.corrupt-'))
    expect(quarantined).toHaveLength(1)
  })
})

describe('cleanupTmp', () => {
  it('removes only stale tmp files', async () => {
    await mkdir(dir, { recursive: true })
    const stale = join(dir, 'a.json.1234.tmp')
    const fresh = join(dir, 'b.json.5678.tmp')
    const keep = join(dir, 'c.json')
    await writeFile(stale, 'x', 'utf8')
    await writeFile(fresh, 'x', 'utf8')
    await writeFile(keep, '{}', 'utf8')
    const old = new Date(Date.now() - 5 * 60_000)
    await utimes(stale, old, old)

    expect(await cleanupTmp(dir)).toBe(1)
    const left = await readdir(dir)
    expect(left).toContain('b.json.5678.tmp')
    expect(left).toContain('c.json')
    expect(left).not.toContain('a.json.1234.tmp')
  })

  it('returns 0 for a directory that does not exist', async () => {
    expect(await cleanupTmp(join(dir, 'nope'))).toBe(0)
  })
})
