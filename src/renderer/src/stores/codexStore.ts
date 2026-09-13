import { create } from 'zustand'
import { parseIpcError } from '@shared/ipcError'
import type { CodexState, ModelInfo, QuotaSnapshot } from '@shared/types/codex'

/**
 * Renderer mirror of the Codex session (`codex:state`).
 *
 * The main process owns the app-server; this store only remembers the last state it published,
 * plus one renderer-side decision: the "Continua comunque" of the not-isolated screen, which is
 * a session flag and is deliberately never persisted (spec §8).
 */

export const INITIAL_CODEX_STATE: CodexState = { status: 'starting' }

export interface CodexStoreState {
  state: CodexState
  /** Models playable right now; kept across a reconnection so dialogs never blank out. */
  models: ModelInfo[]
  quota: QuotaSnapshot | null
  /** True only when the app-server is up, authenticated and isolated. */
  ready: boolean
  /** The user accepted a non-isolated environment for this run. */
  isolationAccepted: boolean
  error: string | null

  apply(state: CodexState): void
  refresh(): Promise<void>
  retry(): Promise<void>
  continueAnyway(): void
}

/** True while the Codex status screen must cover the app (spec §8, Task 10). */
export function codexBlocking(state: Pick<CodexStoreState, 'state' | 'isolationAccepted'>): boolean {
  if (state.state.status === 'ready') return false
  if (state.state.status === 'not-isolated' && state.isolationAccepted) return false
  return true
}

/** The default model of the list, or the first one; `null` when nothing is playable. */
export function defaultModel(models: ModelInfo[]): ModelInfo | null {
  return models.find((model) => model.isDefault) ?? models[0] ?? null
}

function bridge(): Window['api'] | undefined {
  return typeof window === 'undefined' ? undefined : window.api
}

export const useCodexStore = create<CodexStoreState>((set, get) => ({
  state: INITIAL_CODEX_STATE,
  models: [],
  quota: null,
  ready: false,
  isolationAccepted: false,
  error: null,

  apply(state) {
    const ready = state.status === 'ready'
    set({
      state,
      ready,
      // A restart briefly reports `starting`: keep the known models so the dialog stays usable.
      models: ready ? state.models : get().models,
      quota: ready ? state.quota : get().quota
    })
  },

  async refresh() {
    const api = bridge()
    if (!api) return
    try {
      get().apply(await api.codex.state())
    } catch (error) {
      set({ error: parseIpcError(error).message })
    }
  },

  async retry() {
    const api = bridge()
    if (!api) return
    set({ error: null })
    try {
      await api.codex.retry()
      get().apply(await api.codex.state())
    } catch (error) {
      set({ error: parseIpcError(error).message })
    }
  },

  continueAnyway() {
    set({ isolationAccepted: true })
  }
}))

/** Subscribes the store to `codex:state` and reads the current one; returns the unsubscribe. */
export function initCodexStore(): () => void {
  const api = bridge()
  if (!api) return () => {}
  const unsubscribe = api.on('codex:state', (state) => useCodexStore.getState().apply(state))
  void useCodexStore.getState().refresh()
  return unsubscribe
}
