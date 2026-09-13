import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import {
  MINIMAL_CONFIG,
  ensureCodexHome,
  resetAuth,
  setConfiguredModel,
  syncAuth,
  userCodexHome
} from './codexHome'

const dirs: string[] = []

async function tmp(): Promise<string> {
  const dir = await makeTmpDir('chessadvisor-home-')
  dirs.push(dir)
  return dir
}

async function writeAuth(dir: string, lastRefresh: string | null): Promise<void> {
  await mkdir(dir, { recursive: true })
  const payload =
    lastRefresh === null ? { tokens: 'x' } : { tokens: 'x', last_refresh: lastRefresh }
  await writeFile(join(dir, 'auth.json'), JSON.stringify(payload))
}

afterEach(async () => {
  while (dirs.length > 0) await removeTmpDir(dirs.pop()!)
})

describe('userCodexHome', () => {
  it('honours CODEX_HOME and otherwise falls back to the profile folder', () => {
    expect(userCodexHome({ CODEX_HOME: 'D:\\codex' })).toBe('D:\\codex')
    expect(userCodexHome({ USERPROFILE: 'D:\\Users\\leo' })).toBe(join('D:\\Users\\leo', '.codex'))
    expect(userCodexHome({})).toBe(join(homedir(), '.codex'))
  })
})

describe('ensureCodexHome', () => {
  it('writes the minimal config once and keeps it afterwards', async () => {
    const dir = join(await tmp(), 'codex-home')
    await ensureCodexHome(dir, 'gpt-6-astra')

    const file = join(dir, 'config.toml')
    expect(await readFile(file, 'utf8')).toBe(MINIMAL_CONFIG('gpt-6-astra'))

    await ensureCodexHome(dir, 'another-model')
    expect(await readFile(file, 'utf8')).toBe(MINIMAL_CONFIG('gpt-6-astra'))
  })

  it('never enables hooks, plugins or MCP servers', async () => {
    const dir = await tmp()
    await ensureCodexHome(dir, 'gpt-6-astra')
    const config = await readFile(join(dir, 'config.toml'), 'utf8')
    expect(config).toContain('hooks = false')
    expect(config).toContain('sandbox_mode = "read-only"')
    expect(config).toContain('approval_policy = "never"')
    expect(config).not.toContain('[plugins')
    expect(config).not.toContain('[mcp_servers')
  })

  it('rewrites a config that does not disable hooks', async () => {
    const dir = await tmp()
    await writeFile(join(dir, 'config.toml'), 'model = "old"\n')
    await ensureCodexHome(dir, 'gpt-6-astra')
    expect(await readFile(join(dir, 'config.toml'), 'utf8')).toBe(MINIMAL_CONFIG('gpt-6-astra'))
  })

  it('leaves no temporary file behind', async () => {
    const dir = await tmp()
    await ensureCodexHome(dir, 'gpt-6-astra')
    const { readdir } = await import('node:fs/promises')
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

describe('setConfiguredModel', () => {
  it('rewrites only the model line and leaves every other key untouched', async () => {
    const dir = await tmp()
    const file = join(dir, 'config.toml')
    await ensureCodexHome(dir, 'placeholder')

    expect(await setConfiguredModel(dir, 'gpt-6-astra')).toBe(true)
    const config = await readFile(file, 'utf8')
    expect(config).toBe(MINIMAL_CONFIG('gpt-6-astra'))
    expect(config).toContain('approval_policy = "never"')
    expect(config).toContain('hooks = false')
  })

  it('keeps comments and unknown keys, and rewrites nothing when the model already matches', async () => {
    const dir = await tmp()
    const file = join(dir, 'config.toml')
    const original = ['# hand written', 'model   =   "old-model"', 'model_reasoning_effort = "low"', ''].join('\n')
    await writeFile(file, original)

    expect(await setConfiguredModel(dir, 'gpt-6-astra')).toBe(true)
    expect(await readFile(file, 'utf8')).toBe(
      ['# hand written', 'model = "gpt-6-astra"', 'model_reasoning_effort = "low"', ''].join('\n')
    )

    expect(await setConfiguredModel(dir, 'gpt-6-astra')).toBe(false)
  })

  it('adds the key when the config has none and ignores a missing config', async () => {
    const dir = await tmp()
    const file = join(dir, 'config.toml')
    await writeFile(file, 'approval_policy = "never"\n')
    expect(await setConfiguredModel(dir, 'gpt-6-astra')).toBe(true)
    expect(await readFile(file, 'utf8')).toBe('model = "gpt-6-astra"\napproval_policy = "never"\n')

    expect(await setConfiguredModel(join(dir, 'nowhere'), 'gpt-6-astra')).toBe(false)
  })
})

describe('syncAuth', () => {
  it('copies the credentials when the dedicated home has none', async () => {
    const source = await tmp()
    const target = await tmp()
    await writeAuth(source, '2026-09-12T10:00:00Z')

    expect(await syncAuth(target, source)).toBe('copied')
    expect(JSON.parse(await readFile(join(target, 'auth.json'), 'utf8')).tokens).toBe('x')
  })

  it('copies again when the user refreshed their own login', async () => {
    const source = await tmp()
    const target = await tmp()
    await writeAuth(target, '2026-09-12T10:00:00Z')
    await writeAuth(source, '2026-09-12T12:00:00Z')

    expect(await syncAuth(target, source)).toBe('copied')
    expect(JSON.parse(await readFile(join(target, 'auth.json'), 'utf8')).last_refresh).toBe(
      '2026-09-12T12:00:00Z'
    )
  })

  it('keeps the copy when the source is older or equally fresh', async () => {
    const source = await tmp()
    const target = await tmp()
    await writeAuth(source, '2026-09-12T08:00:00Z')
    await writeAuth(target, '2026-09-12T10:00:00Z')

    expect(await syncAuth(target, source)).toBe('kept')
    expect(JSON.parse(await readFile(join(target, 'auth.json'), 'utf8')).last_refresh).toBe(
      '2026-09-12T10:00:00Z'
    )
  })

  it('reports missing when the user never logged in', async () => {
    const source = await tmp()
    const target = await tmp()
    expect(await syncAuth(target, source)).toBe('missing')
  })

  it('replaces an unreadable copy', async () => {
    const source = await tmp()
    const target = await tmp()
    await writeAuth(source, '2026-09-12T08:00:00Z')
    await writeFile(join(target, 'auth.json'), '{ broken')

    expect(await syncAuth(target, source)).toBe('copied')
  })
})

describe('resetAuth', () => {
  it('removes the copied credentials and tolerates a missing file', async () => {
    const dir = await tmp()
    await writeAuth(dir, '2026-09-12T08:00:00Z')
    await resetAuth(dir)
    await expect(readFile(join(dir, 'auth.json'), 'utf8')).rejects.toThrow()
    await expect(resetAuth(dir)).resolves.toBeUndefined()
  })
})
