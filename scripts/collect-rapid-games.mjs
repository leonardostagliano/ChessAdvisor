// Collect a bounded, reproducible sample from Chess.com's public PubAPI.
// Documentation: https://www.chess.com/news/view/published-data-api
// Usage: node scripts/collect-rapid-games.mjs [--players FILE] [--country ISO ...]
//   [--seed STRING] [--max-players N] [--months N] [--max-games N] [--out DIR]
// Output: games.jsonl and manifest.json. Responses are cached under
// resources/data/.download/rapid/cache to make reruns stable and inexpensive.

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT = join(ROOT, 'resources', 'data', '.download', 'rapid')
const BASE = 'https://api.chess.com/pub'
const DOCS = 'https://www.chess.com/news/view/published-data-api'
const USER_AGENT = 'ChessAdvisor-RapidCollector/1.0 (public PubAPI research)'

function positiveInteger(value, name, max) {
  const number = Number(value)
  if (!Number.isSafeInteger(number) || number < 1 || number > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}`)
  }
  return number
}

export function parseArgs(argv) {
  const options = {
    playersFile: null,
    countries: [],
    seed: 'chessadvisor-rapid-v1',
    maxPlayers: 20,
    months: 3,
    maxGames: 1000,
    out: DEFAULT_OUT
  }
  const names = new Map([
    ['--players', 'playersFile'],
    ['--country', 'countries'],
    ['--seed', 'seed'],
    ['--max-players', 'maxPlayers'],
    ['--months', 'months'],
    ['--max-games', 'maxGames'],
    ['--out', 'out']
  ])
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i]
    if (!names.has(name)) throw new Error(`Unknown option: ${name}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`)
    if (name === '--country') {
      const iso = value.toUpperCase()
      if (!/^[A-Z]{2}$/.test(iso)) throw new Error('--country needs a two-letter country code')
      options.countries.push(iso)
    } else {
      options[names.get(name)] = value
    }
  }
  if (!options.playersFile && options.countries.length === 0) {
    throw new Error('Supply --players FILE and/or --country ISO')
  }
  if (!String(options.seed).trim()) throw new Error('--seed cannot be empty')
  options.maxPlayers = positiveInteger(options.maxPlayers, '--max-players', 100_000)
  options.months = positiveInteger(options.months, '--months', 120)
  options.maxGames = positiveInteger(options.maxGames, '--max-games', 1_000_000)
  options.out = resolve(options.out)
  options.countries = [...new Set(options.countries)].sort()
  return options
}

export function parsePlayers(text) {
  const source = text.trim()
  const values = source.startsWith('[') ? JSON.parse(source) : source.split(/\r?\n/)
  if (!Array.isArray(values))
    throw new Error('Player file must contain a JSON array or one username per line')
  const players = new Set()
  for (const value of values) {
    if (typeof value !== 'string') throw new Error('Player names must be strings')
    const name = value.trim()
    if (!name || name.startsWith('#')) continue
    if (!/^[A-Za-z0-9_-]{2,50}$/.test(name)) throw new Error(`Invalid Chess.com username: ${name}`)
    players.add(name.toLowerCase())
  }
  return [...players]
}

export function choosePlayers(players, seed, limit) {
  return [...new Set(players.map((p) => p.toLowerCase()))]
    .map((name) => ({ name, key: createHash('sha256').update(`${seed}\0${name}`).digest('hex') }))
    .sort((a, b) => a.key.localeCompare(b.key) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map(({ name }) => name)
}

export function completeArchives(urls, username, now, months) {
  const date = new Date(now)
  const currentMonth = date.toISOString().slice(0, 7)
  const firstMonth = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - months, 1))
    .toISOString()
    .slice(0, 7)
  const pattern = new RegExp(
    `^https://api\\.chess\\.com/pub/player/${username}/games/(\\d{4})/(0[1-9]|1[0-2])$`,
    'i'
  )
  return [...new Set(urls)]
    .filter((url) => {
      const match = typeof url === 'string' && url.match(pattern)
      const month = match && `${match[1]}-${match[2]}`
      return month && month >= firstMonth && month < currentMonth
    })
    .sort()
    .reverse()
}

