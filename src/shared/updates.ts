/**
 * Contract of the in-app updater, shared by main, preload and renderer.
 * The main process owns every network call; the renderer only renders this status.
 */

export const UPDATES_IPC = {
  status: 'updates:status',
  preferences: 'updates:preferences',
  check: 'updates:check',
  authenticate: 'updates:authenticate',
  cancelAuthentication: 'updates:cancel-authentication',
  download: 'updates:download',
  install: 'updates:install',
  openRelease: 'updates:openRelease',
  changed: 'updates:changed'
} as const

export interface UpdatePreferences {
  autoCheck: boolean
}

export type UpdatePhase =
  | 'idle'
  | 'authenticating'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface UpdateRelease {
  version: string
  tag: string
  publishedAt: string
  url: string
  notes: string
  assetName: string
  assetSize: number
  checksum: 'sha256sums' | 'github-digest' | 'unavailable'
}

export interface UpdateDownload {
  receivedBytes: number
  totalBytes: number
  percent: number
  sha256?: string
  verified: boolean
}

export interface UpdateStatus {
  revision: number
  phase: UpdatePhase
  currentVersion: string
  installation: 'development' | 'portable' | 'installed' | 'unsupported'
  repository: string
  repositoryUrl: string
  preferences: UpdatePreferences
  checkedAt: string | null
  authSource: 'not-checked' | 'github-app' | 'anonymous'
  githubAccount: string | null
  release: UpdateRelease | null
  download: UpdateDownload | null
  canDownload: boolean
  canInstall: boolean
  message: string
  errorCode?: string
}

/**
 * Renderer-facing surface. ChessAdvisor IPC rejects on failure (see `src/main/ipc/register.ts`),
 * so these methods throw instead of returning a result envelope.
 */
export interface UpdatesApi {
  status(): Promise<UpdateStatus>
  savePreferences(preferences: UpdatePreferences): Promise<UpdateStatus>
  check(): Promise<UpdateStatus>
  authenticate(): Promise<UpdateStatus>
  cancelAuthentication(): Promise<UpdateStatus>
  download(): Promise<UpdateStatus>
  install(): Promise<UpdateStatus>
  openRelease(): Promise<void>
}
