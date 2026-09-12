import type { CodexState, ModelInfo, QuotaSnapshot } from './codex'
import type { Settings } from './settings'

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
  app: { version(): Promise<string>; openExternal(url: string): Promise<void>; showWindow(): Promise<void> }
  on(channel: 'stream', cb: (e: StreamEnvelope) => void): () => void
  on(channel: 'settings:changed', cb: (s: Settings) => void): () => void

  // --- Task 6: Codex session ---------------------------------------------------------------
  codex: {
    state(): Promise<CodexState>
    retry(): Promise<void>
    models(): Promise<ModelInfo[]>
    quota(): Promise<QuotaSnapshot | null>
  }
  on(channel: 'codex:state', cb: (s: CodexState) => void): () => void
}

declare global {
  interface Window {
    api: Api
  }
}
