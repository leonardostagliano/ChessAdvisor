import { create } from 'zustand'
import i18n from '../i18n'

export type Area = 'play' | 'training' | 'progress' | 'settings'
export type ThemeChoice = 'night' | 'editorial' | 'system'
export type ResolvedTheme = 'night' | 'editorial'
export type Language = 'it' | 'en'

export const UI_STORAGE_KEY = 'chessadvisor.ui'
export const AREAS: Area[] = ['play', 'training', 'progress', 'settings']
export const DARK_QUERY = '(prefers-color-scheme: dark)'

/**
 * A review another area asked to open (Task 21: the exercises of the training section link back
 * to the move they were carved out of). It is a one-shot request: the play area picks it up,
 * opens the review at that ply and clears it.
 */
export interface ReviewTarget {
  gameId: string
  /** `Move.ply`, 1-based, or `null` to open the review at the last move. */
  ply: number | null
}

export interface UiState {
  area: Area
  theme: ThemeChoice
  resolvedTheme: ResolvedTheme
  language: Language
  reviewTarget: ReviewTarget | null
  setArea(area: Area): void
  setTheme(theme: ThemeChoice): void
  setLanguage(language: Language): void
  /** Switches to the play area and asks it for the review of `gameId`, at `ply` when given. */
  openReview(gameId: string, ply?: number | null): void
  clearReviewTarget(): void
}

interface Persisted {
  theme: ThemeChoice
  language: Language
  area: Area
}

const isArea = (value: unknown): value is Area => AREAS.includes(value as Area)
const isTheme = (value: unknown): value is ThemeChoice =>
  value === 'night' || value === 'editorial' || value === 'system'
const isLanguage = (value: unknown): value is Language => value === 'it' || value === 'en'

function readPersisted(): Partial<Persisted> {
  try {
    const raw = window.localStorage.getItem(UI_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const candidate = parsed as Partial<Persisted>
    const out: Partial<Persisted> = {}
    if (isTheme(candidate.theme)) out.theme = candidate.theme
    if (isLanguage(candidate.language)) out.language = candidate.language
    if (isArea(candidate.area)) out.area = candidate.area
    return out
  } catch {
    return {}
  }
}

function writePersisted(value: Persisted): void {
  try {
    window.localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(value))
  } catch {
    /* private mode or a hardened profile: the UI still works in memory */
  }
}

/** Task 3 exposes window.api.settings.save; until then the mirror is a no-op. */
function mirrorToMain(patch: { theme?: ThemeChoice; language?: Language }): void {
  try {
    const bridge = (
      window as unknown as {
        api?: { settings?: { save?: (patch: unknown) => unknown } }
      }
    ).api
    void bridge?.settings?.save?.(patch)
  } catch {
    /* the bridge is optional */
  }
}

function prefersDark(): boolean {
  try {
    return window.matchMedia?.(DARK_QUERY).matches ?? true
  } catch {
    return true
  }
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  if (choice === 'system') return prefersDark() ? 'night' : 'editorial'
  return choice
}

/** How long the crossfade of themes.css lasts; kept in step with `--dur-3`. */
export const THEME_TRANSITION_MS = 320
let themeTimer: ReturnType<typeof setTimeout> | null = null

function applyTheme(theme: ResolvedTheme): void {
  try {
    const root = document.documentElement
    // Only a real change crossfades: the first paint must not fade in from nothing.
    if (root.dataset.theme && root.dataset.theme !== theme) {
      root.dataset.themeSwitching = 'true'
      if (themeTimer) clearTimeout(themeTimer)
      themeTimer = setTimeout(() => {
        themeTimer = null
        delete root.dataset.themeSwitching
      }, THEME_TRANSITION_MS)
    }
    root.dataset.theme = theme
  } catch {
    /* no document in a non-DOM environment */
  }
}

function applyLanguage(language: Language): void {
  try {
    void i18n.changeLanguage(language)
    document.documentElement.lang = language
  } catch {
    /* i18next is optional in isolated tests */
  }
}

const persisted = readPersisted()
const initial: Persisted = {
  theme: persisted.theme ?? 'system',
  language: persisted.language ?? 'it',
  area: persisted.area ?? 'play'
}

applyTheme(resolveTheme(initial.theme))
applyLanguage(initial.language)

export const useUiStore = create<UiState>((set, get) => ({
  area: initial.area,
  theme: initial.theme,
  resolvedTheme: resolveTheme(initial.theme),
  language: initial.language,
  reviewTarget: null,

  setArea(area) {
    if (!isArea(area) || get().area === area) return
    set({ area })
    const state = get()
    writePersisted({ theme: state.theme, language: state.language, area: state.area })
  },

  setTheme(theme) {
    if (!isTheme(theme)) return
    const resolvedTheme = resolveTheme(theme)
    set({ theme, resolvedTheme })
    applyTheme(resolvedTheme)
    const state = get()
    writePersisted({ theme: state.theme, language: state.language, area: state.area })
    mirrorToMain({ theme })
  },

  setLanguage(language) {
    if (!isLanguage(language)) return
    set({ language })
    applyLanguage(language)
    const state = get()
    writePersisted({ theme: state.theme, language: state.language, area: state.area })
    mirrorToMain({ language })
  },

  openReview(gameId, ply = null) {
    if (typeof gameId !== 'string' || gameId.length === 0) return
    // One `set`: the area guard of `setArea` would drop the switch when play is already open,
    // and the request has to land whether or not the area changes.
    set({ area: 'play', reviewTarget: { gameId, ply: typeof ply === 'number' ? ply : null } })
    const state = get()
    writePersisted({ theme: state.theme, language: state.language, area: state.area })
  },

  clearReviewTarget() {
    if (get().reviewTarget) set({ reviewTarget: null })
  }
}))

/** Keeps `resolvedTheme` in sync with the OS while the choice is `system`. */
export function watchSystemTheme(): () => void {
  let media: MediaQueryList | undefined
  try {
    media = window.matchMedia?.(DARK_QUERY)
  } catch {
    media = undefined
  }
  if (!media) return () => {}

  const onChange = (event: MediaQueryListEvent | MediaQueryList): void => {
    if (useUiStore.getState().theme !== 'system') return
    const resolvedTheme: ResolvedTheme = event.matches ? 'night' : 'editorial'
    useUiStore.setState({ resolvedTheme })
    applyTheme(resolvedTheme)
  }

  if (typeof media.addEventListener === 'function') {
    media.addEventListener('change', onChange)
    return () => media?.removeEventListener('change', onChange)
  }
  media.addListener(onChange)
  return () => media?.removeListener(onChange)
}
