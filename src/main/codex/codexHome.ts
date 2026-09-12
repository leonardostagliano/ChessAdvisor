import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * Minimal `config.toml` of the dedicated CODEX_HOME (spec §3.1).
 *
 * No `[plugins.*]`, no `[mcp_servers.*]`, no `[hooks.*]`: a game thread must never inherit the
 * tools, hooks or MCP servers the user configured for their own coding sessions.
 */
export const MINIMAL_CONFIG = (model: string): string =>
  `model = "${model}"\napproval_policy = "never"\nsandbox_mode = "read-only"\nnotify = []\n[features]\nhooks = false\n`

const CONFIG_FILE = 'config.toml'
const AUTH_FILE = 'auth.json'
/** Marker that tells a config written by ChessAdvisor from a hand-edited or older one. */
const HOOKS_OFF = 'hooks = false'

/** The user's own CODEX_HOME, the only source of `auth.json`. */
export function userCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.CODEX_HOME?.trim()
  if (configured) return configured
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || homedir()
  return join(home, '.codex')
}

/**
 * Creates the dedicated CODEX_HOME and its config. The file is rewritten when it is missing or
 * when it does not disable hooks, so a config from an older version cannot keep them enabled.
 */
export async function ensureCodexHome(dir: string, model: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, CONFIG_FILE)
  const existing = await readFile(file, 'utf8').catch(() => null)
  if (existing !== null && existing.includes(HOOKS_OFF)) return
  await writeFileAtomic(file, MINIMAL_CONFIG(model))
}

interface AuthFile {
  last_refresh?: unknown
}

function lastRefresh(raw: string | null): number {
  if (raw === null) return Number.NEGATIVE_INFINITY
  try {
    const parsed = JSON.parse(raw) as AuthFile
    if (typeof parsed.last_refresh !== 'string') return 0
    const time = Date.parse(parsed.last_refresh)
    return Number.isNaN(time) ? 0 : time
  } catch {
    // A corrupt copy is always worse than the source.
    return Number.NEGATIVE_INFINITY
  }
}

/**
 * Copies (never links) `auth.json` from the user's CODEX_HOME into the dedicated one when the
 * target is missing or older. The two files refresh independently: `codex login` repairs the
 * source and the next start copies it over again.
 */
export async function syncAuth(
  dir: string,
  sourceHome: string
): Promise<'copied' | 'kept' | 'missing'> {
  const source = join(sourceHome, AUTH_FILE)
  const target = join(dir, AUTH_FILE)
  const sourceRaw = await readFile(source, 'utf8').catch(() => null)
  if (sourceRaw === null) return 'missing'

  const targetRaw = await readFile(target, 'utf8').catch(() => null)
  if (targetRaw !== null && lastRefresh(sourceRaw) <= lastRefresh(targetRaw)) return 'kept'

  await mkdir(dir, { recursive: true })
  await writeFileAtomic(target, sourceRaw, 0o600)
  return 'copied'
}

/** Drops the copied credentials so the next {@link syncAuth} starts from the user's file. */
export async function resetAuth(dir: string): Promise<void> {
  await rm(join(dir, AUTH_FILE), { force: true })
}

/** Same tmp+rename discipline as the game store: a half-written config would break every start. */
async function writeFileAtomic(file: string, content: string, mode?: number): Promise<void> {
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(tmp, content, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
    await rename(tmp, file)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}
