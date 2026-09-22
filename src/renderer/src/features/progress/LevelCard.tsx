import { useTranslation } from 'react-i18next'
import type { ProfileLevel, ProfileQualitative } from '@shared/types/profile'
import { Button } from '../../components/ui/Button'
import { cx } from '../../components/ui/cx'
import styles from './Progress.module.css'

/**
 * Band, estimate and confidence of the level (spec §6.1) with the coach's qualitative assessment
 * beside them (spec §6.9).
 *
 * The confidence is a ring rather than a bar because it is not a score: it says how much of a
 * window the estimate had. The percentage is printed inside the ring and repeated in the label of
 * the figure, so the arc never carries the value on its own (spec §7).
 *
 * "Aggiorna" asks the coach for a new assessment right away; without it the profile rewrites one
 * after every analysed match by itself.
 */

/** Geometry of the ring, in user units. */
const RING = { size: 96, radius: 40 }
const CIRCUMFERENCE = 2 * Math.PI * RING.radius

export interface LevelCardProps {
  level: ProfileLevel
  qualitative?: ProfileQualitative | null
  /** True while the coach is writing the assessment. */
  busy?: boolean
  onRefresh(): void
  className?: string
}

export function LevelCard({
  level,
  qualitative,
  busy = false,
  onRefresh,
  className
}: LevelCardProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const confidence = Math.round(Math.min(1, Math.max(0, level.confidence)) * 100)
  const band = t(`progress.band.${level.band}`)
  const estimated = level.estimate > 0
  const updated = new Date(level.updatedAt)
  const center = RING.size / 2

  return (
    <section className={cx(styles.card, className)} aria-label={t('progress.level')}>
      <header className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{t('progress.level')}</h3>
        <Button size="sm" disabled={busy} onClick={onRefresh}>
          {busy ? t('progress.refreshing') : t('progress.refresh')}
        </Button>
      </header>

      <div className={styles.levelRow}>
        <svg
          className={styles.ring}
          data-testid="confidence-ring"
          data-confidence={confidence}
          viewBox={`0 0 ${RING.size} ${RING.size}`}
          role="img"
          aria-label={t('progress.confidenceAria', { value: confidence })}
        >
          <circle className={styles.ringTrack} cx={center} cy={center} r={RING.radius} />
          <circle
            className={styles.ringFill}
            cx={center}
            cy={center}
            r={RING.radius}
            strokeDasharray={`${((confidence / 100) * CIRCUMFERENCE).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`}
            transform={`rotate(-90 ${center} ${center})`}
          />
          <text className={styles.ringValue} x={center} y={center + 2}>
            {t('progress.percentValue', { value: confidence })}
          </text>
          <text className={styles.ringCaption} x={center} y={center + 18}>
            {t('progress.confidence')}
          </text>
        </svg>

        <div className={styles.levelTexts}>
          <p className={styles.band}>{band}</p>
          <p className={styles.estimate}>
            {estimated
              ? t('progress.estimateValue', { value: level.estimate })
              : t('progress.noEstimate')}
          </p>
          <p className={styles.note}>{t('progress.confidenceHint')}</p>
          {Number.isNaN(updated.getTime()) || updated.getTime() === 0 ? null : (
            <p className={styles.note}>
              {t('progress.updated', { date: updated.toLocaleDateString(i18n.language) })}
            </p>
          )}
        </div>
      </div>

      {qualitative ? (
        <div className={styles.qualitative}>
          <div className={cx(styles.listBlock, styles.listStrengths)}>
            <p className={styles.listTitle}>{t('progress.strengths')}</p>
            <ul className={styles.list}>
              {qualitative.strengths.map((item, index) => (
                <li key={`s-${index}-${item.slice(0, 12)}`} className="selectable">
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className={cx(styles.listBlock, styles.listWeaknesses)}>
            <p className={styles.listTitle}>{t('progress.weaknesses')}</p>
            <ul className={styles.list}>
              {qualitative.weaknesses.map((item, index) => (
                <li key={`w-${index}-${item.slice(0, 12)}`} className="selectable">
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : (
        <p className={styles.note}>{t('progress.qualitativeEmpty')}</p>
      )}
    </section>
  )
}
