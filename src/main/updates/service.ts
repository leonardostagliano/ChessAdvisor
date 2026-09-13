import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { UpdatePreferences, UpdateRelease, UpdateStatus } from '@shared/updates'
import { getAppVersion } from '../util/appVersion'
import { authenticateGithub, updateCredential, type UpdateCredential } from './credentials'
import { m } from './messages'
import {
  compareVersions,
  MAX_INSTALLER_BYTES,
  stableVersion,
  UPDATE_API_ROOT,
  UPDATE_PACKAGE_NAME,
  UPDATE_REPOSITORY,
  UPDATE_REPOSITORY_URL
} from './source'
import {
  downloadReleaseAsset,
  readReleaseBytes,
  readReleaseJson,
  UpdateAccessError,
  UpdateError
} from './transport'

interface ReleaseAsset {
  id: number
  name: string
  size: number
  digest?: string
}
interface ReleaseCandidate {
  releaseId: number
  view: UpdateRelease
  installer: ReleaseAsset
  checksums?: ReleaseAsset
}
interface StagedInstaller {
  path: string
  sha256: string
  expectedHash?: string
  size: number
  version: string
}

export const CHECK_INTERVAL_MS = 6 * 60 * 60_000
const FIRST_CHECK_DELAY_MS = 15_000
const OBSOLETE_CLEANUP_DELAY_MS = 30_000

/** Preferences live in the application Settings (`settings.updates.autoCheck`), not in a private file. */
export interface UpdatePreferencesPort {
  get(): UpdatePreferences
  save(preferences: UpdatePreferences): Promise<void>
}

export interface AppUpdateServiceDeps {
  changed(state: UpdateStatus): void
  quitForInstaller(): void
  returnToApp(): void
  preferences: UpdatePreferencesPort
  /** True while a game turn is in flight: the app must never restart under the player. */
  isBusy(): boolean
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown, max: number): string =>
  typeof value === 'string'
    ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, max)
    : ''

function asset(value: unknown): ReleaseAsset | undefined {
  if (
    !record(value) ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) <= 0 ||
    value.state !== 'uploaded' ||
    typeof value.name !== 'string' ||
    !Number.isSafeInteger(value.size) ||
    Number(value.size) <= 0
  ) {
    return undefined
  }
  return {
    id: Number(value.id),
    name: value.name,
    size: Number(value.size),
    ...(typeof value.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(value.digest)
      ? { digest: value.digest.slice(7).toLowerCase() }
      : {})
  }
}

/** Stable SemVer and the exact installer name emitted by scripts/windows-release.mjs. */
function candidate(value: unknown): ReleaseCandidate | undefined {
  if (
    !record(value) ||
    value.draft !== false ||
    value.prerelease !== false ||
    !Number.isSafeInteger(value.id) ||
    Number(value.id) <= 0
  )
    return undefined
  const version = stableVersion(value.tag_name)
  if (!version || !Array.isArray(value.assets) || value.assets.length > 1000) return undefined
  const assets = value.assets.map(asset).filter((entry): entry is ReleaseAsset => !!entry)
  const installers = assets.filter(
    (entry) =>
      entry.name === `${UPDATE_PACKAGE_NAME}-${version}-x64.exe` &&
      entry.size <= MAX_INSTALLER_BYTES
  )
  if (installers.length !== 1) return undefined
  const checksumAssets = assets.filter((entry) => entry.name === 'SHA256SUMS.txt')
  if (checksumAssets.length > 1 || checksumAssets.some((entry) => entry.size > 1024 * 1024)) {
    throw new UpdateError('UPDATES_CHECKSUM', m().checksumManifestInvalid)
  }
  const installer = installers[0]
  const checksums = checksumAssets[0]
  const tag = String(value.tag_name)
  return {
    releaseId: Number(value.id),
    installer,
    checksums,
    view: {
      version,
      tag,
      publishedAt: text(value.published_at, 40),
      url: `${UPDATE_REPOSITORY_URL}/releases/tag/${encodeURIComponent(tag)}`,
      notes: text(value.body, 24_000),
      assetName: installer.name,
      assetSize: installer.size,
      checksum: checksums ? 'sha256sums' : installer.digest ? 'github-digest' : 'unavailable'
    }
  }
}

