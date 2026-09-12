import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { Api, AppVersionInfo, GameFinished, StreamEnvelope } from '@shared/types/api'
import type { NewGameOptions, SessionState } from '@shared/types/session'
import type { Game, GameFilter, GameSummary } from '@shared/types/game'
import type { CodexState, ModelInfo, QuotaSnapshot } from '@shared/types/codex'
import type { Settings } from '@shared/types/settings'
import type { Analysis, AnalysisProfile, EngineState } from '@shared/types/engine'
import { UPDATES_IPC, type UpdatePreferences, type UpdateStatus } from '@shared/updates'

type Channel = 'stream' | 'settings:changed' | 'engine:state' | 'codex:state' | 'updates:changed' | 'game:state' | 'game:finished'

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
  // ── Task 9: the active game ──
  game: {
    new: (opts: NewGameOptions) => ipcRenderer.invoke('game:new', opts) as Promise<SessionState>,
    resume: (id: string, opts?: { substituteModel?: string }) => ipcRenderer.invoke('game:resume', id, opts) as Promise<SessionState>,
    userMove: (uci: string) => ipcRenderer.invoke('game:userMove', uci) as Promise<SessionState>,
    takeback: () => ipcRenderer.invoke('game:takeback') as Promise<SessionState>,
    resign: () => ipcRenderer.invoke('game:resign') as Promise<SessionState>,
    offerDraw: () => ipcRenderer.invoke('game:offerDraw') as Promise<{ accepted: boolean; reason: string }>,
    navigateEval: (fen: string) => ipcRenderer.invoke('game:navigateEval', fen) as Promise<void>,
    state: () => ipcRenderer.invoke('game:state') as Promise<SessionState>,
    close: () => ipcRenderer.invoke('game:close') as Promise<SessionState>,
    adaptiveElo: () => ipcRenderer.invoke('game:adaptiveElo') as Promise<{ elo: number; games: number } | null>
  },
  // --- Task 6: Codex session ---------------------------------------------------------------
  codex: {
    state: () => ipcRenderer.invoke('codex:state') as Promise<CodexState>,
    retry: () => ipcRenderer.invoke('codex:retry') as Promise<void>,
    models: () => ipcRenderer.invoke('codex:models') as Promise<ModelInfo[]>,
    quota: () => ipcRenderer.invoke('codex:quota') as Promise<QuotaSnapshot | null>
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
  on: ((channel: Channel, cb: (payload: StreamEnvelope & Settings & EngineState & CodexState & UpdateStatus & SessionState & GameFinished) => void) =>
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
