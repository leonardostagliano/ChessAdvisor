import type { Game, GameFilter, GameSummary } from './game'
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
}

declare global {
  interface Window {
    api: Api
  }
}

// ─── Task 8: games archive ────────────────────────────────────────────────────
// Declaration merging keeps this namespace additive: sibling tasks append their own
// `Api` block below without touching the ones already here.

export interface GamesApi {
  /** Archive rows, newest first. */
  list(filter?: GameFilter): Promise<GameSummary[]>
  get(id: string): Promise<Game | null>
  delete(id: string): Promise<void>
}

export interface Api {
  games: GamesApi
}
