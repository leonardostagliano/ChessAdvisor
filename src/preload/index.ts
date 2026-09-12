import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Api, StreamEnvelope } from '@shared/types/api'
import type { Game, GameFilter, GameSummary } from '@shared/types/game'
import type { Settings } from '@shared/types/settings'

type Channel = 'stream' | 'settings:changed'

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
  on: ((channel: Channel, cb: (payload: StreamEnvelope & Settings) => void) => subscribe(channel, cb as (payload: never) => void)) as Api['on'],
  // ── Task 8: games archive ──
  games: {
    list: (filter?: GameFilter) => ipcRenderer.invoke('games:list', filter) as Promise<GameSummary[]>,
    get: (id: string) => ipcRenderer.invoke('games:get', id) as Promise<Game | null>,
    delete: (id: string) => ipcRenderer.invoke('games:delete', id) as Promise<void>
  }
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
