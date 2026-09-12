import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Creates an isolated temporary directory for a test. */
export async function makeTmpDir(prefix = 'chessadvisor-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function removeTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
}

/** Runs `fn` with a temporary directory that is removed afterwards, whatever happens. */
export async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await makeTmpDir()
  try {
    return await fn(dir)
  } finally {
    await removeTmpDir(dir)
  }
}
