import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { dataDir } from '../paths'
import { readJson, writeJsonAtomic } from '../store/atomicWrite'

interface RuntimeState {
  pids: Record<string, number>
}

/** Only processes we own may be killed at boot, never an unrelated program that reused the pid. */
const OWNED_IMAGE = /^(codex\.exe|stockfish[-\w.]*\.exe)$/i

const EMPTY: RuntimeState = { pids: {} }

const runtimeFile = (): string => join(dataDir(), 'runtime.json')

const read = async (): Promise<RuntimeState> => {
  const state = await readJson<RuntimeState>(runtimeFile(), EMPTY)
  return { pids: state && typeof state === 'object' && state.pids ? { ...state.pids } : {} }
}

export async function recordPid(name: string, pid: number): Promise<void> {
  const state = await read()
  state.pids[name] = pid
  await writeJsonAtomic(runtimeFile(), state).catch((error) => console.error('[runtime] could not record pid:', error))
}

export async function forgetPid(name: string): Promise<void> {
  const state = await read()
  if (!(name in state.pids)) return
  delete state.pids[name]
  await writeJsonAtomic(runtimeFile(), state).catch((error) => console.error('[runtime] could not forget pid:', error))
}

const run = (exe: string, args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 5000 }, (error, stdout) => resolve(error ? '' : stdout))
  })

/** Image name of a running pid, or null when the pid is gone (Windows only). */
async function imageOf(pid: number): Promise<string | null> {
  const out = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
  const match = /^"([^"]+)","(\d+)"/m.exec(out.trim())
  if (!match || Number(match[2]) !== pid) return null
  return match[1]
}

/**
 * Boot cleanup: kills the children a previous crashed run left behind, but only when the pid
 * still belongs to one of our own executables. Returns the names of the entries killed.
 */
export async function killStalePids(): Promise<string[]> {
  const state = await read()
  const names = Object.keys(state.pids)
  if (names.length === 0) return []
  const killed: string[] = []
  if (process.platform === 'win32') {
    for (const name of names) {
      const pid = state.pids[name]
      if (!Number.isInteger(pid) || pid <= 0) continue
      const image = await imageOf(pid)
      if (!image || !OWNED_IMAGE.test(image)) continue
      await run('taskkill', ['/PID', String(pid), '/T', '/F'])
      killed.push(name)
    }
  }
  await writeJsonAtomic(runtimeFile(), EMPTY).catch((error) => console.error('[runtime] could not reset runtime.json:', error))
  return killed
}
