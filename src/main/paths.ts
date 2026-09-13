import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * FIXED name of the user data folder: %APPDATA%\chessadvisor (settings.json, data/, codex-home/).
 * Never change it: users would lose their games, their profile and their Codex thread history.
 */
export const USER_DATA_DIR_NAME = 'chessadvisor'

/**
 * Pins userData regardless of package.json (`name`/`productName`), so renaming the package
 * cannot move the data. Must be the FIRST statement of the main process: the single-instance
 * lock file and every store live in there.
 *
 * The folder is created BEFORE setPath because Electron throws when the path does not exist.
 * Everything is wrapped: if mkdir or setPath fail we log and keep Electron's default path
 * (which is the same folder) instead of crashing before `whenReady`.
 */
export function pinUserDataPath(): void {
  try {
    // Test harnesses (test/e2e) point the whole data folder elsewhere so a run never touches
    // the user's games; Electron itself ignores the APPDATA environment variable on Windows.
    const override = process.env.CHESSADVISOR_USER_DATA?.trim()
    const dir = override ? override : join(app.getPath('appData'), USER_DATA_DIR_NAME)
    mkdirSync(dir, { recursive: true })
    app.setPath('userData', dir)
  } catch (error) {
    console.error('[paths] could not pin userData, falling back to the default path:', error)
  }
}

/** userData/data — games, profile, runtime bookkeeping. Created on demand. */
export function dataDir(): string {
  const dir = join(app.getPath('userData'), 'data')
  try {
    mkdirSync(dir, { recursive: true })
  } catch (error) {
    console.error('[paths] could not create the data folder:', error)
  }
  return dir
}

/** Dedicated CODEX_HOME: game threads never run against the user's own ~/.codex. */
export function codexHomeDir(): string {
  return join(app.getPath('userData'), 'codex-home')
}

/** Bundled resources (engine binaries, datasets, licenses) in dev and in the packaged app. */
export function resourcePath(...segs: string[]): string {
  return app.isPackaged ? join(process.resourcesPath, ...segs) : join(app.getAppPath(), 'resources', ...segs)
}
