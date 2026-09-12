import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { ...shared, '@main': resolve('src/main') } },
    // Lets a development build claim an exact version while testing the update flow.
    define: { __CHESSADVISOR_DEV_VERSION__: JSON.stringify(process.env.CHESSADVISOR_DEV_VERSION ?? '') }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: shared }
  },
  renderer: {
    plugins: [react()],
    resolve: { alias: { ...shared, '@renderer': resolve('src/renderer/src') } }
  }
})
