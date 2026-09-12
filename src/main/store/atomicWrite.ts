import { randomUUID } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Windows keeps a handle open for a moment after an antivirus/indexer touch: retry, do not lose data. */
const RENAME_RETRY_MS = [20, 50, 100, 200, 400]
const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES'])
const STALE_TMP_MS = 60_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code

const retryDelay = (attempt: number): number | undefined => RENAME_RETRY_MS[attempt]

/**
 * Writes `value` as JSON so that `path` is either the old file or the complete new one:
 * a sibling tmp file is written and fsync'd, then renamed over the target.
 */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`
  try {
    await fsp.mkdir(dirname(path), { recursive: true })
    const handle = await fsp.open(tmp, 'w')
    try {
      await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }

    let lastError: unknown
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(tmp, path)
        return
      } catch (error) {
        lastError = error
        const delay = retryDelay(attempt)
        if (!RETRYABLE.has(codeOf(error) ?? '') || delay === undefined) break
        await sleep(delay)
      }
    }
    throw new Error(`ATOMIC_WRITE_FAILED: ${path}`, { cause: lastError })
  } catch (error) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    if (error instanceof Error && error.message.startsWith('ATOMIC_WRITE_FAILED')) throw error
    throw new Error(`ATOMIC_WRITE_FAILED: ${path}`, { cause: error })
  }
}

/**
 * Reads JSON written by {@link writeJsonAtomic}. A missing file yields `fallback`;
 * an unparsable one is moved aside so the next write starts from a clean state.
 */
export async function readJson<T>(path: string, fallback: T): Promise<T> {
  let raw: string
  try {
    raw = await fsp.readFile(path, 'utf8')
  } catch {
    return fallback
  }
  try {
    return JSON.parse(raw) as T
  } catch {
    await fsp.rename(path, `${path}.corrupt-${Date.now()}`).catch(() => undefined)
    return fallback
  }
}

/** Removes tmp files older than a minute left behind by an interrupted write. Returns how many. */
export async function cleanupTmp(dir: string): Promise<number> {
  const entries = await fsp.readdir(dir).catch(() => [] as string[])
  const cutoff = Date.now() - STALE_TMP_MS
  let removed = 0
  for (const name of entries) {
    if (!name.endsWith('.tmp')) continue
    const file = join(dir, name)
    const stats = await fsp.stat(file).catch(() => null)
    if (!stats || !stats.isFile() || stats.mtimeMs > cutoff) continue
    await fsp.rm(file, { force: true }).catch(() => undefined)
    removed += 1
  }
  return removed
}