export function installation(): UpdateStatus['installation'] {
  if (!app.isPackaged) return 'development'
  if (process.platform !== 'win32' || process.arch !== 'x64') return 'unsupported'
  return process.env.PORTABLE_EXECUTABLE_DIR || process.env.PORTABLE_EXECUTABLE_FILE
    ? 'portable'
    : 'installed'
}

async function fileHash(path: string, expectedSize: number): Promise<string> {
  const info = await lstat(path)
  if (!info.isFile() || info.size !== expectedSize || info.size > MAX_INSTALLER_BYTES) {
    throw new UpdateError('UPDATES_INTEGRITY', m().localInstallerChanged)
  }
  const hash = createHash('sha256')
  let size = 0
  const stream = createReadStream(path)
  const timer = setTimeout(
    () => stream.destroy(new UpdateError('UPDATES_INTEGRITY', m().localVerifyTimeout)),
    60_000
  )
  try {
    for await (const bytes of stream) {
      size += (bytes as Buffer).length
      if (size > expectedSize) throw new UpdateError('UPDATES_INTEGRITY', m().localSizeChanged)
      hash.update(bytes as Buffer)
    }
    if (size !== expectedSize) throw new UpdateError('UPDATES_INTEGRITY', m().localIncomplete)
  } finally {
    clearTimeout(timer)
    stream.destroy()
  }
  return hash.digest('hex')
}

/** Automatic checks are opt-in; downloads and installation have separate explicit IPC commands. */
export class AppUpdateService {
  private state: UpdateStatus = {
    revision: 0,
    phase: 'idle',
    currentVersion: getAppVersion(),
    installation: installation(),
    repository: UPDATE_REPOSITORY,
    repositoryUrl: UPDATE_REPOSITORY_URL,
    preferences: { autoCheck: true },
    checkedAt: null,
    authSource: 'not-checked',
    githubAccount: null,
    release: null,
    download: null,
    canDownload: false,
    canInstall: false,
    message: m().initial
  }
  private candidate: ReleaseCandidate | null = null
  private staged: StagedInstaller | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private cleanupTimer: ReturnType<typeof setTimeout> | undefined
  private active: AbortController | null = null
  private loading: Promise<void> | null = null
  private loaded = false
  private disposed = false
  private checking: Promise<UpdateStatus> | null = null
  private authenticating: Promise<UpdateStatus> | null = null
  private preferenceWrites: Promise<void> = Promise.resolve()

  constructor(private readonly deps: AppUpdateServiceDeps) {}

  async start(): Promise<void> {
    await this.load()
    if (this.disposed) return
    // Old installers can be large, especially right after an update. Defer their optional
    // directory scan/deletion so it does not compete with startup disk reads.
    if (!this.cleanupTimer) {
      this.cleanupTimer = setTimeout(() => {
        this.cleanupTimer = undefined
        if (!this.disposed) void this.cleanObsoleteDownloads()
      }, OBSOLETE_CLEANUP_DELAY_MS)
      this.cleanupTimer.unref?.()
    }
    // Without a saved session an automatic check could only fail: wait for the explicit connection.
    if (this.state.preferences.autoCheck && this.state.authSource === 'github-app')
      this.schedule(FIRST_CHECK_DELAY_MS)
  }

  private load(): Promise<void> {
    if (this.loaded) return Promise.resolve()
    if (this.loading) return this.loading
    this.loading = (async () => {
      this.state.preferences = { autoCheck: this.deps.preferences.get().autoCheck === true }
      const credentials = await updateCredential()
      this.state.authSource = credentials.source
      this.state.githubAccount = credentials.account ?? null
      this.loaded = true
    })().finally(() => {
      this.loading = null
    })
    return this.loading
  }

  async status(): Promise<UpdateStatus> {
    await this.load()
    return this.snapshot()
  }

  private snapshot(): UpdateStatus {
    const installSupported = this.state.installation === 'installed'
    const busy =
      this.disposed ||
      !!this.checking ||
      !!this.authenticating ||
      ['authenticating', 'checking', 'downloading', 'installing'].includes(this.state.phase)
    return {
      ...this.state,
      preferences: { ...this.state.preferences },
      release: this.state.release ? { ...this.state.release } : null,
      download: this.state.download ? { ...this.state.download } : null,
      canDownload: installSupported && !busy && !!this.candidate && !this.staged,
      canInstall: installSupported && !busy && !!this.staged
    }
  }

