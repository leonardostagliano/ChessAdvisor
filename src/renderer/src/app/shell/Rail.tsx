import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppVersionInfo } from '@shared/types/api'
import { cx } from '../../components/ui/cx'
import { Icon, type IconName } from '../../components/ui/Icon'
import { useUiStore, type Area } from '../../stores/uiStore'
import logo from '../../../../../resources/icon.png'
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

/**
 * Version identity of the running build, read once from the main process (spec §3.4).
 *
 * `null` means "not known yet": the pill is not rendered at all rather than showing a made-up
 * number, because a wrong version in the corner of the window is worse than no version.
 */
export function useVersionInfo(): AppVersionInfo | null {
  const [info, setInfo] = useState<AppVersionInfo | null>(null)

  useEffect(() => {
    let alive = true
    const bridge = typeof window === 'undefined' ? undefined : window.api
    if (!bridge?.app?.versionInfo) return
    void bridge.app
      .versionInfo()
      .then((value) => {
        if (alive && value && typeof value.version === 'string') setInfo(value)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])

  return info
}

export function Rail(): React.JSX.Element {
  const { t } = useTranslation()
  const area = useUiStore((state) => state.area)
  const setArea = useUiStore((state) => state.setArea)
  const version = useVersionInfo()

  const versionLabel = version
    ? version.isPackaged
      ? t('rail.versionInstalled', { version: version.version })
      : t('rail.versionDev', { version: version.version })
    : null
  const versionHint = version
    ? version.isPackaged
      ? t('rail.versionInstalledHint', { version: version.version })
      : t('rail.versionDevHint', { version: version.version })
    : t('app.name')

  return (
    <nav className={styles.rail} aria-label={t('app.name')}>
      {/* Brand block: on the 72 px rail the name is for assistive tech only, while the compact
          version pill stays visible under the logo; the tooltip carries the full wording. */}
      <div className={styles.brand} title={versionHint} data-testid="rail-brand">
        <img className={styles.brandLogo} src={logo} alt="" width={38} height={38} />
        <span className={cx(styles.brandTexts, styles.narrowHidden)}>
          <span className={styles.brandName}>{t('app.name')}</span>
          {versionLabel ? <span>{versionLabel}</span> : null}
        </span>
        {version ? (
          <span className={styles.version} aria-label={versionHint} data-testid="rail-version">
            {version.isPackaged ? `v${version.version}` : `dev ${version.version}`}
          </span>
        ) : null}
      </div>

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
