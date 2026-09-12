import { BrowserWindow, app, ipcMain, shell } from 'electron'
import type { Settings } from '@shared/types/settings'
import type { Analysis, AnalysisProfile, EngineState } from '@shared/types/engine'
import type { SettingsStore } from '../store/settingsStore'

/** Error shape the renderer receives: the message alone would lose the machine-readable code. */
export interface SerializedError {
  code: string
  message: string
}

export class IpcError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(`${code}: ${message}`)
    this.name = 'IpcError'
  }
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const code = typeof (error as NodeJS.ErrnoException).code === 'string' ? String((error as NodeJS.ErrnoException).code) : 'E_UNEXPECTED'
    return { code, message: error.message }
  }
  return { code: 'E_UNEXPECTED', message: String(error) }
}

/** ipcMain.handle with a uniform error contract: handlers never leak a raw stack to the renderer. */
export function handle<T>(channel: string, fn: (...args: any[]) => Promise<T>): void {
  ipcMain.removeHandler(channel)
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return await fn(...args)
    } catch (error) {
      const serialized = serializeError(error)
      console.error(`[ipc] ${channel} failed:`, serialized.code, serialized.message)
      throw new IpcError(serialized.code, serialized.message)
    }
  })
}

/** Pushes an event to every live window (streams, settings changes, update state). */
export function emit(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue
    window.webContents.send(channel, payload)
  }
}

// --- Task 7: Stockfish engine ---
/** The slice of EngineService the IPC layer needs; keeps `register.ts` free of engine internals. */
export interface EngineBridge {
  state(): EngineState
  analyze(fen: string, profile: AnalysisProfile): Promise<Analysis>
}

const ANALYSIS_PROFILES: readonly AnalysisProfile[] = ['live', 'coach', 'review']
// --- end Task 7 ---

export interface IpcContext {
  settings: SettingsStore
  showWindow(): void
  // --- Task 7: Stockfish engine (optional: the app runs without an engine) ---
  engine?: EngineBridge
  // --- end Task 7 ---
}

/** Binds the `window.api` surface of Task 3; later tasks add their own namespaces. */
export function registerIpc(ctx: IpcContext): void {
  handle('settings:get', async () => ctx.settings.get())
  handle('settings:save', async (patch: Partial<Settings>) => ctx.settings.save(patch ?? {}))

  handle('app:version', async () => app.getVersion())
  handle('app:openExternal', async (url: string) => {
    // Only real web links leave the app: a file:// or custom scheme here would be an escape hatch.
    const parsed = new URL(String(url))
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new IpcError('E_BAD_URL', `unsupported protocol ${parsed.protocol}`)
    await shell.openExternal(parsed.toString())
  })
  handle('app:showWindow', async () => {
    ctx.showWindow()
  })

  ctx.settings.onChange((settings) => emit('settings:changed', settings))

  // --- Task 7: Stockfish engine ---
  const engine = ctx.engine
  if (engine) {
    handle('engine:state', async () => engine.state())
    handle('engine:analyze', async (fen: string, profile: AnalysisProfile) => {
      if (typeof fen !== 'string' || fen.trim().length === 0) throw new IpcError('E_BAD_FEN', 'a FEN string is required')
      if (!ANALYSIS_PROFILES.includes(profile)) throw new IpcError('E_BAD_PROFILE', `unknown analysis profile ${String(profile)}`)
      return engine.analyze(fen, profile)
    })
  }
  // --- end Task 7 ---
}
