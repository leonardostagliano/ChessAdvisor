import { ElectronAPI } from '@electron-toolkit/preload'

// `window.api` is declared once, next to its contract, in `@shared/types/api`.
declare global {
  interface Window {
    electron: ElectronAPI
  }
}
