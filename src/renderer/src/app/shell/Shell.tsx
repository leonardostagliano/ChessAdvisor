import { useEffect } from 'react'
import { AppUpdatePrompt } from '../../components/AppUpdatePrompt'
import { PlayScreen } from '../../features/play/PlayScreen'
import { ProgressScreen } from '../../features/progress/ProgressScreen'
import { SettingsScreen } from '../../features/settings/SettingsScreen'
import { TrainingScreen } from '../../features/training/TrainingScreen'
import { useUiStore, watchSystemTheme, type Area } from '../../stores/uiStore'
import { Rail } from './Rail'
import styles from './Shell.module.css'

const SCREENS: Record<Area, () => React.JSX.Element> = {
  play: PlayScreen,
  training: TrainingScreen,
  progress: ProgressScreen,
  settings: SettingsScreen
}

export function Shell(): React.JSX.Element {
  const area = useUiStore((state) => state.area)
  const Screen = SCREENS[area]

  useEffect(() => watchSystemTheme(), [])

  return (
    <div className={styles.shell}>
      <Rail />
      <main className={styles.content}>
        <Screen />
      </main>
      {/* Task 5: offered only when the main process reports an installable release. */}
      <AppUpdatePrompt />
    </div>
  )
}
