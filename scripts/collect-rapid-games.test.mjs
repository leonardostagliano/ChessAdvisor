import { describe, expect, it } from 'vitest'
import {
  addUniqueGame,
  choosePlayers,
  completeArchives,
  fetchJsonWithRetry,
  gameIdFromUrl,
  normalizeGame,
  parseArgs,
  parsePlayers,
  retryAfterMs
} from './collect-rapid-games.mjs'

const archive = 'https://api.chess.com/pub/player/alice/games/2026/08'
const baseGame = {
  rated: true,
  rules: 'chess',
  time_class: 'rapid',
  white: { username: 'alice', rating: 1600 },
  black: { username: 'bob', rating: 1700 },
  url: 'https://www.chess.com/game/live/123',
  uuid: 'same-game',
  pgn: '[Event "Live Chess"]\n\n1. e4 e5 1-0',
  time_control: '600',
  end_time: 1788200000
}

describe('Rapid collector input and selection', () => {
  it('requires a source and bounded limits', () => {
    expect(() => parseArgs([])).toThrow(/Supply/)
    expect(() => parseArgs(['--country', 'USA'])).toThrow(/two-letter/)
    expect(() => parseArgs(['--country', 'IT', '--max-games', '0'])).toThrow(/max-games/)
    expect(parseArgs(['--country', 'it']).countries).toEqual(['IT'])
  })
  it('parses player files, rejects malformed names, and chooses deterministically', () => {
    expect(parsePlayers('# note\nAlice\nbob\nalice\n')).toEqual(['alice', 'bob'])
    expect(parsePlayers('["Alice","bob"]')).toEqual(['alice', 'bob'])
    expect(() => parsePlayers('good\nbad/name')).toThrow(/Invalid/)
    const one = choosePlayers(['Charlie', 'alice', 'bob'], 'seed', 2)
    expect(choosePlayers(['bob', 'Charlie', 'alice'], 'seed', 2)).toEqual(one)
  })
  it('excludes the current month and takes recent complete months', () => {
    expect(
      completeArchives(
        [
          'https://api.chess.com/pub/player/alice/games/2026/09',
          archive,
          'https://api.chess.com/pub/player/alice/games/2026/07',
          'https://example.com/pub/player/alice/games/2026/06'
        ],
        'alice',
        new Date('2026-09-22T12:00:00Z'),
        1
      )
    ).toEqual([archive])
    expect(
      completeArchives(
        ['https://api.chess.com/pub/player/alice/games/2024/01'],
        'alice',
        new Date('2026-09-22T12:00:00Z'),
        3
      )
    ).toEqual([])
  })
})

describe('game admission', () => {
  it('keeps the PGN and postgame rating provenance', () => {
    const result = normalizeGame(baseGame, archive)
    expect(result.game).toMatchObject({
      pgn: baseGame.pgn,
      timeControl: '600',
      sourceArchiveUrl: archive,
      white: { username: 'alice', rating: 1600 },
      black: { username: 'bob', rating: 1700 }
    })
    expect(result.game.ratingProvenance).toMatch(/after game/)
  })
  it.each([
    [{ rated: false }, 'unrated'],
    [{ rules: 'chess960' }, 'variant'],
    [{ time_class: 'blitz' }, 'otherTimeClass'],
    [{ white: { username: 'alice', rating: '1600' } }, 'missingRating'],
    [{ pgn: '' }, 'missingPgn'],
    [{ url: null }, 'missingUrl']
  ])('rejects invalid game %j', (change, reason) => {
    expect(normalizeGame({ ...baseGame, ...change }, archive)).toEqual({ skip: reason })
  })
  it('deduplicates across archive lists by either URL or UUID', () => {
    const urls = new Set(),
      uuids = new Set()
    expect(addUniqueGame(baseGame, urls, uuids)).toBe(true)
    expect(addUniqueGame({ ...baseGame, uuid: 'other' }, urls, uuids)).toBe(false)
    expect(
      addUniqueGame({ ...baseGame, url: 'https://www.chess.com/game/live/456' }, urls, uuids)
    ).toBe(false)
    expect(
      addUniqueGame(
        { ...baseGame, url: 'https://www.chess.com/live/game/123', uuid: null },
        urls,
        uuids
      )
    ).toBe(false)
    expect(gameIdFromUrl('https://www.chess.com/live/game/123')).toBe('123')
    expect(gameIdFromUrl('https://www.chess.com/game/live/123')).toBe('123')
    expect(
      normalizeGame({ ...baseGame, url: 'https://www.chess.com/live/game/123' }, archive).game.url
    ).toBe('https://www.chess.com/live/game/123')
    expect(
      normalizeGame({ ...baseGame, url: 'https://www.chess.com/live/game/not-a-number' }, archive)
        .skip
    ).toBe('missingUrl')
  })
})

describe('network retry', () => {
  it('honors Retry-After on 429 and retries serially', async () => {
    const delays = []
    let calls = 0,
      inFlight = 0,
      maxInFlight = 0
    const data = await fetchJsonWithRetry('https://api.chess.com/pub/test', {
      fetchImpl: async () => {
        calls++
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        inFlight--
        return calls === 1
          ? { ok: false, status: 429, headers: { get: () => '2' } }
          : { ok: true, json: async () => ({ players: ['alice'] }) }
      },
      sleep: async (ms) => {
        delays.push(ms)
      }
    })
    expect(data.players).toEqual(['alice'])
    expect({ calls, delays, maxInFlight }).toEqual({ calls: 2, delays: [2000], maxInFlight: 1 })
    expect(retryAfterMs('Wed, 23 Sep 2026 00:00:02 GMT', Date.parse('2026-09-23T00:00:00Z'))).toBe(
      2000
    )
  })
  it('never retries before a long Retry-After delay', async () => {
    const delays = []
    let calls = 0
    await fetchJsonWithRetry('https://api.chess.com/pub/test', {
      fetchImpl: async () =>
        ++calls === 1
          ? { ok: false, status: 429, headers: { get: () => '65' } }
          : { ok: true, json: async () => ({}) },
      sleep: async (ms) => {
        delays.push(ms)
      }
    })
    expect(delays).toEqual([30000, 30000, 5000])
    expect(retryAfterMs('65')).toBe(65000)
  })
  it('stops after a bounded number of retries and does not retry 404', async () => {
    const sleep = async () => {}
    let calls = 0
    await expect(
      fetchJsonWithRetry('https://api.chess.com/pub/nope', {
        fetchImpl: async () => {
          calls++
          return { ok: false, status: 429, headers: { get: () => null } }
        },
        sleep,
        maxRetries: 2
      })
    ).rejects.toThrow(/HTTP 429/)
    expect(calls).toBe(3)
    calls = 0
    await expect(
      fetchJsonWithRetry('https://api.chess.com/pub/nope', {
        fetchImpl: async () => {
          calls++
          return { ok: false, status: 404 }
        },
        sleep
      })
    ).rejects.toThrow(/HTTP 404/)
    expect(calls).toBe(1)
  })
})
