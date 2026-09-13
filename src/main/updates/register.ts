import { BrowserWindow, app, shell } from 'electron'
import type { Settings } from '@shared/types/settings'
import { UPDATES_IPC, type UpdatePreferences } from '@shared/updates'
import type { SettingsStore } from '../store/settingsStore'
import { m, setUpdatesLanguage } from './messages'
import { AppUpdateService } from './service'
import { UpdateError } from './transport'

export interface RegisterUpdatesDeps {
  handle<T>(channel: string, fn: (...args: any[]) => Promise<T>): void
  settings: SettingsStore
  getWindow(): BrowserWindow | null
  /** Sets the main-process `isQuitting` flag so `close` stops hiding to tray. */
  setQuitting(value: boolean): void
  /** True while a game turn is running (Task 9 supplies the real flag). */
  isBusy?(): boolean
}

/** Wires the updater to IPC, Settings and the window lifecycle. Returns the live service. */
export function registerUpdates(deps: RegisterUpdatesDeps): AppUpdateService {
  setUpdatesLanguage(deps.settings.get().language)

  const service = new AppUpdateService({
    changed: (status) => {
      for (const window of BrowserWindow.getAllWindows()) {
        try {
          if (!window.isDestroyed() && !window.webContents.isDestroyed())
            window.webContents.send(UPDATES_IPC.changed, status)
        } catch {
          /* A window can close while the process emits download progress. */
        }
      }
    },
    quitForInstaller: () => {
      deps.setQuitting(true)
      // Let the IPC reply settle, then release executable locks immediately. Cleanup has its own
      // bounded deadline; a fixed delay would only make NSIS retry or force-close the old app.
      setImmediate(() => app.quit())
    },
    returnToApp: () => {
      // Only a user-initiated browser login returns focus; automatic release checks do not.
      try {
        const window = deps.getWindow()
        if (!window || window.isDestroyed()) return
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      } catch {
        /* Closing a window must not turn a successful OAuth login into an error. */
      }
    },
    preferences: {
      get: () => ({ autoCheck: deps.settings.get().updates.autoCheck }),
      save: async (preferences: UpdatePreferences) => {
        await deps.settings.save({ updates: { autoCheck: preferences.autoCheck } })
      }
    },
    isBusy: () => deps.isBusy?.() ?? false
  })

  const unsubscribe = deps.settings.onChange((settings: Settings) => {
    setUpdatesLanguage(settings.language)
    service.preferencesChanged({ autoCheck: settings.updates.autoCheck })
  })

  deps.handle(UPDATES_IPC.status, () => service.status())
  deps.handle(UPDATES_IPC.preferences, (preferences: UpdatePreferences) =>
    service.savePreferences(preferences)
  )
  deps.handle(UPDATES_IPC.check, () => service.check())
  deps.handle(UPDATES_IPC.authenticate, () => service.authenticate())
  deps.handle(UPDATES_IPC.cancelAuthentication, () => service.cancelAuthentication())
  deps.handle(UPDATES_IPC.download, () => service.download())
  deps.handle(UPDATES_IPC.install, () => service.install())
  deps.handle(UPDATES_IPC.openRelease, async () => {
    try {
      await shell.openExternal(service.releaseUrl())
      return { opened: true as const }
    } catch {
      throw new UpdateError('UPDATES_BROWSER', m().browserFailed)
    }
  })

  // A failed optional preference read cannot block the application bootstrap.
  void service.start().catch(() => {})
  app.once('before-quit', () => {
    unsubscribe()
    service.dispose()
  })
  return service
}
