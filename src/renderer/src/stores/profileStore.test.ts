import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EMPTY_PROFILE, type Profile } from '@shared/types/profile'
import type { Game } from '@shared/types/game'
import { emptyDistribution, useProfileStore } from './profileStore'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  useProfileStore.setState({
    profile: null,
    loading: false,
    error: null,
    distribution: emptyDistribution(),
    distributionFor: ''
  })
})

describe('profile refresh ordering', () => {
  it('does not restore deleted history from a pending initial read', async () => {
    const pending = deferred<Profile>()
    window.api = {
      profile: { get: () => pending.promise },
      games: { get: vi.fn() }
    } as unknown as Window['api']
    const loading = useProfileStore.getState().load()
    const latest = structuredClone(EMPTY_PROFILE)
    useProfileStore.getState().apply(latest)
    pending.resolve({
      ...latest,
      history: [{ gameId: 'deleted', date: '2026-09-22', accuracy: 70, acpl: 50 }]
    })
    await loading
    expect(useProfileStore.getState().profile?.history).toEqual([])
    expect(useProfileStore.getState().loading).toBe(false)
  })

  it('refreshes move grades when the same game is reanalysed', async () => {
    const profile = {
      ...structuredClone(EMPTY_PROFILE),
      history: [{ gameId: 'g', date: '2026-09-22', accuracy: 70, acpl: 50 }]
    }
    const get = vi
      .fn()
      .mockResolvedValue({ moves: [{ by: 'user', eval: { classification: 'blunder' } }] } as Game)
    window.api = { games: { get } } as unknown as Window['api']
    useProfileStore.getState().apply(profile)
    await vi.waitFor(() => expect(useProfileStore.getState().distribution.share.blunder).toBe(100))
    get.mockResolvedValue({ moves: [{ by: 'user', eval: { classification: 'good' } }] } as Game)
    useProfileStore.getState().apply(profile)
    await vi.waitFor(() => expect(useProfileStore.getState().distribution.share.good).toBe(100))
  })

  it('does not restore a pending distribution after every game was deleted', async () => {
    const pending = deferred<Game>()
    window.api = { games: { get: () => pending.promise } } as unknown as Window['api']
    useProfileStore
      .getState()
      .apply({
        ...structuredClone(EMPTY_PROFILE),
        history: [{ gameId: 'g', date: '2026-09-22', accuracy: 70, acpl: 50 }]
      })
    useProfileStore.getState().apply(structuredClone(EMPTY_PROFILE))
    pending.resolve({ moves: [{ by: 'user', eval: { classification: 'blunder' } }] } as Game)
    await Promise.resolve()
    await Promise.resolve()
    expect(useProfileStore.getState().distribution.moves).toBe(0)
  })
})
