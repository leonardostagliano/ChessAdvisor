import { createHash } from 'node:crypto'
import { readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UpdatePreferences, UpdateStatus } from '@shared/updates'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import type { UpdateCredential } from './credentials'

const env = vi.hoisted(() => ({ isPackaged: true, userData: '', exe: '' }))

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return env.isPackaged
    },
    getVersion: () => '1.0.0',
    getPath: (name: string) => (name === 'exe' ? env.exe : env.userData),
    getAppPath: () => env.userData
  }
}))

vi.mock('./credentials', () => ({
  updateCredential: vi.fn(),
  authenticateGithub: vi.fn()
}))

vi.mock('./transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./transport')>()
  return {
    ...actual,
    readReleaseJson: vi.fn(),
    readReleaseBytes: vi.fn(),
    downloadReleaseAsset: vi.fn()
  }
})

const { updateCredential } = await import('./credentials')
const { downloadReleaseAsset, readReleaseBytes, readReleaseJson } = await import('./transport')
const { AppUpdateService, installation } = await import('./service')

const SESSION: UpdateCredential = {
  source: 'github-app',
  token: 'gho_fake_token',
  account: 'octocat'
}
const NO_SESSION: UpdateCredential = { source: 'anonymous', failure: 'not-connected' }

const INSTALLER_SIZE = 1024
const INSTALLER_BYTES = Buffer.concat([
  Buffer.from('MZ', 'ascii'),
  Buffer.alloc(INSTALLER_SIZE - 2, 0x41)
])
const INSTALLER_SHA256 = createHash('sha256').update(INSTALLER_BYTES).digest('hex')

function release(
  version: string,
  options: { checksums?: boolean; id?: number } = {}
): Record<string, unknown> {
  const id = options.id ?? 500
  return {
    id,
    draft: false,
    prerelease: false,
    tag_name: `v${version}`,
    published_at: '2026-09-01T10:00:00Z',
    body: `Release ${version}`,
    assets: [
      {
        id: id + 1,
        state: 'uploaded',
        name: `ChessAdvisor-${version}-x64.exe`,
        size: INSTALLER_SIZE
      },
      {
        id: id + 2,
        state: 'uploaded',
        name: `ChessAdvisor-${version}-portable.exe`,
        size: INSTALLER_SIZE
      },
      ...(options.checksums === false
        ? []
        : [{ id: id + 3, state: 'uploaded', name: 'SHA256SUMS.txt', size: 200 }])
    ]
  }
}

let dir = ''
let preferences: UpdatePreferences
let busy = false
let statuses: UpdateStatus[] = []
let quits = 0

function makeService(): InstanceType<typeof AppUpdateService> {
  return new AppUpdateService({
    changed: (status) => statuses.push(status),
    quitForInstaller: () => {
      quits += 1
    },
    returnToApp: () => {},
    preferences: {
      get: () => ({ ...preferences }),
      save: async (next) => {
        preferences = { ...next }
      }
    },
    isBusy: () => busy
  })
}

