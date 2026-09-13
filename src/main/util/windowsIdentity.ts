import { readdir } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { app, shell, type ShortcutDetails } from 'electron'

// Keep these values aligned with electron-builder.yml across every release.
export const WINDOWS_APP_ID = 'it.stagliano.chessadvisor'
export const WINDOWS_EXECUTABLE_NAME = 'ChessAdvisor.exe'

const samePath = (left: string, right: string): boolean =>
  win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase()

/** Only our installed executable, or our identified NSIS-moved predecessor, can be repaired. */
export function pinnedShortcutRepair(
  shortcut: ShortcutDetails,
  executable: string,
  tempDirectory: string
): ShortcutDetails | null {
  if (
    win32.basename(executable) !== WINDOWS_EXECUTABLE_NAME ||
    win32.basename(shortcut.target).toLowerCase() !== WINDOWS_EXECUTABLE_NAME.toLowerCase()
  )
    return null
  if (!samePath(shortcut.target, executable)) {
    // Windows link tracking may follow the old executable when NSIS moves it
    // into its temporary rollback directory. Do not redirect a different install.
    const relative = win32.relative(tempDirectory, shortcut.target)
    const identified =
      shortcut.appUserModelId === WINDOWS_APP_ID || samePath(shortcut.icon ?? '', executable)
    if (!identified || !/^ns[a-z0-9]+\.tmp\\old-install\\[^\\]+$/i.test(relative)) return null
  }
  const cwd = win32.dirname(executable)
  if (
    samePath(shortcut.target, executable) &&
    shortcut.appUserModelId === WINDOWS_APP_ID &&
    samePath(shortcut.cwd ?? '', cwd) &&
    samePath(shortcut.icon ?? '', executable) &&
    shortcut.iconIndex === 0
  )
    return null
  // update changes only these properties, preserving user arguments, description,
  // and the existing pin itself; it never creates/re-pins a deleted shortcut.
  return { target: executable, cwd, icon: executable, iconIndex: 0, appUserModelId: WINDOWS_APP_ID }
}

export async function repairPinnedShortcuts(): Promise<void> {
  if (
    !app.isPackaged ||
    process.platform !== 'win32' ||
    process.env.PORTABLE_EXECUTABLE_DIR ||
    process.env.PORTABLE_EXECUTABLE_FILE
  )
    return
  const executable = app.getPath('exe')
  if (win32.basename(executable) !== WINDOWS_EXECUTABLE_NAME) return
  const directory = join(
    app.getPath('appData'),
    'Microsoft',
    'Internet Explorer',
    'Quick Launch',
    'User Pinned',
    'TaskBar'
  )
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.slice(0, 200)) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.lnk')) continue
    // Yield between shell calls so a user's large taskbar cannot stall painting.
    await new Promise<void>((resolve) => setImmediate(resolve))
    try {
      const path = join(directory, entry.name)
      const repair = pinnedShortcutRepair(
        shell.readShortcutLink(path),
        executable,
        app.getPath('temp')
      )
      if (repair) shell.writeShortcutLink(path, 'update', repair)
    } catch {
      /* Missing/inaccessible pins are optional and must not block startup. */
    }
  }
}
