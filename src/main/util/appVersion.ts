import { app } from 'electron'
import { TESTED_CODEX_VERSION } from '../codex/protocolVersion'

/**
 * Installed packages always keep the release version written by CI.
 * In development the manifest version is marked `-dev`, so the updater never
 * mistakes a working copy for a published release; `CHESSADVISOR_DEV_VERSION`
 * (baked in by electron-vite) can pin an exact version while testing the flow.
 */
export function getAppVersion(): string {
  if (app.isPackaged) return app.getVersion()
  if (typeof __CHESSADVISOR_DEV_VERSION__ === 'string' && __CHESSADVISOR_DEV_VERSION__) return __CHESSADVISOR_DEV_VERSION__
  return `${app.getVersion().split('+')[0]}-dev`
}

export interface AppVersionInfo {
  version: string
  isPackaged: boolean
  /** Codex CLI version this build was generated and tested against (spec §3.1). */
  testedCodexVersion: string
}

export function getAppVersionInfo(): AppVersionInfo {
  return {
    version: getAppVersion(),
    isPackaged: app.isPackaged,
    testedCodexVersion: TESTED_CODEX_VERSION
  }
}
