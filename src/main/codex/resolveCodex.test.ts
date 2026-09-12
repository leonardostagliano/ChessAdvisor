import { mkdir, writeFile } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { appServerCommand, codexVersion, findCodexExe } from './resolveCodex'

const dirs: string[] = []

async function tmp(): Promise<string> {
  const dir = await makeTmpDir('chessadvisor-resolve-')
  dirs.push(dir)
  return dir
}

async function touch(dir: string, name: string): Promise<string> {
  const file = join(dir, name)
  await writeFile(file, '')
  return file
}

async function fakeInstall(root: string, name: string): Promise<string> {
  const bin = join(root, 'Programs', 'OpenAI', 'Codex', 'bin')
  await mkdir(bin, { recursive: true })
  return touch(bin, name)
}

afterEach(async () => {
  while (dirs.length > 0) await removeTmpDir(dirs.pop()!)
})

describe('findCodexExe', () => {
  it('prefers the explicit override over every other candidate', async () => {
    const overrideDir = await tmp()
    const localAppData = await tmp()
    const pathDir = await tmp()
    const override = await touch(overrideDir, 'codex.exe')
    await fakeInstall(localAppData, 'codex.exe')
    await touch(pathDir, 'codex.exe')

    const found = findCodexExe({
      CODEX_APP_PATH: override,
      LOCALAPPDATA: localAppData,
      PATH: pathDir
    })
    expect(found).toEqual({ exe: override, viaCmd: false })
  })

  it('falls back to the official installation before scanning PATH', async () => {
    const localAppData = await tmp()
    const pathDir = await tmp()
    const installed = await fakeInstall(localAppData, 'codex.exe')
    await touch(pathDir, 'codex.exe')

    const found = findCodexExe({ LOCALAPPDATA: localAppData, PATH: pathDir })
    expect(found).toEqual({ exe: installed, viaCmd: false })
  })

  it('scans PATH entries in order', async () => {
    const empty = await tmp()
    const first = await tmp()
    const second = await tmp()
    const exe = await touch(first, 'codex.exe')
    await touch(second, 'codex.exe')

    const found = findCodexExe({ PATH: [empty, first, second].join(delimiter) })
    expect(found).toEqual({ exe, viaCmd: false })
  })

  it('accepts a .cmd shim only when no real executable exists, and flags it', async () => {
    const shimDir = await tmp()
    const exeDir = await tmp()
    const shim = await touch(shimDir, 'codex.cmd')

    const shimOnly = findCodexExe({ PATH: shimDir })
    expect(shimOnly).toEqual({ exe: shim, viaCmd: true })

    const exe = await touch(exeDir, 'codex.exe')
    const withExe = findCodexExe({ PATH: [shimDir, exeDir].join(delimiter) })
    expect(withExe).toEqual({ exe, viaCmd: false })
  })

  it('reports every path it looked at when nothing is installed', async () => {
    const localAppData = await tmp()
    const pathDir = await tmp()

    const found = findCodexExe({ LOCALAPPDATA: localAppData, PATH: pathDir })
    expect(found.exe).toBeNull()
    const searched = (found as { searched: string[] }).searched
    expect(searched).toContain(
      join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe')
    )
    expect(searched).toContain(join(pathDir, 'codex.exe'))
    expect(searched).toContain(join(pathDir, 'codex.cmd'))
  })
})

describe('appServerCommand', () => {
  it('spawns a real executable directly', () => {
    expect(appServerCommand({ exe: 'C:\\Codex\\codex.exe', viaCmd: false })).toEqual({
      exe: 'C:\\Codex\\codex.exe',
      args: ['app-server'],
      windowsVerbatimArguments: false
    })
  })

  it('wraps a shim in a single verbatim cmd.exe argument', () => {
    const command = appServerCommand({ exe: 'C:\\Program Files\\npm\\codex.cmd', viaCmd: true })
    expect(command.args).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\Program Files\\npm\\codex.cmd" app-server'
    ])
    expect(command.windowsVerbatimArguments).toBe(true)
  })
})

describe('codexVersion', () => {
  it('parses a semantic version out of the --version output', async () => {
    // node --version prints `v22.14.0`: same parsing path, without touching the real CLI.
    expect(await codexVersion(process.execPath)).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('returns null when the executable cannot be run', async () => {
    const dir = await tmp()
    expect(await codexVersion(join(dir, 'missing-codex.exe'))).toBeNull()
  })
})
