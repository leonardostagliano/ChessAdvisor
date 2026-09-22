'use strict'

// Run using the packaged executable with ELECTRON_RUN_AS_NODE=1; never launch the UI.
// Usage: "release/win-unpacked/ChessAdvisor.exe" scripts/smoke-windows.cjs release/win-unpacked
const { existsSync, statSync, readFileSync } = require('node:fs')
const path = require('node:path')

// Training needs all three datasets (spec §3.1): a package without them is broken, not incomplete.
const ENGINE_BINARIES = ['stockfish-avx2.exe', 'stockfish-popcnt.exe']
const DATASETS = ['puzzles.json', 'openings.json', 'endgames.json', 'rapid-calibration.json']

function nonEmptyFile(file) {
  const info = statSync(file)
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty packaged file: ${file}`)
}

try {
  if (
    process.platform !== 'win32' ||
    !process.versions.electron ||
    process.env.ELECTRON_RUN_AS_NODE !== '1'
  ) {
    throw new Error('Run the packaged Windows executable with ELECTRON_RUN_AS_NODE=1.')
  }
  if (!process.argv[2] || !process.env.RELEASE_VERSION) {
    throw new Error(
      'Usage: <packaged.exe> scripts/smoke-windows.cjs <unpacked-dir>; set RELEASE_VERSION.'
    )
  }

  const resources = path.resolve(process.argv[2], 'resources')
  const manifest = require(path.join(resources, 'app.asar', 'package.json'))
  if (manifest.version !== process.env.RELEASE_VERSION) {
    throw new Error(
      `Packaged version ${manifest.version} differs from RELEASE_VERSION ${process.env.RELEASE_VERSION}.`
    )
  }
  if (manifest.name !== 'chessadvisor') {
    throw new Error(`Packaged manifest name ${manifest.name} is not chessadvisor.`)
  }

  for (const name of ENGINE_BINARIES) nonEmptyFile(path.join(resources, 'engine', name))

  for (const name of DATASETS) nonEmptyFile(path.join(resources, 'data', name))
  if (
    existsSync(path.join(resources, 'data', '.download')) ||
    existsSync(path.join(resources, 'engine', '.download'))
  ) {
    throw new Error('Research/download caches must not be packaged.')
  }
  const rapid = JSON.parse(
    readFileSync(path.join(resources, 'data', 'rapid-calibration.json'), 'utf8')
  )
  for (const elo of [600, 900, 1200, 1500, 1800]) {
    if (
      !rapid.profiles.some(
        (profile) =>
          profile.elo === elo &&
          profile.phase === 'all' &&
          profile.count >= 40 &&
          profile.players >= 8
      )
    ) {
      throw new Error(`Missing supported Rapid profile for ${elo}.`)
    }
  }

  console.log(
    `Windows package ${process.env.RELEASE_VERSION}: manifest, Stockfish binaries and datasets OK`
  )
  process.exit(0)
} catch (error) {
  console.error(`Windows package smoke failed: ${error.message}`)
  process.exit(1)
}
