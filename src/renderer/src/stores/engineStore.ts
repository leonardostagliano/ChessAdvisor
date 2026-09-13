import { create } from 'zustand'
import { parseIpcError } from '@shared/ipcError'
import type { EngineState } from '@shared/types/engine'

/**
 * Renderer mirror of the Stockfish probe (`engine:state`).
 *
 * Nothing in the renderer drives the engine during a game — the main process owns the live
 * analysis — so this store exists to answer one question in several places: is the eval bar
 * (and everything else built on evaluations) available at all (spec §8)?
 */

export const INITIAL_ENGINE_STATE: EngineState = {
  available: false,
  binary: 'none',
  version: null,
  message: null
}

export interface EngineStoreState {
  state: EngineState
  available: boolean
  error: string | null
  apply(state: EngineState): void
  refresh(): Promise<void>
}

function bridge(): Window['api'] | undefined {
  return typeof window === 'undefined' ? undefined : window.api
}

export const useEngineStore = create<EngineStoreState>((set, get) => ({
  state: INITIAL_ENGINE_STATE,
  available: false,
  error: null,

  apply(state) {
    set({ state, available: state.available })
  },

  async refresh() {
    const api = bridge()
    if (!api) return
    try {
      get().apply(await api.engine.state())
    } catch (error) {
      set({ error: parseIpcError(error).message })
    }
  }
}))

/** Subscribes the store to `engine:state` and reads the current one; returns the unsubscribe. */
export function initEngineStore(): () => void {
  const api = bridge()
  if (!api) return () => {}
  const unsubscribe = api.on('engine:state', (state) => useEngineStore.getState().apply(state))
  void useEngineStore.getState().refresh()
  return unsubscribe
}