export function normalizeGame(game, archiveUrl) {
  if (game?.rated !== true) return { skip: 'unrated' }
  if (game.rules !== 'chess') return { skip: 'variant' }
  if (game.time_class !== 'rapid') return { skip: 'otherTimeClass' }
  if (
    !Number.isSafeInteger(game.white?.rating) ||
    game.white.rating <= 0 ||
    !Number.isSafeInteger(game.black?.rating) ||
    game.black.rating <= 0
  ) {
    return { skip: 'missingRating' }
  }
  if (typeof game.pgn !== 'string' || !game.pgn.trim()) return { skip: 'missingPgn' }
  if (!gameIdFromUrl(game.url)) {
    return { skip: 'missingUrl' }
  }
  if (!Number.isSafeInteger(game.end_time) || game.end_time <= 0) return { skip: 'missingEndTime' }
  if (typeof game.white.username !== 'string' || typeof game.black.username !== 'string') {
    return { skip: 'missingUsername' }
  }
  const uuid = typeof game.uuid === 'string' && game.uuid.trim() ? game.uuid : null
  return {
    game: {
      url: game.url,
      uuid,
      pgn: game.pgn,
      timeControl: game.time_control ?? null,
      endedAt: new Date(game.end_time * 1000).toISOString(),
      white: { username: game.white.username, rating: game.white.rating },
      black: { username: game.black.username, rating: game.black.rating },
      ratingProvenance: 'Chess.com PubAPI monthly archive: player rating after game finished',
      sourceArchiveUrl: archiveUrl
    }
  }
}

// Both URL layouts occur in Chess.com monthly archives. The numeric game ID is
// their common identity, while the original URL remains in the output record.
export function gameIdFromUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['www.chess.com', 'chess.com'].includes(url.hostname))
      return null
    const match = url.pathname.match(/^\/(?:live\/game|game\/live)\/(\d+)\/?$/)
    return match ? match[1] : null
  } catch {
    return null
  }
}

export function addUniqueGame(game, seenUrls, seenUuids) {
  const id = gameIdFromUrl(game.url)
  if (seenUrls.has(id ?? game.url) || (game.uuid && seenUuids.has(game.uuid))) return false
  seenUrls.add(id ?? game.url)
  if (game.uuid) seenUuids.add(game.uuid)
  return true
}

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return null
  const seconds = Number(value)
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now
  return Number.isFinite(delay) ? Math.max(0, delay) : null
}

async function waitRetry(delay, sleep) {
  if (delay > 300_000)
    throw new Error('Retry-After exceeds five minutes; defer this collection run')
  while (delay > 0) {
    const chunk = Math.min(delay, 30_000)
    await sleep(chunk)
    delay -= chunk
  }
}

export async function fetchJsonWithRetry(
  url,
  {
    fetchImpl = fetch,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs = 15_000,
    maxRetries = 4,
    now = () => Date.now()
  } = {}
) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs)
      })
    } catch (error) {
      if (attempt === maxRetries) throw new Error(`Failed fetching ${url}: ${error.message}`)
      await waitRetry(Math.min(30_000, 500 * 2 ** attempt), sleep)
      continue
    }
    if (response.ok) {
      try {
        return await response.json()
      } catch (error) {
        throw new Error(`Invalid JSON from ${url}: ${error.message}`)
      }
    }
    if (response.status === 429 || (response.status >= 500 && response.status <= 599)) {
      if (attempt < maxRetries) {
        const header = response.headers?.get?.('retry-after')
        await waitRetry(retryAfterMs(header, now()) ?? Math.min(30_000, 500 * 2 ** attempt), sleep)
        continue
      }
    }
    const error = new Error(`HTTP ${response.status} fetching ${url}`)
    error.status = response.status
    throw error
  }
}

