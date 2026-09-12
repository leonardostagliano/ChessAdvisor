import { useTranslation } from 'react-i18next'
import { cx } from '../../components/ui/cx'
import { Icon, type IconName } from '../../components/ui/Icon'
import { useUiStore, type Area } from '../../stores/uiStore'
import styles from './Shell.module.css'

interface RailItem {
  area: Area
  icon: IconName
}

const ITEMS: RailItem[] = [
  { area: 'play', icon: 'play' },
  { area: 'training', icon: 'training' },
  { area: 'progress', icon: 'progress' },
  { area: 'settings', icon: 'settings' }
]

export function Rail(): React.JSX.Element {
  const { t } = useTranslation()
  const area = useUiStore((state) => state.area)
  const setArea = useUiStore((state) => state.setArea)

  return (
    <nav className={styles.rail} aria-label={t('app.name')}>
      <ul className={styles.railList}>
        {ITEMS.map((item) => {
          const active = item.area === area
          const label = t(`rail.${item.area}`)
          return (
            <li key={item.area}>
              <button
                type="button"
                title={label}
                aria-current={active ? 'page' : undefined}
                className={cx(styles.railItem, active && styles.railItemActive)}
                onClick={() => setArea(item.area)}
              >
                <span aria-hidden="true" className={styles.railIndicator} />
                <Icon name={item.icon} size={22} />
                <span className={styles.railLabel}>{label}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
