import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { open, stat } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { app, safeStorage } from 'electron'
import { writeJsonAtomic } from '../store/atomicWrite'
import { m } from './messages'
import { UpdateError } from './transport'

export interface UpdateCredential {
  source: 'github-app' | 'anonymous'
  token?: string
  account?: string
  failure?: 'not-connected' | 'stored-credential-unavailable'
}

export type CredentialRead =
  | { ok: true; token: string; account: string }
  | {
      ok: false
      reason:
        | 'failed'
        | 'spawn-failed'
        | 'timeout'
        | 'cancelled'
        | 'oversize'
        | 'missing-token'
        | 'missing-account'
        | 'invalid-scope'
      exitCode?: number
    }

const validToken = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 8192 &&
  !/[\s\x00-\x1f\x7f]/.test(value)
const validAccount = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z\d_-]{1,100}$/i.test(value)
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export const sessionPath = (): string => join(app.getPath('userData'), 'updates-auth.json')
const cancelled = (): UpdateError => new UpdateError('UPDATES_AUTH_CANCELLED', m().authCancelled)

async function readMetadata(path: string, limit: number): Promise<string> {
  const file = await open(path, 'r')
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > limit) throw new Error('Metadata unavailable')
    const bytes = Buffer.alloc(limit + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead > limit) throw new Error('Metadata unavailable')
    return bytes.subarray(0, bytesRead).toString('utf8')
  } finally {
    await file.close()
  }
}

/**
 * The only credential source for checks and downloads: the session this app created itself.
 * Git PATs, GitHub Desktop accounts and git credential helpers are never consulted.
 */
export async function updateCredential(): Promise<UpdateCredential> {
  try {
    const saved: unknown = JSON.parse(await readMetadata(sessionPath(), 64 * 1024))
    if (
      !record(saved) ||
      saved.version !== 1 ||
      saved.cipher !== 'electron-safe-storage' ||
      typeof saved.data !== 'string' ||
      !/^[a-z\d+/]+={0,2}$/i.test(saved.data) ||
      !safeStorage.isEncryptionAvailable()
    ) {
      throw new Error('Session unavailable')
    }
    const plain = safeStorage.decryptString(Buffer.from(saved.data, 'base64'))
    const session: unknown = JSON.parse(plain)
    if (!record(session) || !validToken(session.token) || !validAccount(session.account))
      throw new Error('Invalid session')
    return { source: 'github-app', token: session.token, account: session.account }
  } catch (error) {
    return {
      source: 'anonymous',
      failure:
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'not-connected'
          : 'stored-credential-unavailable'
    }
  }
}

/**
 * ChessAdvisor has no user-configurable git path: PATH first, then the standard
 * Git for Windows locations, because a desktop process can inherit a stale PATH.
 */
export async function findGitExe(): Promise<string | undefined> {
  const fromPath = (process.env.PATH ?? '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0)
    .map((entry) => join(entry, 'git.exe'))
  const candidates = [
    ...fromPath,
    ...[process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter((path): path is string => !!path)
      .map((path) => join(path, 'Git', 'cmd', 'git.exe')),
    ...(process.env.LOCALAPPDATA
      ? [join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe')]
      : [])
  ]
  for (const path of [...new Set(candidates)]) {
    if (!isAbsolute(path) || !/\.exe$/i.test(path)) continue
    try {
      if ((await stat(path)).isFile()) return path
    } catch {
      /* Try another standard installation. */
    }
  }
  return undefined
}

/** Resolve only the GCM executable belonging to the resolved Git installation. */
export async function credentialManagerPath(
  gitPath: string | undefined
): Promise<string | undefined> {
  if (!gitPath || !isAbsolute(gitPath) || !/\.exe$/i.test(gitPath)) return undefined
  const directory = dirname(gitPath)
  const candidates = [
    join(directory, 'git-credential-manager.exe'),
    resolve(directory, '..', 'mingw64', 'bin', 'git-credential-manager.exe'),
    resolve(directory, '..', 'mingw64', 'libexec', 'git-core', 'git-credential-manager.exe')
  ]
  for (const path of candidates) {
    try {
      if ((await stat(path)).isFile()) return path
    } catch {
      /* Try another executable in this Git installation. */
    }
  }
  return undefined
}

export function oauthEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(env)) {
    if (
      /^(?:GIT_TRACE|GCM_TRACE|GIT_CURL_VERBOSE|GIT_CONFIG_(?:COUNT|KEY_|VALUE_|PARAMETERS)|DESKTOP_)/i.test(
        key
      ) ||
      /^(?:GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE|GIT_INDEX_FILE|GIT_EXEC_PATH|GCM_NAMESPACE|GCM_CREDENTIAL_STORE|GCM_PROVIDER|GCM_GITHUB_AUTHMODES|GCM_DEBUG)$/i.test(
        key
      )
    ) {
      delete env[key]
    }
  }
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    GCM_INTERACTIVE: '1',
    GCM_GUI_PROMPT: '1',
    GCM_PROVIDER: 'github',
    GCM_GITHUB_AUTHMODES: 'browser',
    GCM_TRACE: '0',
    GCM_TRACE_SECRETS: '0',
    GCM_TRACE_MSAUTH: '0',
    GCM_DEBUG: '0',
    // Supported by GCM 2.5.0. A new namespace has no cached accounts to select.
    // GitHub's browser get returns the token without storing it; we never call store.
    GCM_NAMESPACE: 'chessadvisor-updates-auth-' + randomUUID(),
    GCM_CREDENTIAL_STORE: 'wincredman'
  }
}

