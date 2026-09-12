import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Api, AppVersionInfo, StreamEnvelope } from '@shared/types/api'
import type { Settings } from '@shared/types/settings'
import { UPDATES_IPC, type UpdatePreferences, type UpdateStatus } from '@shared/updates'

type Channel = 'stream' | 'settings:changed' | 'updates:changed'

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
    showWindow: () => ipcRenderer.invoke('app:showWindow') as Promise<void>,
    // --- Task 5: updater and licences ---
    versionInfo: () => ipcRenderer.invoke('app:versionInfo') as Promise<AppVersionInfo>,
    readNotices: () => ipcRenderer.invoke('app:readNotices') as Promise<string>
  },
  // --- Task 5: in-app updater ---
  updates: {
    status: () => ipcRenderer.invoke(UPDATES_IPC.status) as Promise<UpdateStatus>,
    savePreferences: (preferences: UpdatePreferences) => ipcRenderer.invoke(UPDATES_IPC.preferences, preferences) as Promise<UpdateStatus>,
    check: () => ipcRenderer.invoke(UPDATES_IPC.check) as Promise<UpdateStatus>,
    authenticate: () => ipcRenderer.invoke(UPDATES_IPC.authenticate) as Promise<UpdateStatus>,
    cancelAuthentication: () => ipcRenderer.invoke(UPDATES_IPC.cancelAuthentication) as Promise<UpdateStatus>,
    download: () => ipcRenderer.invoke(UPDATES_IPC.download) as Promise<UpdateStatus>,
    install: () => ipcRenderer.invoke(UPDATES_IPC.install) as Promise<UpdateStatus>,
    openRelease: () => ipcRenderer.invoke(UPDATES_IPC.openRelease) as Promise<void>
  },
  on: ((channel: Channel, cb: (payload: StreamEnvelope | Settings | UpdateStatus) => void) =>
    subscribe(channel, cb as (payload: never) => void)) as Api['on']
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
