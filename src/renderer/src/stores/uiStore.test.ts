import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const changeLanguage = vi.fn()

vi.mock('../i18n', () => ({
  default: { changeLanguage, language: 'it' }
}))

interface FakeMediaQueryList {
  matches: boolean
  media: string
  addEventListener(type: 'change', cb: (e: { matches: boolean }) => void): void
  removeEventListener(type: 'change', cb: (e: { matches: boolean }) => void): void
  addListener(cb: (e: { matches: boolean }) => void): void
  removeListener(cb: (e: { matches: boolean }) => void): void
  emit(matches: boolean): void
}

function installMatchMedia(matches: boolean): FakeMediaQueryList {
  const listeners = new Set<(e: { matches: boolean }) => void>()
  const mql: FakeMediaQueryList = {
    matches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type, cb) => void listeners.add(cb),
    removeEventListener: (_type, cb) => void listeners.delete(cb),
    addListener: (cb) => void listeners.add(cb),
    removeListener: (cb) => void listeners.delete(cb),
    emit: (next) => {
      mql.matches = next
      for (const cb of listeners) cb({ matches: next })
    }
  }
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql)
  )
  return mql
}

async function loadStore(): Promise<typeof import('./uiStore')> {
  vi.resetModules()
  return import('./uiStore')
}

beforeEach(() => {
  changeLanguage.mockClear()
  window.localStorage.clear()
  delete document.documentElement.dataset.theme
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('uiStore', () => {
  it('resolves the system theme to night when the OS prefers dark', async () => {
    installMatchMedia(true)
    const { useUiStore } = await loadStore()
    const state = useUiStore.getState()
    expect(state.theme).toBe('system')
    expect(state.resolvedTheme).toBe('night')
    expect(document.documentElement.dataset.theme).toBe('night')
  })

  it('resolves the system theme to editorial when the OS prefers light', async () => {
    installMatchMedia(false)
    const { useUiStore } = await loadStore()
    expect(useUiStore.getState().resolvedTheme).toBe('editorial')
    expect(document.documentElement.dataset.theme).toBe('editorial')
  })

  it('applies an explicit theme choice regardless of the system preference', async () => {
    installMatchMedia(true)
    const { useUiStore } = await loadStore()
    useUiStore.getState().setTheme('editorial')
    expect(useUiStore.getState().resolvedTheme).toBe('editorial')
    expect(document.documentElement.dataset.theme).toBe('editorial')
  })

  it('follows system changes while the choice is system and stops after unsubscribing', async () => {
    const mql = installMatchMedia(true)
    const { useUiStore, watchSystemTheme } = await loadStore()
    const stop = watchSystemTheme()
    mql.emit(false)
    expect(useUiStore.getState().resolvedTheme).toBe('editorial')
    mql.emit(true)
    expect(useUiStore.getState().resolvedTheme).toBe('night')
    useUiStore.getState().setTheme('editorial')
    mql.emit(true)
    expect(useUiStore.getState().resolvedTheme).toBe('editorial')
    stop()
    useUiStore.getState().setTheme('system')
    mql.emit(false)
    expect(useUiStore.getState().resolvedTheme).toBe('night')
  })

  it('setArea changes the active area', async () => {
    installMatchMedia(true)
    const { useUiStore } = await loadStore()
    expect(useUiStore.getState().area).toBe('play')
    useUiStore.getState().setArea('settings')
    expect(useUiStore.getState().area).toBe('settings')
  })

  it('setLanguage changes the i18next language', async () => {
    installMatchMedia(true)
    const { useUiStore } = await loadStore()
    useUiStore.getState().setLanguage('en')
    expect(useUiStore.getState().language).toBe('en')
    expect(changeLanguage).toHaveBeenCalledWith('en')
  })

  it('persists theme, language and area and restores them on the next load', async () => {
    installMatchMedia(true)
    const first = await loadStore()
    first.useUiStore.getState().setTheme('editorial')
    first.useUiStore.getState().setLanguage('en')
    first.useUiStore.getState().setArea('training')
    expect(JSON.parse(window.localStorage.getItem(first.UI_STORAGE_KEY) ?? '{}')).toEqual({
      theme: 'editorial',
      language: 'en',
      area: 'training'
    })

    const second = await loadStore()
    const state = second.useUiStore.getState()
    expect(state.theme).toBe('editorial')
    expect(state.language).toBe('en')
    expect(state.area).toBe('training')
  })

  it('ignores a corrupt persisted payload', async () => {
    installMatchMedia(true)
    window.localStorage.setItem('chessadvisor.ui', '{not json')
    const { useUiStore } = await loadStore()
    expect(useUiStore.getState().theme).toBe('system')
    expect(useUiStore.getState().area).toBe('play')
  })

  it('does not throw when localStorage is unavailable', async () => {
    installMatchMedia(true)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied')
    })
    const { useUiStore } = await loadStore()
    expect(() => useUiStore.getState().setTheme('night')).not.toThrow()
    expect(() => useUiStore.getState().setArea('progress')).not.toThrow()
    expect(() => useUiStore.getState().setLanguage('en')).not.toThrow()
    expect(useUiStore.getState().resolvedTheme).toBe('night')
  })

  it('mirrors theme and language to window.api.settings.save when available', async () => {
    installMatchMedia(true)
    const save = vi.fn(async () => ({}))
    vi.stubGlobal('api', { settings: { save } })
    const { useUiStore } = await loadStore()
    useUiStore.getState().setTheme('night')
    expect(save).toHaveBeenCalledWith({ theme: 'night' })
    useUiStore.getState().setLanguage('en')
    expect(save).toHaveBeenCalledWith({ language: 'en' })
  })
})
