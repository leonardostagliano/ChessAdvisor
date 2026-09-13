import { useEffect } from 'react'
import { Shell } from './app/shell/Shell'
import { CodexStatusScreen } from './features/status/CodexStatusScreen'
import { codexBlocking, initCodexStore, useCodexStore } from './stores/codexStore'
import { initEngineStore } from './stores/engineStore'
import { initGameStore } from './stores/gameStore'
import { useUiStore } from './stores/uiStore'

/**
 * Root of the renderer.
 *
 * It does two things only: it subscribes the three mirrors of the main process (Codex, engine,
 * game) for the lifetime of the window, and it decides whether the app is usable at all — with
 * no ready Codex session there is nothing to play against, so every area but Settings is
 * replaced by the guidance screen (spec §8). Settings stays reachable because that is where the
 * user checks the connection, the engine and the updates.
 */
function App(): React.JSX.Element {
  const area = useUiStore((state) => state.area)
  const blocking = useCodexStore((state) => codexBlocking(state))

  useEffect(() => {
    const unsubscribe = [initCodexStore(), initEngineStore(), initGameStore()]
    return () => {
      for (const stop of unsubscribe) stop()
    }
  }, [])

  return <Shell overlay={blocking && area !== 'settings' ? <CodexStatusScreen /> : null} />
}

export default App
