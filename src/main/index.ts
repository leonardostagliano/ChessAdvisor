import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BrowserWindow, app, nativeTheme, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { CodexService } from './codex/codexService'
import { userCodexHome } from './codex/codexHome'
import { EngineService } from './engine/engineService'
import { GameManager } from './game/gameManager'
import { emit, handle, registerIpc } from './ipc/register'
import { codexHomeDir, dataDir, pinUserDataPath, resourcePath } from './paths'
import { killStalePids } from './process/runtimeState'
import { cleanupTmp } from './store/atomicWrite'
import { GameStore } from './store/gameStore'
import { ProfileStore } from './store/profileStore'
import { SettingsStore } from './store/settingsStore'
import { createTray, type TrayHandle } from './tray'
import { registerUpdates } from './updates/register'
import { shutdown } from './util/shutdown'
import { WINDOWS_APP_ID, repairPinnedShortcuts } from './util/windowsIdentity'

// FIRST of all: fixed data folder (the single-instance lock and every store live there).
pinUserDataPath()

let mainWindow: BrowserWindow | null = null
let tray: TrayHandle | null = null
let isQuitting = false

const settings = new SettingsStore(join(dataDir(), 'settings.json'))

// --- Task 7: Stockfish engine ---
const engine = new EngineService({ settings, resourcePath, emit })
shutdown.register(() => engine.shutdown())
// --- end Task 7 ---
// Task 6: the Codex session. `CHESSADVISOR_FAKE_CODEX=1` swaps the real CLI for the fake
// app-server, so a development run never consumes OpenAI quota.
const fakeCodex =
  process.env.CHESSADVISOR_FAKE_CODEX === '1'
    ? { exe: process.execPath, args: [resolve(app.getAppPath(), 'test/fake-app-server.mjs')] }
    : undefined
const codex = new CodexService({
  settings,
  codexHomeDir: codexHomeDir(),
  userHome: userCodexHome(),
  dataDir: dataDir(),
  emit: (channel, payload) => emit(channel, payload),
  fake: fakeCodex,
  // In development `process.execPath` is the Electron binary: it only runs a script as Node
  // with this flag, which must never leak into the environment of the real CLI.
  env: fakeCodex ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : undefined
})
shutdown.register(() => codex.shutdown())

// --- Task 9: the active game ---
// One session for the whole process: it owns the board, the opponent thread and the autosave.
const games = new GameStore(join(dataDir(), 'games'))
const profile = new ProfileStore(join(dataDir(), 'profile.json'))
const game = new GameManager({ codex, engine, store: games, settings, profile, emit })
// The turn is interrupted and the game stays `in_progress` on disk (spec §4.3).
shutdown.register(() => game.shutdown())
// --- end Task 9 ---

/** The updater (Task 5) and the tray menu quit through here so `close` stops hiding the window. */
export function setQuitting(value: boolean): void {
  isQuitting = value
}

/** electron-vite emits the preload as ESM (`.mjs`) or CJS (`.js`) depending on the build. */
function resolvePreload(): string {
  const esm = join(__dirname, '../preload/index.mjs')
  return existsSync(esm) ? esm : join(__dirname, '../preload/index.js')
}

function showMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
    return
  }
  createWindow()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 1024,
    minHeight: 680,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141517' : '#f6f2ea',
    title: 'ChessAdvisor',
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: resolvePreload(),
      contextIsolation: true,
      nodeIntegration: false,
      // the preload is an ESM bundle: the Chromium sandbox cannot load it
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // The X button keeps the app running in the notification area; only an explicit quit exits.
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    mainWindow?.hide()
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Must match the installer shortcut identity, before Windows sees any window.
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId(WINDOWS_APP_ID)

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showMainWindow())

  app.whenReady().then(async () => {
    await settings.load().catch((error) => {
      console.error('[main] settings could not be loaded, using the defaults:', error)
      return undefined
    })
    // Task 9: the archive index and the profile are read once, before the first IPC call.
    await games.load().catch((error) => console.error('[main] the games archive could not be read:', error))
    await profile.load().catch((error) => console.error('[main] the profile could not be read:', error))
    registerIpc({ settings, showWindow: showMainWindow, engine, codex, games, game })
    // In-app updater: never installs while a game turn is in flight.
    registerUpdates({
      handle,
      settings,
      getWindow: () => mainWindow,
      setQuitting,
      isBusy: () => game.isBusy()
    })
    // A previous crash may have left a codex/stockfish child running: never talk to a zombie.
    await killStalePids().catch(() => [])
    await cleanupTmp(dataDir()).catch(() => 0)

    createWindow()
    // The engine probe spawns a child process: never let it delay the first paint.
    void engine.start().catch((error) => console.error('[main] the chess engine could not start:', error))
    // Repair this app's existing pins after an NSIS replacement, without delaying first paint.
    mainWindow?.once('ready-to-show', () => {
      void repairPinnedShortcuts().catch(() => undefined)
    })
    tray = createTray({
      onShow: showMainWindow,
      onQuit: () => {
        isQuitting = true
        app.quit()
      },
      language: settings.get().language
    })
    tray.update('ChessAdvisor — inattivo')
    app.on('activate', () => showMainWindow())

    // The renderer follows `codex:state`; a boot failure is a screen, never a crash.
    void codex.start().catch((error) => console.error('[main] Codex service failed to start:', error))
  })

  // On Windows the app lives in the tray after the last window is closed.
  app.on('window-all-closed', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') return
    app.quit()
  })

  let cleanupComplete = false
  let cleanupStarted = false
  app.on('before-quit', (event) => {
    isQuitting = true
    tray?.destroy()
    tray = null
    if (cleanupComplete) return
    event.preventDefault()
    if (cleanupStarted) return
    cleanupStarted = true
    void shutdown.run().then(() => {
      cleanupComplete = true
      app.quit()
    })
  })
}
