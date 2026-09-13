import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'

const env = vi.hoisted(() => ({
  userData: '',
  encryptionAvailable: true,
  decryptThrows: false,
  gcm: '',
  /** Absolute paths the mocked `stat` should report as existing files. */
  files: new Set<string>()
}))

vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  safeStorage: {
    isEncryptionAvailable: () => env.encryptionAvailable,
    // Reversible stand-in for DPAPI: the test only needs a round trip it controls.
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf8'),
    decryptString: (value: Buffer) => {
      if (env.decryptThrows) throw new Error('decryption failed')
      const text = value.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('not encrypted by this app')
      return text.slice(4)
    }
  }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    stat: async (path: string) => {
      if (env.files.has(String(path)))
        return { isFile: () => true } as Awaited<ReturnType<typeof actual.stat>>
      return actual.stat(path)
    }
  }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    default: actual,
    // Route the resolved credential-manager path to the Node stand-in fixture.
    spawn: (_command: string, args: string[], options: Record<string, unknown>) =>
      actual.spawn(process.execPath, [env.gcm, ...args], options as never)
  }
})

const {
  authenticateGithub,
  credentialManagerPath,
  findGitExe,
  parseCredential,
  sessionPath,
  updateCredential
} = await import('./credentials')

const GIT_DIR = resolvePath('C:/fake-git/cmd')
const GIT_EXE = join(GIT_DIR, 'git.exe')
const GCM_EXE = join(GIT_DIR, 'git-credential-manager.exe')
const OTHER_DIR = resolvePath('C:/other/bin')

let dir = ''
let savedEnv: NodeJS.ProcessEnv

beforeEach(async () => {
  dir = await makeTmpDir()
  savedEnv = { ...process.env }
  env.userData = dir
  env.encryptionAvailable = true
  env.decryptThrows = false
  env.gcm = resolvePath('test/fixtures/fake-gcm.mjs')
  env.files = new Set<string>()
  delete process.env.FAKE_GCM_HANG
  delete process.env.FAKE_GCM_EXIT_CODE
  delete process.env.FAKE_GCM_OUTPUT
})

afterEach(async () => {
  process.env = savedEnv
  await removeTmpDir(dir)
})

describe('parseCredential', () => {
  it('accepts a complete https/github.com credential', () => {
    const result = parseCredential(
      Buffer.from('protocol=https\nhost=github.com\nusername=octocat\npassword=gho_token\n', 'utf8')
    )
    expect(result).toEqual({ ok: true, token: 'gho_token', account: 'octocat' })
  })

  it('rejects another host, another protocol or a path-scoped credential', () => {
    const cases = [
      'protocol=https\nhost=github.example.com\nusername=octocat\npassword=gho_token\n',
      'protocol=http\nhost=github.com\nusername=octocat\npassword=gho_token\n',
      'protocol=https\nhost=github.com\npath=some/repo.git\nusername=octocat\npassword=gho_token\n'
    ]
    for (const output of cases) {
      expect(parseCredential(Buffer.from(output, 'utf8')), output).toEqual({
        ok: false,
        reason: 'invalid-scope'
      })
    }
  })

  it('rejects a missing or whitespace-bearing token and an invalid account', () => {
    expect(
      parseCredential(Buffer.from('protocol=https\nhost=github.com\nusername=octocat\n', 'utf8'))
    ).toEqual({
      ok: false,
      reason: 'missing-token'
    })
    expect(
      parseCredential(
        Buffer.from(
          'protocol=https\nhost=github.com\nusername=octocat\npassword=gho token\n',
          'utf8'
        )
      )
    ).toEqual({
      ok: false,
      reason: 'missing-token'
    })
    expect(
      parseCredential(
        Buffer.from(
          'protocol=https\nhost=github.com\nusername=octo cat\npassword=gho_token\n',
          'utf8'
        )
      )
    ).toEqual({
      ok: false,
      reason: 'missing-account'
    })
  })
})

describe('updateCredential', () => {
  it('reports not-connected when no session file exists', async () => {
    expect(await updateCredential()).toEqual({ source: 'anonymous', failure: 'not-connected' })
  })

  it('reports stored-credential-unavailable for a corrupt file', async () => {
    await writeFile(sessionPath(), '{ not json', 'utf8')
    expect(await updateCredential()).toEqual({
      source: 'anonymous',
      failure: 'stored-credential-unavailable'
    })
  })

  it('reports stored-credential-unavailable when the payload cannot be decrypted', async () => {
    await writeFile(
      sessionPath(),
      JSON.stringify({ version: 1, cipher: 'electron-safe-storage', data: 'QUJD' }),
      'utf8'
    )
    env.decryptThrows = true
    expect(await updateCredential()).toEqual({
      source: 'anonymous',
      failure: 'stored-credential-unavailable'
    })
  })

  it('returns the stored session when it decrypts to a valid credential', async () => {
    const data = Buffer.from(
      `enc:${JSON.stringify({ token: 'gho_token', account: 'octocat' })}`,
      'utf8'
    ).toString('base64')
    await writeFile(
      sessionPath(),
      JSON.stringify({ version: 1, cipher: 'electron-safe-storage', data }),
      'utf8'
    )
    expect(await updateCredential()).toEqual({
      source: 'github-app',
      token: 'gho_token',
      account: 'octocat'
    })
  })
})

