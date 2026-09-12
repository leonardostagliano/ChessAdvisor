import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/**
 * Where the Codex CLI is, and how it has to be spawned.
 *
 * `viaCmd` marks a `.cmd`/`.bat` shim (npm global install): those are not executables, so they
 * must run through `cmd.exe /d /s /c ""<path>" app-server"` with `windowsVerbatimArguments`.
 * Spawning by bare name is never an option (PATH lookup with `shell:true` is a command-injection
 * surface and would also pick up the wrong `codex`).
 */
export type CodexLocation = { exe: string; viaCmd: boolean } | { exe: null; searched: string[] }

const VERSION_TIMEOUT_MS = 8000

/** PATH is case-insensitive on Windows, but a plain object passed by a test is not. */
function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? ''
  return raw
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter((entry) => entry.length > 0)
}

function localAppDataCandidates(env: NodeJS.ProcessEnv): string[] {
  const localAppData = env.LOCALAPPDATA
  if (!localAppData) return []
  const bin = join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin')
  return [join(bin, 'codex.exe'), join(bin, 'codex.cmd'), join(bin, 'codex.bat')]
}

const isShim = (candidate: string): boolean => /\.(cmd|bat)$/i.test(candidate)

/**
 * Resolves the Codex CLI in the order of spec §3.1: explicit override, the official Windows
 * installation, then PATH. Real executables win over `.cmd`/`.bat` shims everywhere, so an npm
 * shim is only used when no `codex.exe` exists at all.
 */
export function findCodexExe(env: NodeJS.ProcessEnv = process.env): CodexLocation {
  const searched: string[] = []
  const executables: string[] = []
  const shims: string[] = []

  const override = env.CODEX_APP_PATH?.trim()
  if (override) {
    // An explicit override wins over every other candidate, shim or not.
    searched.push(override)
    if (existsSync(override)) return { exe: override, viaCmd: isShim(override) }
  }

  for (const candidate of localAppDataCandidates(env)) {
    if (isShim(candidate)) shims.push(candidate)
    else executables.push(candidate)
    searched.push(candidate)
  }

  for (const entry of pathEntries(env)) {
    const exe = join(entry, 'codex.exe')
    executables.push(exe)
    searched.push(exe)
    for (const shim of [join(entry, 'codex.cmd'), join(entry, 'codex.bat')]) {
      shims.push(shim)
      searched.push(shim)
    }
  }

  for (const candidate of executables) {
    if (existsSync(candidate)) return { exe: candidate, viaCmd: false }
  }
  for (const candidate of shims) {
    if (existsSync(candidate)) return { exe: candidate, viaCmd: true }
  }
  return { exe: null, searched }
}

/**
 * Argv for `codex app-server`, ready for {@link ManagedProcess}.
 * A shim is wrapped in a single verbatim `cmd.exe` argument: quoting it any other way breaks
 * as soon as the install path contains a space.
 */
export function appServerCommand(location: { exe: string; viaCmd: boolean }): {
  exe: string
  args: string[]
  windowsVerbatimArguments: boolean
} {
  if (!location.viaCmd)
    return { exe: location.exe, args: ['app-server'], windowsVerbatimArguments: false }
  return {
    exe: process.env.COMSPEC ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${location.exe}" app-server`],
    windowsVerbatimArguments: true
  }
}

/** `codex --version` → `0.154.0`, or null when the binary cannot be run at all. */
export async function codexVersion(exe: string): Promise<string | null> {
  const command = isShim(exe)
    ? {
        file: process.env.COMSPEC ?? 'cmd.exe',
        args: ['/d', '/s', '/c', `"${exe}" --version`],
        verbatim: true
      }
    : { file: exe, args: ['--version'], verbatim: false }

  const output = await new Promise<string | null>((resolve) => {
    try {
      execFile(
        command.file,
        command.args,
        {
          timeout: VERSION_TIMEOUT_MS,
          windowsHide: true,
          windowsVerbatimArguments: command.verbatim,
          shell: false
        },
        (error, stdout, stderr) => {
          if (error && !stdout) {
            resolve(null)
            return
          }
          resolve(`${stdout}${stderr}`)
        }
      )
    } catch {
      resolve(null)
    }
  })

  if (output === null) return null
  const match = /(\d+\.\d+\.\d+)/.exec(output)
  return match ? match[1]! : null
}