export function parseCredential(output: Buffer): CredentialRead {
  const fields = new Map<string, string>()
  for (const line of output
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    const at = line.indexOf('=')
    if (at > 0) fields.set(line.slice(0, at), line.slice(at + 1))
  }
  const token = fields.get('password')
  const account = fields.get('username')
  if (
    (fields.has('host') && fields.get('host') !== 'github.com') ||
    (fields.has('protocol') && fields.get('protocol') !== 'https') ||
    fields.get('path')
  ) {
    return { ok: false, reason: 'invalid-scope' }
  }
  if (!validToken(token)) return { ok: false, reason: 'missing-token' }
  if (!validAccount(account)) return { ok: false, reason: 'missing-account' }
  return { ok: true, token, account }
}

/** One bounded OAuth request. Sensitive stdout stays in main; stderr is not logged. */
export function browserCredential(manager: string, signal: AbortSignal): Promise<CredentialRead> {
  if (signal.aborted) return Promise.resolve({ ok: false, reason: 'cancelled' })
  return new Promise((resolveRead) => {
    let output = Buffer.alloc(0)
    let finished = false
    const child = spawn(manager, ['get'], {
      cwd: app.getPath('userData'),
      env: oauthEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore']
    })
    const finish = (result: CredentialRead): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      output.fill(0)
      resolveRead(result)
    }
    const abort = (): void => {
      child.kill()
      finish({ ok: false, reason: 'cancelled' })
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, reason: 'timeout' })
    }, 180_000)
    child.once('error', () => finish({ ok: false, reason: 'spawn-failed' }))
    child.stdout?.on('data', (chunk: Buffer) => {
      if (finished) return
      if (output.length + chunk.length > 32 * 1024) {
        child.kill()
        finish({ ok: false, reason: 'oversize' })
        return
      }
      const combined = Buffer.concat([output, chunk])
      output.fill(0)
      output = combined
    })
    child.once('close', (code) => {
      if (finished) return
      if (code !== 0) {
        finish({
          ok: false,
          reason: 'failed',
          ...(typeof code === 'number' ? { exitCode: code } : {})
        })
        return
      }
      finish(parseCredential(output))
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end('protocol=https\nhost=github.com\n\n')
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

/** Explicit app connection only: fresh browser OAuth, then encrypted app-owned storage. */
export async function authenticateGithub(
  signal: AbortSignal,
  credentialReady?: () => void
): Promise<UpdateCredential> {
  if (signal.aborted) throw cancelled()
  if (process.platform !== 'win32')
    throw new UpdateError('UPDATES_AUTH_UNAVAILABLE', m().authPlatform)
  if (!safeStorage.isEncryptionAvailable())
    throw new UpdateError('UPDATES_AUTH_SAVE', m().authStorageUnavailable)
  const manager = await credentialManagerPath(await findGitExe())
  if (!manager) throw new UpdateError('UPDATES_AUTH_UNAVAILABLE', m().gcmMissing)
  const result = await browserCredential(manager, signal)
  if (signal.aborted || (!result.ok && result.reason === 'cancelled')) throw cancelled()
  if (!result.ok) {
    if (result.reason === 'timeout') throw new UpdateError('UPDATES_AUTH_TIMEOUT', m().authTimeout)
    if (result.reason === 'spawn-failed')
      throw new UpdateError('UPDATES_AUTH_UNAVAILABLE', m().authSpawnFailed)
    if (result.reason === 'failed')
      throw new UpdateError('UPDATES_AUTH_PROCESS', m().authProcessFailed(result.exitCode))
    const detail =
      result.reason === 'missing-account'
        ? m().detailMissingAccount
        : result.reason === 'missing-token'
          ? m().detailMissingToken
          : result.reason === 'invalid-scope'
            ? m().detailInvalidScope
            : m().detailOversize
    throw new UpdateError('UPDATES_AUTH_CREDENTIAL', m().authCredentialInvalid(detail))
  }
  credentialReady?.()
  if (signal.aborted) throw cancelled()
  try {
    const data = safeStorage
      .encryptString(JSON.stringify({ token: result.token, account: result.account }))
      .toString('base64')
    await writeJsonAtomic(sessionPath(), { version: 1, cipher: 'electron-safe-storage', data })
  } catch {
    throw new UpdateError('UPDATES_AUTH_SAVE', m().authSaveFailed)
  }
  return { source: 'github-app', token: result.token, account: result.account }
}
