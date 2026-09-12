'use strict'

// Run using the packaged executable with ELECTRON_RUN_AS_NODE=1; never launch the UI.
// Usage: "release/win-unpacked/ChessAdvisor.exe" scripts/smoke-windows.cjs release/win-unpacked
const { statSync } = require('node:fs')
const path = require('node:path')

// The datasets ship from M5 on. Until then their absence is reported but does not fail the build.
const ENGINE_BINARIES = ['stockfish-avx2.exe', 'stockfish-popcnt.exe']
const DATASETS = ['puzzles.json', 'openings.json', 'endgames.json']

function nonEmptyFile(file) {
  const info = statSync(file)
  if (!info.isFile() || info.size === 0) throw new Error(`Missing or empty packaged file: ${file}`)
}

try {
  if (process.platform !== 'win32' || !process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') {
    throw new Error('Run the packaged Windows executable with ELECTRON_RUN_AS_NODE=1.')
  }
  if (!process.argv[2] || !process.env.RELEASE_VERSION) {
    throw new Error('Usage: <packaged.exe> scripts/smoke-windows.cjs <unpacked-dir>; set RELEASE_VERSION.')
  }

  const resources = path.resolve(process.argv[2], 'resources')
  const manifest = require(path.join(resources, 'app.asar', 'package.json'))
  if (manifest.version !== process.env.RELEASE_VERSION) {
    throw new Error(`Packaged version ${manifest.version} differs from RELEASE_VERSION ${process.env.RELEASE_VERSION}.`)
  }
  if (manifest.name !== 'chessadvisor') {
    throw new Error(`Packaged manifest name ${manifest.name} is not chessadvisor.`)
  }

  for (const name of ENGINE_BINARIES) nonEmptyFile(path.join(resources, 'engine', name))

  const missingData = []
  for (const name of DATASETS) {
    try {
      nonEmptyFile(path.join(resources, 'data', name))
    } catch {
      missingData.push(name)
    }
  }
  if (missingData.length > 0) {
    console.warn(`Warning: datasets not packaged yet (added in M5): ${missingData.join(', ')}`)
  }

  console.log(`Windows package ${process.env.RELEASE_VERSION}: manifest and Stockfish binaries OK`)
  process.exit(0)
} catch (error) {
  console.error(`Windows package smoke failed: ${error.message}`)
  process.exit(1)
}
