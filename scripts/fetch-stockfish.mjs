#!/usr/bin/env node
// @ts-nocheck
/**
 * Downloads the two bundled Stockfish builds into `resources/engine`.
 *
 *   npm run fetch:stockfish          skips a build whose .exe is already there
 *   npm run fetch:stockfish -- --force   re-downloads everything
 *
 * The binaries are NOT in git (`.gitignore`: `resources/engine/*.exe`); `VERSION.txt` is, because
 * the GPL notice in THIRD-PARTY-NOTICES.md has to name the exact release the app ships.
 * Asset names verified on 2026-09-12 with `gh release view sf_17.1 -R official-stockfish/Stockfish`.
 */

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENGINE_DIR = join(ROOT, 'resources', 'engine')
const WORK_DIR = join(ENGINE_DIR, '.download')

const TAG = 'sf_17.1'
const BASE = `https://github.com/official-stockfish/Stockfish/releases/download/${TAG}`

const BUILDS = [
  {
    name: 'avx2',
    asset: 'stockfish-windows-x86-64-avx2.zip',
    bytes: 65_443_094,
    target: 'stockfish-avx2.exe'
  },
  {
    name: 'popcnt',
    asset: 'stockfish-windows-x86-64-sse41-popcnt.zip',
    bytes: 65_448_116,
    target: 'stockfish-popcnt.exe'
  }
]

const force = process.argv.includes('--force')

const exists = async (path) => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function download(url, destination) {
  process.stdout.write(`  downloading ${url}\n`)
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { 'user-agent': 'ChessAdvisor-fetch-stockfish' }
  })
  // A 404 here means the release was re-cut: never write a truncated or HTML "binary".
  if (response.status !== 200)
    throw new Error(`${url} answered HTTP ${response.status} ${response.statusText}`)
  if (!response.body) throw new Error(`${url} answered without a body`)
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
  return (await stat(destination)).size
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8')
    })
    child.once('error', rejectPromise)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else
        rejectPromise(
          new Error(`${command} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`)
        )
    })
  })
}

async function unzip(archive, destination) {
  await mkdir(destination, { recursive: true })
  if (process.platform === 'win32') {
    // PowerShell ships with Windows, so the script needs no unzip dependency of its own.
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${destination}' -Force`
    ])
    return
  }
  await run('unzip', ['-o', '-q', archive, '-d', destination])
}

/** The archive holds a `stockfish/` folder with exactly one executable; find it wherever it sits. */
async function findExecutable(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const found = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...(await findExecutable(path)))
    else if (/\.exe$/i.test(entry.name)) found.push(path)
  }
  return found
}

async function fetchBuild(build) {
  const target = join(ENGINE_DIR, build.target)
  if (!force && (await exists(target))) {
    process.stdout.write(
      `  ${build.target} already present, skipping (use --force to re-download)\n`
    )
    return
  }
  const archive = join(WORK_DIR, build.asset)
  const extracted = join(WORK_DIR, build.name)
  await rm(extracted, { recursive: true, force: true })

  const size = await download(`${BASE}/${build.asset}`, archive)
  if (size !== build.bytes) {
    process.stdout.write(
      `  warning: ${build.asset} is ${size} bytes, expected ${build.bytes} — the release may have been re-cut\n`
    )
  }

  await unzip(archive, extracted)
  const executables = await findExecutable(extracted)
  if (executables.length !== 1) {
    throw new Error(
      `expected exactly one .exe in ${build.asset}, found ${executables.length}: ${executables.join(', ')}`
    )
  }
  await rm(target, { force: true })
  await rename(executables[0], target)
  await rm(archive, { force: true })
  await rm(extracted, { recursive: true, force: true })
  process.stdout.write(`  ${build.target} ready\n`)
}

async function main() {
  await mkdir(ENGINE_DIR, { recursive: true })
  await mkdir(WORK_DIR, { recursive: true })
  process.stdout.write(`Stockfish ${TAG} → ${ENGINE_DIR}\n`)
  for (const build of BUILDS) await fetchBuild(build)
  await writeFile(
    join(ENGINE_DIR, 'VERSION.txt'),
    [
      `Stockfish release: ${TAG}`,
      `Source of the binaries (GPL-3.0, corresponding source available at the same release):`,
      ...BUILDS.map((build) => `  ${build.target}  <-  ${BASE}/${build.asset}`),
      `Project: https://github.com/official-stockfish/Stockfish`,
      ''
    ].join('\n'),
    'utf8'
  )
  await rm(WORK_DIR, { recursive: true, force: true })
  process.stdout.write('done\n')
}

main().catch((error) => {
  process.stderr.write(`fetch-stockfish failed: ${error.message}\n`)
  process.exitCode = 1
})
