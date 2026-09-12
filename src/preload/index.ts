import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Api, StreamEnvelope } from '@shared/types/api'
import type { Game, GameFilter, GameSummary } from '@shared/types/game'
import type { CodexState, ModelInfo, QuotaSnapshot } from '@shared/types/codex'
import type { Settings } from '@shared/types/settings'
import type { Analysis, AnalysisProfile, EngineState } from '@shared/types/engine'

type Channel = 'stream' | 'settings:changed' | 'engine:state' | 'codex:state'

function subscribe(channel: Channel, cb: (payload: never) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: unknown): void => cb(payload as never)
  ipcRenderer.on(channel, listener)
  // Removing exactly this listener keeps other subscribers of the same channel alive.
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const api: Api = {
  settings: {
    get: () => ipcRenderer.invoke('settings:get') as Promise<Settings>,
    save: (patch: Partial<Settings>) => ipcRenderer.invoke('settings:save', patch) as Promise<Settings>
  },
  app: {
    version: () => ipcRenderer.invoke('app:version') as Promise<string>,
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url) as Promise<void>,
    showWindow: () => ipcRenderer.invoke('app:showWindow') as Promise<void>
  },
  // --- Task 7: Stockfish engine ---
  engine: {
    state: () => ipcRenderer.invoke('engine:state') as Promise<EngineState>,
    analyze: (fen: string, profile: AnalysisProfile) => ipcRenderer.invoke('engine:analyze', fen, profile) as Promise<Analysis>
  },
  // --- end Task 7 ---
  // ── Task 8: games archive ──
  games: {
    list: (filter?: GameFilter) => ipcRenderer.invoke('games:list', filter) as Promise<GameSummary[]>,
    get: (id: string) => ipcRenderer.invoke('games:get', id) as Promise<Game | null>,
    delete: (id: string) => ipcRenderer.invoke('games:delete', id) as Promise<void>
  },
  // --- Task 6: Codex session ---------------------------------------------------------------
  codex: {
    state: () => ipcRenderer.invoke('codex:state') as Promise<CodexState>,
    retry: () => ipcRenderer.invoke('codex:retry') as Promise<void>,
    models: () => ipcRenderer.invoke('codex:models') as Promise<ModelInfo[]>,
    quota: () => ipcRenderer.invoke('codex:quota') as Promise<QuotaSnapshot | null>
  },
  on: ((channel: Channel, cb: (payload: StreamEnvelope & Settings & EngineState & CodexState) => void) => subscribe(channel, cb as (payload: never) => void)) as Api['on']
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error('[preload] contextBridge exposure failed:', error)
  }
} else {
  // @ts-ignore (declared in index.d.ts)
  window.electron = electronAPI
  // @ts-ignore (declared in @shared/types/api)
  window.api = api
}