async function cachedJson(url, cacheDir, endpointLog, fetchOptions) {
  const name = createHash('sha256').update(url).digest('hex') + '.json'
  const path = join(cacheDir, name)
  try {
    const data = JSON.parse(await readFile(path, 'utf8'))
    endpointLog.push(url)
    return data
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Invalid cache ${path}: ${error.message}`)
  }
  const data = await fetchJsonWithRetry(url, fetchOptions)
  await mkdir(cacheDir, { recursive: true })
  await writeFile(path, JSON.stringify(data))
  endpointLog.push(url)
  return data
}

export async function collect(
  options,
  { now = new Date(), fetchOptions, onProgress = () => {} } = {}
) {
  const cacheDir = join(DEFAULT_OUT, 'cache')
  const endpoints = []
  const candidates = []
  if (options.playersFile)
    candidates.push(...parsePlayers(await readFile(options.playersFile, 'utf8')))
  for (const country of options.countries) {
    const data = await cachedJson(
      `${BASE}/country/${country}/players`,
      cacheDir,
      endpoints,
      fetchOptions
    )
    if (!Array.isArray(data.players))
      throw new Error(`Country ${country} response has no players array`)
    candidates.push(...data.players.map((p) => String(p)))
  }
  const validCandidates = candidates.filter((p) => /^[A-Za-z0-9_-]{2,50}$/.test(p))
  const players = choosePlayers(validCandidates, options.seed, options.maxPlayers)
  const skipped = {
    unrated: 0,
    variant: 0,
    otherTimeClass: 0,
    missingRating: 0,
    missingPgn: 0,
    missingUrl: 0,
    missingEndTime: 0,
    missingUsername: 0,
    duplicate: 0,
    missingPlayer: 0,
    missingArchive: 0
  }
  const games = []
  const seenUrls = new Set()
  const seenUuids = new Set()
  const selectedArchives = []
  for (const [index, username] of players.entries()) {
    if (games.length >= options.maxGames) break
    let archiveList
    try {
      archiveList = await cachedJson(
        `${BASE}/player/${username}/games/archives`,
        cacheDir,
        endpoints,
        fetchOptions
      )
    } catch (error) {
      if (error.status === 404 || error.status === 410) {
        skipped.missingPlayer++
        onProgress({
          playersDone: index + 1,
          playersTotal: players.length,
          games: games.length,
          archives: selectedArchives.length
        })
        continue
      }
      throw error
    }
    if (!Array.isArray(archiveList.archives))
      throw new Error(`Invalid archive list for ${username}`)
    for (const archiveUrl of completeArchives(
      archiveList.archives,
      username,
      now,
      options.months
    )) {
      if (games.length >= options.maxGames) break
      selectedArchives.push(archiveUrl)
      let data
      try {
        data = await cachedJson(archiveUrl, cacheDir, endpoints, fetchOptions)
      } catch (error) {
        if (error.status === 404 || error.status === 410) {
          skipped.missingArchive++
          continue
        }
        throw error
      }
      if (!Array.isArray(data.games)) throw new Error(`Invalid monthly archive ${archiveUrl}`)
      const ordered = [...data.games].sort(
        (a, b) =>
          (b.end_time ?? 0) - (a.end_time ?? 0) ||
          String(a.url ?? '').localeCompare(String(b.url ?? ''))
      )
      for (const raw of ordered) {
        const result = normalizeGame(raw, archiveUrl)
        if (result.skip) {
          skipped[result.skip]++
          continue
        }
        if (!addUniqueGame(result.game, seenUrls, seenUuids)) {
          skipped.duplicate++
          continue
        }
        games.push(result.game)
        if (games.length >= options.maxGames) break
      }
    }
    onProgress({
      playersDone: index + 1,
      playersTotal: players.length,
      games: games.length,
      archives: selectedArchives.length
    })
  }
  const manifest = {
    schemaVersion: 1,
    source: 'Chess.com PubAPI',
    sourceDocumentation: DOCS,
    asOf: new Date(now).toISOString(),
    seed: options.seed,
    limits: {
      maxPlayers: options.maxPlayers,
      monthsPerPlayer: options.months,
      maxGames: options.maxGames
    },
    inputs: {
      playersFile: options.playersFile ? resolve(options.playersFile) : null,
      countries: options.countries
    },
    candidateCount: new Set(validCandidates.map((p) => p.toLowerCase())).size,
    selectedPlayers: players,
    selectedArchives,
    endpoints,
    counts: { games: games.length, skipped },
    ratingMeaning:
      'white.rating and black.rating are historical ratings after each game, as returned by the monthly archive',
    sampleBias:
      'Accounts come from an explicit list and/or currently active, self-identified country players. Seeded account selection, recent complete months, archive availability, and max-game truncation introduce selection bias. This is not representative Elo calibration.'
  }
  await mkdir(options.out, { recursive: true })
  const jsonl = games.map((g) => JSON.stringify(g)).join('\n') + (games.length ? '\n' : '')
  const tempSuffix = `.tmp-${process.pid}`
  await writeFile(join(options.out, `games.jsonl${tempSuffix}`), jsonl)
  await writeFile(
    join(options.out, `manifest.json${tempSuffix}`),
    JSON.stringify(manifest, null, 2) + '\n'
  )
  await rename(join(options.out, `games.jsonl${tempSuffix}`), join(options.out, 'games.jsonl'))
  await rename(join(options.out, `manifest.json${tempSuffix}`), join(options.out, 'manifest.json'))
  return manifest
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  collect(parseArgs(process.argv.slice(2)), {
    onProgress: (progress) => {
      if (progress.playersDone % 10 === 0 || progress.playersDone === progress.playersTotal) {
        console.log(
          `${progress.playersDone}/${progress.playersTotal} players; ${progress.archives} archives; ${progress.games} games`
        )
      }
    }
  })
    .then((manifest) => {
      console.log(
        `Collected ${manifest.counts.games} Rapid games from ${manifest.selectedArchives.length} archives.`
      )
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
