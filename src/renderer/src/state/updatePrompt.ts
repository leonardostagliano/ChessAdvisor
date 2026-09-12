import type { UpdateStatus } from '@shared/updates'

export interface UpdatePromptState {
  status: UpdateStatus | null
  /** Version the dialog is currently offering, or null when nothing is offered. */
  version: string | null
  pending: 'downloading' | 'installing' | null
  error: string
}

/** The slice of `window.api` the prompt needs; injectable so tests need no preload. */
export interface UpdatePromptApi {
  status(): Promise<UpdateStatus>
  download(): Promise<UpdateStatus>
  install(): Promise<UpdateStatus>
  subscribe(cb: (status: UpdateStatus) => void): () => void
}

/** IPC rejections arrive wrapped by Electron: keep only the message the main process wrote. */
export function updateErrorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const match = /(?:UpdateError|IpcError|Error):\s*(?:[A-Z][A-Z0-9_]*:\s*)?([\s\S]+)$/.exec(raw)
  const text = (match?.[1] ?? raw).trim()
  return text.length > 0 ? text : fallback
}

/** Builds the port from the preload bridge; null when the bridge is not available. */
export function updatePromptApi(): UpdatePromptApi | null {
  const bridge = typeof window === 'undefined' ? undefined : window.api
  if (!bridge?.updates || typeof bridge.on !== 'function') return null
  return {
    status: () => bridge.updates.status(),
    download: () => bridge.updates.download(),
    install: () => bridge.updates.install(),
    subscribe: (cb) => bridge.on('updates:changed', cb)
  }
}

/** One consent covers download and installation of the version shown in the dialog. */
export class UpdatePromptController {
  private state: UpdatePromptState = { status: null, version: null, pending: null, error: '' }
  private dismissed = new Set<string>()
  private disposed = false
  private unsubscribe?: () => void

  constructor(
    private readonly api: UpdatePromptApi,
    private readonly changed: (state: UpdatePromptState) => void,
    private readonly messages: { failed: string; releaseChanged: string }
  ) {}

  async start(): Promise<void> {
    this.unsubscribe = this.api.subscribe((status) => this.accept(status))
    // Only read local state: the main process owns automatic network checks.
    try {
      this.accept(await this.api.status())
    } catch {
      /* Optional updates must not interrupt application startup. */
    }
  }

  private emit(patch: Partial<UpdatePromptState>): void {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    this.changed(this.state)
  }

  private accept(status: UpdateStatus): void {
    if (this.disposed || status.revision < (this.state.status?.revision ?? -1)) return
    let version = this.state.version
    if (!this.state.pending) {
      if (!status.preferences.autoCheck || status.installation !== 'installed') version = null
      else if (
        status.release &&
        ['available', 'downloaded'].includes(status.phase) &&
        (status.canDownload || status.canInstall) &&
        !this.dismissed.has(status.release.version)
      ) {
        version = status.release.version
      } else if (status.phase === 'up-to-date' || (version && status.release?.version !== version)) version = null
    }
    this.emit({ status, version, ...(version !== this.state.version ? { error: '' } : {}) })
  }

  dismiss(): void {
    if (this.state.pending || !this.state.version) return
    this.dismissed.add(this.state.version)
    this.emit({ version: null, error: '' })
  }

  async confirm(): Promise<void> {
    const { status, version } = this.state
    if (
      this.disposed ||
      this.state.pending ||
      !version ||
      status?.release?.version !== version ||
      !status.preferences.autoCheck ||
      (!status.canDownload && !status.canInstall)
    ) {
      return
    }
    this.emit({ pending: status.canInstall ? 'installing' : 'downloading', error: '' })
    try {
      if (!status.canInstall) {
        const downloaded = await this.api.download()
        if (this.disposed) return
        this.accept(downloaded)
      }
      const ready = this.state.status
      if (ready?.release?.version !== version || !ready.canInstall) throw new Error(this.messages.releaseChanged)
      this.emit({ pending: 'installing' })
      const installing = await this.api.install()
      if (this.disposed) return
      this.accept(installing)
      // Keep the dialog locked until the installer closes the app.
    } catch (failure) {
      this.emit({ pending: null, error: updateErrorText(failure, this.messages.failed) })
    }
  }

  dispose(): void {
    this.disposed = true
    this.unsubscribe?.()
  }
}
