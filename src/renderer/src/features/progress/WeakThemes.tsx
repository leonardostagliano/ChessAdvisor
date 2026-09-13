import { useTranslation } from 'react-i18next'
import type { ThemeStat } from '@shared/types/profile'
import { cx } from '../../components/ui/cx'
import styles from './Progress.module.css'

/**
 * The five themes that come up most often in the user's key moments (spec §6.9).
 *
 * They are the counters the labelling call of spec §6.3 fills, so a theme here is always one of
 * the fixed taxonomy and has a translated name; an unknown key (a profile written by a newer
 * version) falls back to its own identifier rather than disappearing.
 */

/** Themes on screen (spec §6.9). */
export const TOP_THEMES = 5

export interface ThemeRow {
  theme: string
  occurrences: number
  lastSeen: string
}

/** Most frequent first; ties go to the theme seen most recently. */
export function topThemes(stats: Record<string, ThemeStat> | undefined, limit = TOP_THEMES): ThemeRow[] {
  return Object.entries(stats ?? {})
    .filter(([, stat]) => (stat?.occurrences ?? 0) > 0)
    .map(([theme, stat]) => ({ theme, occurrences: stat.occurrences, lastSeen: stat.lastSeen ?? '' }))
    .sort((a, b) => b.occurrences - a.occurrences || (a.lastSeen < b.lastSeen ? 1 : a.lastSeen > b.lastSeen ? -1 : 0))
    .slice(0, limit)
}

export interface WeakThemesProps {
  themeStats: Record<string, ThemeStat> | undefined
  className?: string
}

export function WeakThemes({ themeStats, className }: WeakThemesProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const rows = topThemes(themeStats)
  const max = rows.reduce((top, row) => Math.max(top, row.occurrences), 0)

  return (
    <section className={cx(styles.card, className)} aria-label={t('progress.weakThemes')}>
      <header className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{t('progress.weakThemes')}</h3>
        <span className={styles.note}>{t('progress.weakThemesHint')}</span>
      </header>

      {rows.length === 0 ? (
        <p className={styles.note}>{t('progress.weakThemesEmpty')}</p>
      ) : (
        <ul className={styles.bars} data-testid="weak-themes">
          {rows.map((row) => {
            const name = t(`themes.${row.theme}`, { defaultValue: row.theme })
            const seen = new Date(row.lastSeen)
            return (
              <li key={row.theme} className={cx(styles.bar, styles.fill_theme)} data-theme={row.theme}>
                <span className={styles.barLabel}>{name}</span>
                <span
                  className={styles.barTrack}
                  role="img"
                  aria-label={t('progress.themeAria', { label: name, count: row.occurrences })}
                >
                  <span
                    className={styles.barFill}
                    style={{ width: `${max > 0 ? Math.round((row.occurrences / max) * 100) : 0}%` }}
                  />
                </span>
                <span className={styles.barValue}>
                  <span className={styles.barPrimary}>{t('progress.occurrences', { count: row.occurrences })}</span>
                  {Number.isNaN(seen.getTime()) ? null : (
                    <span className={styles.barSecondary}>
                      {t('progress.lastSeen', { date: seen.toLocaleDateString(i18n.language) })}
                    </span>
                  )}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