  private update(patch: Partial<UpdateStatus>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }
    if (!this.disposed) this.deps.changed(this.snapshot())
  }

  /** Settings changed elsewhere (Settings screen, another window): keep the exposed state in step. */
  preferencesChanged(preferences: UpdatePreferences): void {
    if (!this.loaded || this.state.preferences.autoCheck === preferences.autoCheck) return
    this.update({ preferences: { autoCheck: preferences.autoCheck } })
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (preferences.autoCheck) this.schedule(1000)
  }

  async savePreferences(value: UpdatePreferences): Promise<UpdateStatus> {
    if (this.authenticating) throw new UpdateError('UPDATES_BUSY', m().busyAuth)
    if (
      !record(value) ||
      typeof value.autoCheck !== 'boolean' ||
      Object.keys(value).some((key) => key !== 'autoCheck')
    ) {
      throw new UpdateError('UPDATES_PREFERENCES', m().preferenceInvalid)
    }
    const autoCheck = value.autoCheck
    const save = this.preferenceWrites
      .catch(() => {})
      .then(async () => {
        await this.load()
        try {
          await this.deps.preferences.save({ autoCheck })
        } catch {
          throw new UpdateError('UPDATES_SAVE', m().preferenceSaveFailed)
        }
        this.update({ preferences: { autoCheck } })
        if (this.timer) clearTimeout(this.timer)
        this.timer = undefined
        if (autoCheck) this.schedule(1000)
      })
    this.preferenceWrites = save
    await save
    return this.snapshot()
  }

  private schedule(delay = CHECK_INTERVAL_MS): void {
    if (this.timer) clearTimeout(this.timer)
    if (
      this.disposed ||
      !this.state.preferences.autoCheck ||
      this.state.authSource !== 'github-app'
    )
      return
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (
        this.authenticating ||
        this.state.phase === 'downloading' ||
        this.state.phase === 'installing' ||
        this.staged
      ) {
        this.schedule()
        return
      }
      void this.check().catch(() => {})
    }, delay)
    this.timer.unref?.()
  }

  private fail(error: unknown): UpdateError {
    const safe =
      error instanceof UpdateError ? error : new UpdateError('UPDATES_ERROR', m().genericFailure)
    this.update({ phase: 'error', message: safe.message, errorCode: safe.code })
    return safe
  }

  private async releaseMetadata(
    path: string,
    signal: AbortSignal,
    linkedCredential?: UpdateCredential
  ): Promise<{ data: unknown; credentials: UpdateCredential }> {
    // Updates use only the session created by this app's browser connection.
    const credentials = linkedCredential ?? (await updateCredential())
    this.update({ authSource: credentials.source, githubAccount: credentials.account ?? null })
    if (!credentials.token) {
      throw new UpdateError(
        'UPDATES_AUTH_REQUIRED',
        credentials.failure === 'stored-credential-unavailable'
          ? m().authRequiredUnreadable
          : m().authRequired
      )
    }
    try {
      return { data: await readReleaseJson(path, credentials.token, signal), credentials }
    } catch (error) {
      if (error instanceof UpdateAccessError) {
        throw new UpdateError(
          error.code,
          `${error.message}${m().linkedAccount(String(credentials.account))}`
        )
      }
      throw error
    }
  }

  check(): Promise<UpdateStatus> {
    if (this.disposed) return Promise.reject(new UpdateError('UPDATES_CLOSED', m().closing))
    if (this.authenticating) return Promise.reject(new UpdateError('UPDATES_BUSY', m().busyAuth))
    if (this.checking) return this.checking
    if (this.state.phase === 'downloading' || this.state.phase === 'installing')
      return Promise.reject(new UpdateError('UPDATES_BUSY', m().busyUpdate))
    this.checking = this.checkNow()
      .finally(() => {
        this.checking = null
        this.update({})
        this.schedule()
      })
      .then(() => this.snapshot())
    return this.checking
  }

  /** Only the explicit UI command enters interactive OAuth, then verifies releases. */
  authenticate(): Promise<UpdateStatus> {
    if (this.disposed) return Promise.reject(new UpdateError('UPDATES_CLOSED', m().closing))
    if (
      this.authenticating ||
      this.checking ||
      ['downloading', 'installing'].includes(this.state.phase)
    ) {
      return Promise.reject(new UpdateError('UPDATES_BUSY', m().busyOperation))
    }
    this.authenticating = this.authenticateNow()
      .finally(() => {
        this.authenticating = null
        this.update({})
        this.schedule()
      })
      .then(() => this.snapshot())
    return this.authenticating
  }

  async cancelAuthentication(): Promise<UpdateStatus> {
    const pending = this.authenticating
    if (!pending || this.state.phase !== 'authenticating') return this.snapshot()
    this.active?.abort()
    await pending.catch(() => {})
    return this.snapshot()
  }

  private async authenticateNow(): Promise<UpdateStatus> {
    await this.load()
    if (this.disposed) throw new UpdateError('UPDATES_CLOSED', m().closing)
    const controller = new AbortController()
    this.active = controller
    this.update({ phase: 'authenticating', errorCode: undefined, message: m().authInProgress })
    let credentials: UpdateCredential
    try {
      // Once OAuth has returned, complete the atomic save before another action can report
      // cancellation; the stored session must match the visible result.
      credentials = await authenticateGithub(controller.signal, () =>
        this.update({ phase: 'checking', message: m().authSaving })
      )
      if (controller.signal.aborted || this.disposed)
        throw new UpdateError('UPDATES_AUTH_CANCELLED', m().authCancelled)
      this.update({ authSource: credentials.source, githubAccount: credentials.account ?? null })
      this.deps.returnToApp()
    } catch (error) {
      if (
        error instanceof UpdateError &&
        error.code === 'UPDATES_AUTH_CANCELLED' &&
        !this.disposed
      ) {
        this.update({ phase: 'idle', errorCode: undefined, message: m().authCancelledNotice })
        return this.snapshot()
      }
      throw this.fail(error)
    } finally {
      if (this.active === controller) this.active = null
    }
    // Bypass the public busy guard for this continuation while the whole authentication +
    // check operation stays locked, using the credential this login returned.
    return this.checkNow(credentials)
  }

  private async checkNow(linkedCredential?: UpdateCredential): Promise<UpdateStatus> {
    await this.load()
    if (this.disposed) throw new UpdateError('UPDATES_CLOSED', m().closing)
    const controller = new AbortController()
    this.active = controller
    this.update({ phase: 'checking', errorCode: undefined, message: m().checking })
    try {
      const development = this.state.installation === 'development'
      const currentBase = stableVersion(
        development ? this.state.currentVersion.replace(/-dev$/, '') : this.state.currentVersion
      )
      if (!currentBase) throw new UpdateError('UPDATES_VERSION', m().versionUnstable)
      // The release pipeline publishes monotonically increasing stable versions. Compare the
      // 100 most recent releases semantically instead of trusting a manually retargeted Latest.
      const { data } = await this.releaseMetadata(
        '/releases?per_page=100&page=1',
        controller.signal,
        linkedCredential
      )
      if (!Array.isArray(data) || data.length > 100)
        throw new UpdateError('UPDATES_RESPONSE', m().releaseListInvalid)
      const choices = data.map(candidate).filter((entry): entry is ReleaseCandidate => !!entry)
      choices.sort((a, b) => compareVersions(b.view.version, a.view.version))
      const latest = choices[0]
      const checkedAt = new Date().toISOString()
      if (!latest) throw new UpdateError('UPDATES_NO_RELEASE', m().noRelease)
      if (compareVersions(latest.view.version, currentBase) <= 0) {
        await this.removeStaged()
        this.candidate = null
        this.update({
          phase: 'up-to-date',
          checkedAt,
          release: latest.view,
          download: null,
          message: development ? m().upToDateDev(currentBase, latest.view.version) : m().upToDate
        })
      } else {
        if (
          this.staged?.version !== latest.view.version ||
          this.candidate?.installer.id !== latest.installer.id ||
          this.candidate?.installer.digest !== latest.installer.digest
        ) {
          await this.removeStaged()
        }
        this.candidate = latest
        const suffix =
          this.state.installation === 'development'
            ? m().suffixDevelopment
            : this.state.installation === 'portable'
              ? m().suffixPortable
              : this.state.installation === 'unsupported'
                ? m().suffixUnsupported
                : ''
        this.update({
          phase: this.staged ? 'downloaded' : 'available',
          checkedAt,
          release: latest.view,
          download: this.staged ? this.state.download : null,
          message: m().available(
            latest.view.version,
            `${suffix}${latest.view.checksum === 'unavailable' ? m().suffixNoChecksum : ''}`
          )
        })
      }
      return this.snapshot()
    } catch (error) {
      throw this.fail(error)
    } finally {
      if (this.active === controller) this.active = null
    }
  }

  async download(): Promise<UpdateStatus> {
    await this.load()
    if (!this.snapshot().canDownload || !this.candidate)
      throw new UpdateError('UPDATES_DOWNLOAD_STATE', m().downloadState)
    const selected = this.candidate
    const controller = new AbortController()
    this.active = controller
    this.update({
      phase: 'downloading',
      errorCode: undefined,
      download: {
        receivedBytes: 0,
        totalBytes: selected.installer.size,
        percent: 0,
        verified: false
      },
      message: m().downloading
    })
    let temporary: string | undefined
    try {
      // Re-read this exact release before writing bytes: an asset may have been replaced since check.
      const { data, credentials } = await this.releaseMetadata(
        `/releases/${selected.releaseId}`,
        controller.signal
      )
      const fresh = candidateFromExact(data, selected)
      let expectedHash = fresh.installer.digest
      if (fresh.checksums) {
        const manifest = (
          await readReleaseBytes(`${UPDATE_API_ROOT}/releases/assets/${fresh.checksums.id}`, {
            token: credentials.token,
            asset: true,
            maxBytes: 1024 * 1024,
            signal: controller.signal
          })
        ).toString('utf8')
        const matching = manifest
          .split(/\r?\n/)
          .map((line) => /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim()))
          .filter((match) => match?.[2] === fresh.installer.name)
        if (matching.length !== 1) throw new UpdateError('UPDATES_CHECKSUM', m().checksumNotUnique)
        const manifestHash = matching[0]![1].toLowerCase()
        if (expectedHash && expectedHash !== manifestHash)
          throw new UpdateError('UPDATES_CHECKSUM', m().checksumConflict)
        expectedHash = manifestHash
      }
      const directory = join(app.getPath('userData'), 'updates')
      await mkdir(directory, { recursive: true })
      temporary = join(
        directory,
        `${UPDATE_PACKAGE_NAME}-${fresh.view.version}-${randomUUID()}.exe.part`
      )
      const downloaded = await downloadReleaseAsset(
        fresh.installer.id,
        temporary,
        fresh.installer.size,
        {
          token: credentials.token,
          signal: controller.signal,
          progress: (receivedBytes) =>
            this.update({
              download: {
                receivedBytes,
                totalBytes: fresh.installer.size,
                percent: Math.floor((receivedBytes / fresh.installer.size) * 100),
                verified: false
              }
            })
        }
      )
      if (expectedHash && downloaded.sha256 !== expectedHash)
        throw new UpdateError('UPDATES_INTEGRITY', m().integrityMismatch)
      const signature = await open(temporary, 'r')
      try {
        const header = Buffer.alloc(2)
        await signature.read(header, 0, 2, 0)
        if (header.toString('ascii') !== 'MZ')
          throw new UpdateError('UPDATES_FORMAT', m().notWindowsExecutable)
      } finally {
        await signature.close()
      }
      const finalPath = temporary.slice(0, -5)
      await rename(temporary, finalPath)
      temporary = undefined
      this.staged = {
        path: finalPath,
        sha256: downloaded.sha256,
        expectedHash,
        size: downloaded.size,
        version: fresh.view.version
      }
      this.candidate = fresh
      this.update({
        phase: 'downloaded',
        release: fresh.view,
        download: {
          receivedBytes: downloaded.size,
          totalBytes: downloaded.size,
          percent: 100,
          sha256: downloaded.sha256,
          verified: !!expectedHash
        },
        message: expectedHash ? m().downloadedVerified : m().downloadedUnverified
      })
      return this.snapshot()
    } catch (error) {
      if (temporary) await unlink(temporary).catch(() => {})
      throw this.fail(error)
    } finally {
      if (this.active === controller) this.active = null
      this.schedule()
    }
  }

  async install(): Promise<UpdateStatus> {
    // A restart during an AI turn would abandon the move in flight: the game comes first.
    if (this.deps.isBusy()) throw new UpdateError('UPDATES_BUSY_GAME', m().busyGame)
    if (!this.snapshot().canInstall || !this.staged)
      throw new UpdateError('UPDATES_INSTALL_STATE', m().installState)
    const staged = this.staged
    this.update({ phase: 'installing', errorCode: undefined, message: m().finalVerification })
    try {
      if (compareVersions(staged.version, app.getVersion()) <= 0)
        throw new UpdateError('UPDATES_VERSION', m().notNewer)
      const hash = await fileHash(staged.path, staged.size)
      if (this.disposed) throw new UpdateError('UPDATES_CLOSED', m().closing)
      if (hash !== staged.sha256 || (staged.expectedHash && hash !== staged.expectedHash)) {
        await this.removeStaged()
        throw new UpdateError('UPDATES_INTEGRITY', m().integrityChangedLocally)
      }
      await new Promise<void>((resolve, reject) => {
        // electron-builder's bundled NSIS installSection.nsh restarts assisted installers when
        // both Silent and isForceRun are set; --updated preserves existing app data. These flags
        // run only after the explicit Install and restart command. Preserve the current install
        // directory, including custom locations: pins and NSIS's keep-shortcuts detection depend
        // on the executable path. NSIS requires /D to be the final argument.
        const child = spawn(
          staged.path,
          ['/S', '--updated', '--force-run', `/D=${dirname(app.getPath('exe'))}`],
          {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
            // NSIS parses /D as the raw, unquoted command-line suffix. libuv's normal quoting
            // would wrap paths containing spaces and hide that flag. Quote only argv[0];
            // Windows paths cannot contain a double quote.
            windowsVerbatimArguments: true,
            argv0: '"' + staged.path + '"',
            // Never leave the installer holding the old installation directory open.
            cwd: dirname(staged.path)
          }
        )
        child.once('error', () =>
          reject(new UpdateError('UPDATES_INSTALL', m().installerNotStarted))
        )
        child.once('spawn', () => {
          child.unref()
          resolve()
        })
      })
      this.update({ message: m().installStarted })
      this.deps.quitForInstaller()
      return this.snapshot()
    } catch (error) {
      throw this.fail(error)
    }
  }

  releaseUrl(): string {
    return this.state.release?.url ?? `${UPDATE_REPOSITORY_URL}/releases`
  }

  private async removeStaged(): Promise<void> {
    if (this.staged) await unlink(this.staged.path).catch(() => {})
    this.staged = null
  }

  private async cleanObsoleteDownloads(): Promise<void> {
    const directory = join(app.getPath('userData'), 'updates')
    try {
      const files = await readdir(directory)
      for (const name of files.slice(0, 200)) {
        const match =
          /^ChessAdvisor-(\d+\.\d+\.\d+)-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.exe(?:\.part)?$/.exec(
            name
          )
        if (!match || !stableVersion(match[1])) continue
        const path = join(directory, name)
        if (path === this.staged?.path) continue
        const info = await lstat(path)
        if (!info.isFile()) continue
        if (
          (stableVersion(this.state.currentVersion) &&
            compareVersions(match[1], this.state.currentVersion) <= 0) ||
          Date.now() - info.mtimeMs > 7 * 24 * 60 * 60_000
        ) {
          await unlink(path).catch(() => {}) // Windows retains a locked installer until a later launch.
        }
      }
    } catch {
      /* Optional cleanup must not delay or block startup. */
    }
  }

  dispose(): void {
    this.disposed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer)
    this.cleanupTimer = undefined
    this.active?.abort()
    // The installer may still need its staged file; never delete it while starting installation.
    if (this.state.phase !== 'installing') void this.removeStaged()
  }
}

function candidateFromExact(value: unknown, selected: ReleaseCandidate): ReleaseCandidate {
  const fresh = candidate(value)
  if (
    !fresh ||
    fresh.releaseId !== selected.releaseId ||
    fresh.view.version !== selected.view.version ||
    fresh.installer.id !== selected.installer.id ||
    fresh.installer.size !== selected.installer.size
  ) {
    throw new UpdateError('UPDATES_CHANGED', m().releaseChanged)
  }
  return fresh
}
