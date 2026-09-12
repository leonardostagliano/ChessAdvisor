import type { Settings } from './settings'
import type { UpdateStatus, UpdatesApi } from '../updates'

/** Version identity of the running build (Task 5). */
export interface AppVersionInfo {
  version: string
  isPackaged: boolean
}

/** Delta envelope pushed on the `stream` channel while a turn is running. */
export interface StreamEnvelope {
  streamId: string
  threadId: string
  turnId: string
  itemId: string
  kind: 'text' | 'reasoning' | 'progress' | 'eval'
  chunk: string
}

export interface Api {
  settings: { get(): Promise<Settings>; save(patch: Partial<Settings>): Promise<Settings> }
  app: {
    version(): Promise<string>
    openExternal(url: string): Promise<void>
    showWindow(): Promise<void>
    // --- Task 5: updater and licences ---
    versionInfo(): Promise<AppVersionInfo>
    readNotices(): Promise<string>
  }
  on(channel: 'stream', cb: (e: StreamEnvelope) => void): () => void
  on(channel: 'settings:changed', cb: (s: Settings) => void): () => void
  // --- Task 5: in-app updater ---
  updates: UpdatesApi
  on(channel: 'updates:changed', cb: (s: UpdateStatus) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}