/** Fails a test loudly instead of silently passing when a rejection does not happen. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return (error as { code?: string }).code ?? 'NO_CODE'
  }
  throw new Error('the operation resolved but a failure was expected')
}

beforeEach(async () => {
  dir = await makeTmpDir()
  env.isPackaged = true
  env.userData = dir
  env.exe = join(dir, 'ChessAdvisor.exe')
  preferences = { autoCheck: true }
  busy = false
  statuses = []
  quits = 0
  vi.mocked(updateCredential).mockResolvedValue(SESSION)
  vi.mocked(readReleaseJson).mockReset()
  vi.mocked(readReleaseBytes).mockReset()
  vi.mocked(downloadReleaseAsset).mockReset()
  vi.mocked(downloadReleaseAsset).mockImplementation(async (_id, path, size, options) => {
    await writeFile(path, INSTALLER_BYTES)
    options.progress(size)
    return { sha256: INSTALLER_SHA256, size }
  })
})

afterEach(async () => {
  vi.useRealTimers()
  await removeTmpDir(dir)
})

describe('installation', () => {
  it('reports a development build when the app is not packaged', () => {
    env.isPackaged = false
    expect(installation()).toBe('development')
    const service = makeService()
    expect(service.releaseUrl()).toContain('leonardostagliano/ChessAdvisor')
  })

  it('reports an installed build for a packaged Windows x64 app', () => {
    expect(installation()).toBe(
      process.platform === 'win32' && process.arch === 'x64' ? 'installed' : 'unsupported'
    )
  })
})

describe('without a stored GitHub session', () => {
  beforeEach(() => {
    vi.mocked(updateCredential).mockResolvedValue(NO_SESSION)
  })

  it('fails the check with UPDATES_AUTH_REQUIRED', async () => {
    const service = makeService()
    expect(await codeOf(service.check())).toBe('UPDATES_AUTH_REQUIRED')
    expect(readReleaseJson).not.toHaveBeenCalled()
    const status = await service.status()
    expect(status.phase).toBe('error')
    expect(status.authSource).toBe('anonymous')
    service.dispose()
  })

  it('does not schedule an automatic check even when autoCheck is on', async () => {
    vi.useFakeTimers()
    const service = makeService()
    await service.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(readReleaseJson).not.toHaveBeenCalled()
    service.dispose()
  })
})

describe('check', () => {
  it('fails with UPDATES_NO_RELEASE when no stable installer is published', async () => {
    vi.mocked(readReleaseJson).mockResolvedValue([])
    const service = makeService()
    expect(await codeOf(service.check())).toBe('UPDATES_NO_RELEASE')
    service.dispose()
  })

  it('reports up-to-date for a release that is not newer', async () => {
    vi.mocked(readReleaseJson).mockResolvedValue([release('0.9.0')])
    const service = makeService()
    const status = await service.check()
    expect(status.phase).toBe('up-to-date')
    expect(status.release?.version).toBe('0.9.0')
    expect(status.canDownload).toBe(false)
    expect(status.checkedAt).not.toBeNull()
    service.dispose()
  })

  it('reports a newer release as available with its SHA256SUMS manifest', async () => {
    vi.mocked(readReleaseJson).mockResolvedValue([release('0.9.0', { id: 400 }), release('1.1.0')])
    const service = makeService()
    const status = await service.check()
    expect(status.phase).toBe('available')
    expect(status.release?.version).toBe('1.1.0')
    expect(status.release?.checksum).toBe('sha256sums')
    expect(status.release?.assetName).toBe('ChessAdvisor-1.1.0-x64.exe')
    expect(status.canDownload).toBe(installation() === 'installed')
    service.dispose()
  })
})

describe('download', () => {
  const manifest = (hash: string): string =>
    `${hash}  ChessAdvisor-1.1.0-x64.exe\n0${'f'.repeat(63)}  SHA256SUMS.txt\n`

  beforeEach(() => {
    vi.mocked(readReleaseJson).mockImplementation(async (path: string) =>
      path.startsWith('/releases?') ? [release('1.1.0')] : release('1.1.0')
    )
  })

  it('verifies the published hash and stages the installer', async () => {
    vi.mocked(readReleaseBytes).mockResolvedValue(Buffer.from(manifest(INSTALLER_SHA256), 'utf8'))
    const service = makeService()
    await service.check()
    const status = await service.download()
    expect(status.phase).toBe('downloaded')
    expect(status.download?.verified).toBe(true)
    expect(status.download?.sha256).toBe(INSTALLER_SHA256)
    expect(status.canInstall).toBe(true)
    const staged = await readdir(join(dir, 'updates'))
    expect(staged).toHaveLength(1)
    expect(staged[0]).toMatch(/^ChessAdvisor-1\.1\.0-[a-f0-9-]{36}\.exe$/)
    service.dispose()
  })

  it('refuses a mismatching hash and removes the partial file', async () => {
    vi.mocked(readReleaseBytes).mockResolvedValue(Buffer.from(manifest('a'.repeat(64)), 'utf8'))
    const service = makeService()
    await service.check()
    expect(await codeOf(service.download())).toBe('UPDATES_INTEGRITY')
    expect(await readdir(join(dir, 'updates'))).toEqual([])
    const status = await service.status()
    expect(status.phase).toBe('error')
    expect(status.canInstall).toBe(false)
    service.dispose()
  })

  it('refuses to install while a game turn is running', async () => {
    vi.mocked(readReleaseBytes).mockResolvedValue(Buffer.from(manifest(INSTALLER_SHA256), 'utf8'))
    const service = makeService()
    await service.check()
    await service.download()
    busy = true
    expect(await codeOf(service.install())).toBe('UPDATES_BUSY_GAME')
    expect(quits).toBe(0)
    // The staged installer survives: the user can install it as soon as the turn ends.
    expect(await readdir(join(dir, 'updates'))).toHaveLength(1)
    service.dispose()
  })
})

describe('savePreferences', () => {
  it('writes through to Settings and rejects an unknown key', async () => {
    const service = makeService()
    const status = await service.savePreferences({ autoCheck: false })
    expect(status.preferences.autoCheck).toBe(false)
    expect(preferences.autoCheck).toBe(false)
    expect(
      await codeOf(service.savePreferences({ autoCheck: true, other: 1 } as UpdatePreferences))
    ).toBe('UPDATES_PREFERENCES')
    expect(statuses.length).toBeGreaterThan(0)
    service.dispose()
  })
})
