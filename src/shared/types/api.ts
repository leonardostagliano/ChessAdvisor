import type { Settings } from './settings'
import type { Analysis, AnalysisProfile, EngineState } from './engine'

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

  // --- Task 7: Stockfish engine ---
  /**
   * Analysis is driven by the main process (GameSession owns the live eval); the renderer only
   * reads the state and, in M3, asks for an explicit analysis of a browsed position.
   */
  engine: {
    state(): Promise<EngineState>
    analyze(fen: string, profile: AnalysisProfile): Promise<Analysis>
  }
  on(channel: 'engine:state', cb: (s: EngineState) => void): () => void
  // --- end Task 7 ---
}

declare global {
  interface Window {
    api: Api
  }
}
