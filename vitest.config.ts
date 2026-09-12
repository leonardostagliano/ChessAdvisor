import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const alias = {
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer/src')
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts', 'test/**/*.test.ts', 'scripts/**/*.test.mjs'],
          testTimeout: 20000
        }
      },
      {
        resolve: { alias },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['test/setup-renderer.ts']
        }
      }
    ]
  }
})
