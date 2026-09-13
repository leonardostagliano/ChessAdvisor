import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { Menu, Tray, nativeImage } from 'electron'
import type { Language } from '@shared/types/settings'
import icon from '../../resources/icon.png?asset'

// Small bundled copy of the application mark. Even if an installation loses an asset,
// the app must remain reachable from the notification area.
const FALLBACK_ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAsTAAALEwEAmpwYAAACkUlEQVRYhdVWz0tUURR+jpvsPxjvufed+wxsk+TWagoCadEiy6LF0KI2/VpYmWQI/WCstEls0SZDaBBsDCpBaREFUWG5KijKTWUZjELgslp447xxnjM6M+/e6Yp04IPH4737ffece+77HOc/imoAjDGBN4DLCeA4yzj+IdAzvWMck5zLbfStNVYAqGHcOwcC50BIpQUSJLCDcv+JvJbjASbkjDbxCuA3JmRrJdxVjMuLIORC5eQBaI1rjuNEdMkjIGTaAnEBmJD3tESAwKu2yZdEYCK057BK5Ll2MCH3Fd85QA0dGpMFW3Y3q0d3e1Rj42aTVsxEo9H1KwQwLjtNd/Tkfr+anxpT0xOD6vTxuMl0dCznrzaZ84aGTSo9kFDzU+Mq8zShvg4dVB8fdupXgWOm4LICwO26yUfie9XnN2mf3BfwrNsXMN5/2Kh6nHtb809+n05S885YQLyEMfXz3bDaEWsymwgur+cJkK91kgb6zhcRkMXgzS4lvQ26Iji+yq9AaP/r6zeqH28flBRAGLmTUNz1TM5BNhjH32EJp47Fy5Ln0HZUbxoYx1+L9HoCUrcuqCtdJ1T7yUNlBXx6MaRQ1pkJAIMRzM5++Srs37PLrAVABkPz5tNpQ/JSm84hfJnfgqSt3RNGU706Y9gTCCAbpSNAh5ww+fh26Fq1oq4pEOBfxb6NsiPgw/OUTv8LvQGQh7Mk4MvkSPkKuPKMszxc110HHKdtCJh7P1pGAH4vaVaZkK2WfGApLIDrthQlzwUI7F4tAYzLy45GRMhAWicXctjEGVetpS0PggykqU8sAB3qsJ6HhT8dAs/S7Or3mr7Fdsp1LEaEbBQ5GTITREJ/0UVksu9kb1R4Wyoq91rFX0v61J5Ml8pxAAAAAElFTkSuQmCC'

const LABELS: Record<Language, { show: string; quit: string }> = {
  it: { show: 'Mostra ChessAdvisor', quit: 'Esci' },
  en: { show: 'Show ChessAdvisor', quit: 'Quit' }
}

/**
 * The tray icon file is resolved at runtime so a build that has not generated `tray.ico`
 * yet still starts: `.ico` (Windows) → bundled `icon.png` → inline data URL.
 */
function trayImage(): Electron.NativeImage {
  if (process.platform === 'win32') {
    const ico = join(__dirname, '../../resources/tray.ico')
    if (existsSync(ico)) {
      const image = nativeImage.createFromPath(ico)
      if (!image.isEmpty()) return image
    }
  }
  const png = nativeImage.createFromPath(icon)
  return png.isEmpty() ? nativeImage.createFromDataURL(FALLBACK_ICON) : png
}

export interface TrayHandle {
  /** Tooltip shown in the notification area, e.g. "ChessAdvisor — in partita contro gpt-6". */
  update(tooltip: string): void
  destroy(): void
}

/** Creates the notification-area icon with a minimal menu (Show / Quit). */
export function createTray(opts: {
  onShow: () => void
  onQuit: () => void
  language?: Language
}): TrayHandle {
  const labels = LABELS[opts.language ?? 'it']
  const tray = new Tray(trayImage())
  tray.setToolTip('ChessAdvisor')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: labels.show, click: () => opts.onShow() },
      { type: 'separator' },
      { label: labels.quit, click: () => opts.onQuit() }
    ])
  )
  // clicking the icon brings the window back to the front
  tray.on('click', () => opts.onShow())
  return {
    update(tooltip: string): void {
      tray.setToolTip(tooltip)
    },
    destroy(): void {
      tray.destroy()
    }
  }
}
