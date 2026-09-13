import { create } from 'zustand'
import { parseIpcError } from '@shared/ipcError'
import type { Game, MoveClassification } from '@shared/types/game'
import type { Profile } from '@shared/types/profile'

/**
 * Renderer mirror of `profile.json` (spec §5) and of the one thing the profile does *not* keep:
 * how the user's own moves were classified.
 *
 * The main process owns the profile entirely — the analysis of a match writes it — so this store
 * reads it, follows `profile:changed` and asks for a fresh qualitative assessment. The
 * classification distribution of the dashboard (spec §6.9) is not a field of the profile: it is
 * recomputed here from the games of the trend window, which are the only ones the dashboard shows
 * anyway, and a game that cannot be read simply does not contribute.
 */

/** Matches the dashboard looks at: the accuracy trend and the distribution share it (spec §6.9). */
export const TREND_WINDOW = 20

/** The seven judgements of the analysis, from the best to the worst (spec §3.1). */
export const CLASSIFICATIONS: readonly MoveClassification[] = [
  'book',
  'best',
  'excellent',
  'good',
  'inaccuracy',
  'mistake',
  'blunder'
]

export type ClassificationCounts = Record<MoveClassification, number>

export interface ClassificationDistribution {
  /** Games that contributed at least one classified move of the user. */
  games: number
  /** The user's classified moves those games hold in total. */
  moves: number
  /** Mean number of the user's own moves per game, one decimal. */
  perGame: ClassificationCounts
  /** Share of the user's classified moves, percent with one decimal. */
  share: ClassificationCounts
}

export function emptyCounts(): ClassificationCounts {
  return { book: 0, best: 0, excellent: 0, good: 0, inaccuracy: 0, mistake: 0, blunder: 0 }
}

export function emptyDistribution(): ClassificationDistribution {
  return { games: 0, moves: 0, perGame: emptyCounts(), share: emptyCounts() }
}

const round1 = (value: number): number => Math.round(value * 10) / 10

/**
 * The distribution of spec §6.9: only the user's own analysed moves count, the average is per
 * game (so a long game does not drown a short one) and the share is over the moves themselves.
 */
export function distributionOf(games: readonly (Game | null | undefined)[]): ClassificationDistribution {
  const totals = emptyCounts()
  let played = 0
  let counted = 0

  for (const game of games) {
    if (!game) continue
    const own = game.moves.filter((move) => move.by === 'user' && move.eval)
    if (own.length === 0) continue
    counted += 1
    for (const move of own) {
      totals[move.eval!.classification] += 1
      played += 1
    }
  }

  if (counted === 0 || played === 0) return emptyDistribution()

  const perGame = emptyCounts()
  const share = emptyCounts()
  for (const classification of CLASSIFICATIONS) {
    perGame[classification] = round1(totals[classification] / counted)
    share[classification] = round1((totals[classification] / played) * 100)
  }
  return { games: counted, moves: played, perGame, share }
}

/** The games of the trend window, oldest first, as `Profile.history` keeps them. */
export function recentGameIds(profile: Profile | null | undefined): string[] {
  return (profile?.history ?? []).slice(-TREND_WINDOW).map((entry) => entry.gameId)
}

export interface ProfileStoreState {
  profile: Profile | null
  /** True while the first read is in flight. */
  loading: boolean
  /** True while the coach is rewriting the qualitative assessment. */
  refreshing: boolean
  error: string | null
  distribution: ClassificationDistribution
  /** Window `distribution` was computed for, as a comma-joined list of game ids. */
  distributionFor: string

  load(): Promise<void>
  refreshQualitative(): Promise<void>
  apply(profile: Profile): void
  clearError(): void
}

/** The bridge is absent in unit tests and in a renderer opened without the preload. */
function bridge(): Window['api'] | undefined {
  return typeof window === 'undefined' ? undefined : window.api
}

function failure(error: unknown): string {
  const { message, code } = parseIpcError(error)
  return message.length > 0 ? message : code
}

export const useProfileStore = create<ProfileStoreState>((set, get) => {
  /** Guards against an older read landing after a newer one. */
  let token = 0

  /** Reads the games of the trend window once; an unchanged window is never read twice. */
  async function loadDistribution(profile: Profile): Promise<void> {
    const api = bridge()
    const ids = recentGameIds(profile)
    const key = ids.join(',')
    if (!api || key === get().distributionFor) return
    const mine = (token += 1)
    if (ids.length === 0) {
      set({ distribution: emptyDistribution(), distributionFor: key })
      return
    }
    try {
      const games = await Promise.all(ids.map((id) => api.games.get(id).catch(() => null)))
      if (mine !== token) return
      set({ distribution: distributionOf(games), distributionFor: key })
    } catch {
      // The bars are an extra: a profile that reads fine still deserves its level and its trend.
      if (mine === token) set({ distribution: emptyDistribution(), distributionFor: key })
    }
  }

  return {
    profile: null,
    loading: false,
    refreshing: false,
    error: null,
    distribution: emptyDistribution(),
    distributionFor: '',

    async load() {
      const api = bridge()
      if (!api) return
      set({ loading: true, error: null })
      try {
        const profile = await api.profile.get()
        set({ profile, loading: false })
        await loadDistribution(profile)
      } catch (error) {
        set({ loading: false, error: failure(error) })
      }
    },

    async refreshQualitative() {
      const api = bridge()
      if (!api || get().refreshing) return
      set({ refreshing: true, error: null })
      try {
        const profile = await api.profile.refreshQualitative()
        set({ profile })
        await loadDistribution(profile)
      } catch (error) {
        set({ error: failure(error) })
      } finally {
        set({ refreshing: false })
      }
    },

    apply(profile) {
      if (!profile) return
      set({ profile })
      void loadDistribution(profile)
    },

    clearError() {
      set({ error: null })
    }
  }
})

/** Subscribes the store to `profile:changed` and reads the profile; returns the unsubscribe. */
export function initProfileStore(): () => void {
  const api = bridge()
  if (!api) return () => {}
  const unsubscribe = api.on('profile:changed', (profile) => useProfileStore.getState().apply(profile))
  void useProfileStore.getState().load()
  return unsubscribe
}
