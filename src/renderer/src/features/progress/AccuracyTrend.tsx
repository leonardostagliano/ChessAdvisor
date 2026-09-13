import { useTranslation } from 'react-i18next'
import type { ProfileHistoryEntry } from '@shared/types/profile'
import { cx } from '../../components/ui/cx'
import { TREND_WINDOW } from '../../stores/profileStore'
import styles from './Progress.module.css'

/**
 * Accuracy of the last matches as one inline SVG (spec §6.9): x is the game, oldest on the left,
 * y the accuracy of the user's own moves on a fixed 0–100 scale, so two visits to this screen are
 * comparable and a bad game cannot be hidden by a rescale.
 *
 * Accessibility (spec §7: never colour alone): the axis carries printed values, the last point is
 * labelled with its number, every point has a `<title>` with date, accuracy and ACPL, and the
 * legend under the chart repeats the last value and the average as text.
 */

/** Geometry in user units; the SVG scales uniformly to its container. */
export const TREND_WIDTH = 960
export const TREND_HEIGHT = 180
const PAD = { top: 18, right: 22, bottom: 30, left: 46 }
const PLOT_WIDTH = TREND_WIDTH - PAD.left - PAD.right
const PLOT_HEIGHT = TREND_HEIGHT - PAD.top - PAD.bottom

/** Horizontal rules, in accuracy points: the ends of the scale and the middle. */
const GRID = [0, 50, 100]

export interface TrendPoint extends ProfileHistoryEntry {
  /** Position in the window, `0` being the oldest game shown. */
  index: number
  x: number
  y: number
}

const clamp = (value: number): number => Math.min(100, Math.max(0, value))

/**
 * The window of spec §6.9: the last {@link TREND_WINDOW} analysed matches, oldest first, exactly
 * as `Profile.history` keeps them. Entries without a usable accuracy are dropped rather than
 * drawn at zero.
 */
export function trendPoints(
  history: readonly ProfileHistoryEntry[],
  limit = TREND_WINDOW
): TrendPoint[] {
  const window = history.filter((entry) => Number.isFinite(entry.accuracy)).slice(-limit)
  const last = Math.max(1, window.length - 1)
  return window.map((entry, index) => ({
    ...entry,
    accuracy: clamp(entry.accuracy),
    index,
    x: PAD.left + (window.length === 1 ? PLOT_WIDTH / 2 : (index / last) * PLOT_WIDTH),
    y: PAD.top + PLOT_HEIGHT - (clamp(entry.accuracy) / 100) * PLOT_HEIGHT
  }))
}

/** Mean accuracy of the drawn window, one decimal; `0` when there is nothing to average. */
export function trendAverage(points: readonly TrendPoint[]): number {
  if (points.length === 0) return 0
  return (
    Math.round((points.reduce((sum, point) => sum + point.accuracy, 0) / points.length) * 10) / 10
  )
}

export interface AccuracyTrendProps {
  history: readonly ProfileHistoryEntry[]
  className?: string
}

export function AccuracyTrend({ history, className }: AccuracyTrendProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const points = trendPoints(history)

  if (points.length === 0) {
    return (
      <section className={cx(styles.card, className)} aria-label={t('progress.trend')}>
        <header className={styles.cardHead}>
          <h3 className={styles.cardTitle}>{t('progress.trend')}</h3>
        </header>
        <p className={styles.note}>{t('progress.trendEmpty')}</p>
      </section>
    )
  }

  const line = points.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' ')
  const bottom = PAD.top + PLOT_HEIGHT
  const area = `${points[0]!.x.toFixed(2)},${bottom} ${line} ${points[points.length - 1]!.x.toFixed(2)},${bottom}`
  const last = points[points.length - 1]!
  const average = trendAverage(points)
  const date = (value: string): string => {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(i18n.language)
  }

  return (
    <section className={cx(styles.card, className)} aria-label={t('progress.trend')}>
      <header className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{t('progress.trend')}</h3>
        <span className={styles.note}>{t('progress.trendCount', { count: points.length })}</span>
      </header>

      <svg
        className={styles.trend}
        data-testid="accuracy-trend"
        viewBox={`0 0 ${TREND_WIDTH} ${TREND_HEIGHT}`}
        role="img"
        aria-label={t('progress.trendAria', { count: points.length })}
      >
        {GRID.map((value) => {
          const y = PAD.top + PLOT_HEIGHT - (value / 100) * PLOT_HEIGHT
          return (
            <g key={value}>
              <line
                className={styles.trendGrid}
                x1={PAD.left}
                y1={y}
                x2={TREND_WIDTH - PAD.right}
                y2={y}
              />
              <text className={styles.trendAxis} x={PAD.left - 6} y={y + 3} textAnchor="end">
                {value}
              </text>
            </g>
          )
        })}

        <polygon className={styles.trendArea} points={area} />
        <polyline className={styles.trendLine} points={line} />

        {points.map((point) => (
          <circle
            key={`${point.gameId}-${point.index}`}
            className={cx(styles.trendDot, point.index === last.index && styles.trendLast)}
            data-point={point.index}
            data-accuracy={point.accuracy}
            cx={point.x}
            cy={point.y}
            r={point.index === last.index ? 5 : 3.5}
          >
            <title>
              {t('progress.trendPoint', {
                date: date(point.date),
                accuracy: point.accuracy.toFixed(1),
                acpl: Math.round(point.acpl)
              })}
            </title>
          </circle>
        ))}

        {/* The most recent value is printed on the chart itself: the one number a glance wants. */}
        <text
          className={styles.trendLabel}
          x={Math.min(TREND_WIDTH - PAD.right - 14, Math.max(PAD.left + 14, last.x))}
          y={Math.max(PAD.top - 4, last.y - 10)}
        >
          {t('progress.percentValue', { value: last.accuracy.toFixed(1) })}
        </text>

        <text className={styles.trendAxis} x={PAD.left} y={TREND_HEIGHT - 8}>
          {date(points[0]!.date)}
        </text>
        <text
          className={styles.trendAxis}
          x={TREND_WIDTH - PAD.right}
          y={TREND_HEIGHT - 8}
          textAnchor="end"
        >
          {date(last.date)}
        </text>
      </svg>

      <p className={styles.legend}>
        <span>
          {t('progress.trendLast')}{' '}
          <span className={styles.legendValue}>
            {t('progress.percentValue', { value: last.accuracy.toFixed(1) })}
          </span>
        </span>
        <span>
          {t('progress.trendAverage')}{' '}
          <span className={styles.legendValue}>
            {t('progress.percentValue', { value: average.toFixed(1) })}
          </span>
        </span>
      </p>
    </section>
  )
}
