import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { BrowserWindow, app, dialog, nativeTheme, powerMonitor, shell } from 'electron'
import icon from '../../resources/icon.png?asset'
import { AnalysisManager } from './analysis/register'
import { CodexService } from './codex/codexService'
import { PuzzleLibrary } from './data/puzzleLibrary'
import { userCodexHome } from './codex/codexHome'
import { EngineService } from './engine/engineService'
import { GameManager } from './game/gameManager'
import { emit, handle, registerIpc } from './ipc/register'
import { ProfileService } from './profile/profileService'
import { codexHomeDir, dataDir, pinUserDataPath, resourcePath } from './paths'
import { killStalePids } from './process/runtimeState'
import { cleanupTmp } from './store/atomicWrite'
import { ExerciseStore } from './store/exerciseStore'
import { GameStore } from './store/gameStore'
import { ProfileStore } from './store/profileStore'
import { SettingsStore } from './store/settingsStore'
import { migrateLearningData } from './store/learningMigration'
import { StudyPlanStore } from './store/studyPlanStore'
import { TrainingService } from './training/trainingService'
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
// Dedicated queues keep instant move feedback clear of long analysis or opponent searches.
const feedbackEngine = new EngineService({
  settings,
  resourcePath,
  emit: () => {},
  threads: 1,
  hashMb: 32
})
const opponentEngine = new EngineService({
  settings,
  resourcePath,
  emit: () => {},
  threads: 2,
  hashMb: 64
})
shutdown.register(() => feedbackEngine.shutdown())
shutdown.register(() => opponentEngine.shutdown())
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
// --- Task 17: the player profile ---
// Level, themes, openings and history; it is fed by the analysis and read by Progressi (spec §6).
const profileService = new ProfileService({
  codex,
  settings,
  profile,
  games,
  emit: (channel, payload) => emit(channel, payload)
})
// --- Task 15: post-game analysis and review ---
// Owns the pipeline and the review threads; a finished match hands itself to it (spec §3.1).
const analysis = new AnalysisManager({
  codex,
  engine,
  store: games,
  settings,
  emit: (channel, payload) => emit(channel, payload),
  openingsPath: () => resourcePath('data', 'openings.json'),
  // An analysed match updates the profile; a failure there never touches the analysis (spec §6.1).
  // Task 20: the exercises of spec §6.4 are built right after it, never before (they need the
  // themes the profile has just written) and never in the way of the UI.
  onAnalyzed: (analysed) =>
    void profileService
      .onGameAnalyzed(analysed)
      .catch((error) => console.error('[main] the profile update failed:', error))
      .then(() => training.onGameAnalyzed(analysed))
      .catch((error) => console.error('[main] the exercises could not be built:', error))
})
shutdown.register(() => analysis.close())
const game = new GameManager({
  codex,
  engine,
  feedbackEngine,
  opponentEngine,
  openingsPath: () => resourcePath('data', 'openings.json'),
  store: games,
  settings,
  profile,
  emit,
  onFinished: (finished) => {
    analysis.onGameFinished(finished)
    // Task 20: an endgame drill writes its own result (spec §6.7); a match is analysed instead.
    void training
      .onGameFinished(finished)
      .catch((error) => console.error('[main] the endgame result could not be saved:', error))
  }
})
// --- Task 20: the training section ---
// Exercises, thematic sets, openings, endgames and study plan (spec §6.4–§6.8).
const library = new PuzzleLibrary(resourcePath)
const exercises = new ExerciseStore(join(dataDir(), 'exercises.json'))
const plans = new StudyPlanStore(join(dataDir(), 'study-plan.json'))
const training = new TrainingService({
  codex,
  engine,
  settings,
  profile,
  games,
  exercises,
  plans,
  library,
  startGame: (opts) => game.session().newGame(opts),
  emit: (channel, payload) => emit(channel, payload)
})
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
    // Spec §4.3: the board, the eval bar and the side panel need at least this much room.
    minWidth: 1024,
    minHeight: 720,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#17232d' : '#e9eeec',
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
    try {
      await migrateLearningData(dataDir())
    } catch (error) {
      console.error('[main] learning data migration failed:', error)
      dialog.showErrorBox(
        'ChessAdvisor',
        'Impossibile preparare il backup dei dati di apprendimento. Chiudi le altre istanze e riapri ChessAdvisor. Le partite sono conservate.'
      )
      app.quit()
      return
    }
    // Task 9: the archive index and the profile are read once, before the first IPC call.
    await games
      .load()
      .catch((error) => console.error('[main] the games archive could not be read:', error))
    await profile
      .load()
      .catch((error) => console.error('[main] the profile could not be read:', error))
    // Task 20: the training material — two small files and the bundled datasets.
    await exercises
      .load()
      .catch((error) => console.error('[main] the exercises could not be read:', error))
    await plans
      .load()
      .catch((error) => console.error('[main] the study plan could not be read:', error))
    await library
      .load()
      .catch((error) => console.error('[main] the training datasets could not be read:', error))
    registerIpc({
      settings,
      showWindow: showMainWindow,
      engine,
      codex,
      games,
      game,
      analysis,
      profile: profileService,
      training
    })
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
    void engine
      .start()
      .catch((error) => console.error('[main] the chess engine could not start:', error))
    void feedbackEngine
      .start()
      .catch((error) => console.error('[main] feedback engine failed:', error))
    void opponentEngine
      .start()
      .catch((error) => console.error('[main] opponent engine failed:', error))
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

    // A suspended machine skips every clock tick: the flag is checked again on the way back up.
    powerMonitor.on('resume', () => void game.checkClock())

    // The renderer follows `codex:state`; a boot failure is a screen, never a crash.
    void codex
      .start()
      .catch((error) => console.error('[main] Codex service failed to start:', error))
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
