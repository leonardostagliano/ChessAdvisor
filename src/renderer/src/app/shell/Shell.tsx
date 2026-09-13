import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { AppUpdatePrompt } from '../../components/AppUpdatePrompt'
import { ShortcutsSheet } from '../../components/ShortcutsSheet'
import { PlayScreen } from '../../features/play/PlayScreen'
import { ProgressScreen } from '../../features/progress/ProgressScreen'
import { SettingsScreen } from '../../features/settings/SettingsScreen'
import { TrainingScreen } from '../../features/training/TrainingScreen'
import { useGameStore } from '../../stores/gameStore'
import { useUiStore, watchSystemTheme, type Area } from '../../stores/uiStore'
import { useShortcutsKey } from '../keyboard'
import { Rail } from './Rail'
import styles from './Shell.module.css'

const SCREENS: Record<Area, () => React.JSX.Element> = {
  play: PlayScreen,
  training: TrainingScreen,
  progress: ProgressScreen,
  settings: SettingsScreen
}

export interface ShellProps {
  /** Rendered in place of the current area (the Codex guidance screen, spec §8). */
  overlay?: ReactNode
}

export function Shell({ overlay = null }: ShellProps = {}): React.JSX.Element {
  const area = useUiStore((state) => state.area)
  const aiThinking = useGameStore((state) => state.aiThinking)
  const coachBusy = useGameStore((state) => state.session.coach.busy)
  const Screen = SCREENS[area]
  const [shortcuts, setShortcuts] = useState(false)

  useEffect(() => watchSystemTheme(), [])
  useShortcutsKey(useCallback(() => setShortcuts(true), []))

  return (
    <div className={styles.shell}>
      <Rail />
      <main className={styles.content}>{overlay ?? <Screen />}</main>
      {/* Task 5: offered only when the main process reports an installable release, and never
          while the opponent is thinking or the coach is writing — an update prompt must not
          interrupt a turn (spec §3.5). */}
      <AppUpdatePrompt blocked={aiThinking || coachBusy} />
      {/* Task 22: `?` opens the shortcuts sheet from every area. */}
      <ShortcutsSheet open={shortcuts} onClose={() => setShortcuts(false)} />
    </div>
  )
}