describe('findGitExe', () => {
  it('prefers a git.exe found on PATH over the standard installation folders', async () => {
    process.env.PATH = [OTHER_DIR, GIT_DIR].join(';')
    process.env.ProgramFiles = resolvePath('C:/Program Files')
    env.files.add(join(OTHER_DIR, 'git.exe'))
    env.files.add(GIT_EXE)
    env.files.add(resolvePath('C:/Program Files/Git/cmd/git.exe'))
    expect(await findGitExe()).toBe(join(OTHER_DIR, 'git.exe'))
  })

  it('falls back to the standard installation folder when PATH has no git', async () => {
    process.env.PATH = OTHER_DIR
    process.env.ProgramW6432 = resolvePath('C:/Program Files')
    env.files.add(resolvePath('C:/Program Files/Git/cmd/git.exe'))
    expect(await findGitExe()).toBe(resolvePath('C:/Program Files/Git/cmd/git.exe'))
  })

  it('returns undefined when no candidate exists', async () => {
    process.env.PATH = OTHER_DIR
    delete process.env.ProgramW6432
    delete process.env.ProgramFiles
    delete process.env['ProgramFiles(x86)']
    delete process.env.LOCALAPPDATA
    expect(await findGitExe()).toBeUndefined()
  })
})

describe('credentialManagerPath', () => {
  it('finds the manager next to git.exe', async () => {
    env.files.add(GCM_EXE)
    expect(await credentialManagerPath(GIT_EXE)).toBe(GCM_EXE)
  })

  it('rejects a relative path or a non-executable and reports nothing when absent', async () => {
    expect(await credentialManagerPath('git')).toBeUndefined()
    expect(await credentialManagerPath(undefined)).toBeUndefined()
    expect(await credentialManagerPath(GIT_EXE)).toBeUndefined()
  })
})

describe('authenticateGithub', () => {
  beforeEach(() => {
    process.env.PATH = GIT_DIR
    env.files.add(GIT_EXE)
    env.files.add(GCM_EXE)
  })

  it('stores an encrypted session and returns the account', async () => {
    const credential = await authenticateGithub(new AbortController().signal)
    expect(credential).toEqual({
      source: 'github-app',
      token: 'gho_fake_token_123',
      account: 'octocat'
    })
    const saved = JSON.parse(await readFile(sessionPath(), 'utf8'))
    expect(saved.version).toBe(1)
    expect(saved.cipher).toBe('electron-safe-storage')
    expect(Buffer.from(saved.data, 'base64').toString('utf8')).toContain('gho_fake_token_123')
  })

  it('fails with UPDATES_AUTH_CANCELLED when the signal aborts', async () => {
    process.env.FAKE_GCM_HANG = '1'
    const controller = new AbortController()
    const pending = authenticateGithub(controller.signal)
    setTimeout(() => controller.abort(), 50)
    await expect(pending).rejects.toMatchObject({ code: 'UPDATES_AUTH_CANCELLED' })
  })

  it('fails with UPDATES_AUTH_PROCESS when the manager exits non-zero', async () => {
    process.env.FAKE_GCM_EXIT_CODE = '3'
    await expect(authenticateGithub(new AbortController().signal)).rejects.toMatchObject({
      code: 'UPDATES_AUTH_PROCESS'
    })
  })

  it('fails with UPDATES_AUTH_CREDENTIAL when the response has no token', async () => {
    process.env.FAKE_GCM_OUTPUT = 'protocol=https\nhost=github.com\nusername=octocat\n'
    await expect(authenticateGithub(new AbortController().signal)).rejects.toMatchObject({
      code: 'UPDATES_AUTH_CREDENTIAL'
    })
  })

  it('fails with UPDATES_AUTH_SAVE when the OS cannot protect the session', async () => {
    env.encryptionAvailable = false
    await expect(authenticateGithub(new AbortController().signal)).rejects.toMatchObject({
      code: 'UPDATES_AUTH_SAVE'
    })
  })
})
