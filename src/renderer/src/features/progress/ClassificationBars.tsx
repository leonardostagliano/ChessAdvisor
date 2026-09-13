import { useTranslation } from 'react-i18next'
import { cx } from '../../components/ui/cx'
import { CLASSIFICATIONS, type ClassificationDistribution } from '../../stores/profileStore'
import styles from './Progress.module.css'

/**
 * How the user's own moves were judged (spec §6.9), over the games of the trend window.
 *
 * Two numbers per row because they answer two different questions: the share says what a typical
 * move of this player looks like, the per-game average says how many blunders a game actually
 * costs. The bar is the share; both values are printed, so the colour of a row is decoration
 * (spec §7).
 */

export interface ClassificationBarsProps {
  distribution: ClassificationDistribution
  className?: string
}

export function ClassificationBars({
  distribution,
  className
}: ClassificationBarsProps): React.JSX.Element {
  const { t } = useTranslation()
  const { games, moves, share, perGame } = distribution

  return (
    <section className={cx(styles.card, className)} aria-label={t('progress.classifications')}>
      <header className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{t('progress.classifications')}</h3>
        {moves > 0 ? (
          <span className={styles.note}>{t('progress.classificationsHint', { count: games })}</span>
        ) : null}
      </header>

      {moves === 0 ? (
        <p className={styles.note}>{t('progress.classificationsEmpty')}</p>
      ) : (
        <ul className={styles.bars} data-testid="classification-bars">
          {CLASSIFICATIONS.map((classification) => {
            const percent = share[classification]
            const label = t(`review.classification.${classification}`)
            return (
              <li
                key={classification}
                className={cx(styles.bar, styles[`fill_${classification}` as const])}
                data-classification={classification}
              >
                <span className={styles.barLabel}>{label}</span>
                <span
                  className={styles.barTrack}
                  role="img"
                  aria-label={t('progress.barAria', {
                    label,
                    percent: percent.toFixed(1),
                    value: perGame[classification].toFixed(1)
                  })}
                >
                  <span
                    className={styles.barFill}
                    style={{ width: `${Math.min(100, percent)}%` }}
                  />
                </span>
                <span className={styles.barValue}>
                  <span className={styles.barPrimary}>
                    {t('progress.percentValue', { value: percent.toFixed(1) })}
                  </span>
                  <span className={styles.barSecondary}>
                    {t('progress.perGame', { value: perGame[classification].toFixed(1) })}
                  </span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
