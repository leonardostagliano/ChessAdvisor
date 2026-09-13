import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ClockState } from '@shared/types/session'
import { cx } from '../../components/ui/cx'
import styles from './ClockDisplay.module.css'

/**
 * One side's clock (spec §4.3).
 *
 * The main process is the only authority on the time left: it pushes `remainingMs` with the
 * timestamp it was measured at, and this component interpolates between two pushes purely for
 * display — it never subtracts a tick from its own value, so a slow render, a suspended machine
 * or a dropped `game:state` can make the number stale but never wrong.
 */

/** Under ten seconds the tenths are shown: that is when they start to matter. */
export const TENTHS_UNDER_MS = 10_000
/** Fast enough for the tenths to move, cheap enough to run next to the board. */
const TICK_MS = 100

export interface ClockDisplayProps {
  /** Clocks of the running game, or `null` when it is played without them. */
  clock: ClockState | null
  color: 'w' | 'b'
  /** Accessible name of the timer ("Il tuo orologio", "Orologio dell'avversario"). */
  label: string
  className?: string
}

/** `mm:ss`, or `mm:ss.t` under {@link TENTHS_UNDER_MS}. Minutes are uncapped. */
export function formatClock(ms: number): string {
  const left = Math.max(0, Math.floor(ms))
  const seconds = Math.floor(left / 1000)
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
  const ss = String(seconds % 60).padStart(2, '0')
  if (left >= TENTHS_UNDER_MS) return `${mm}:${ss}`
  return `${mm}:${ss}.${Math.floor((left % 1000) / 100)}`
}

/** Time `color` has left at `now`, by difference from the snapshot — never by counting ticks. */
export function remainingAt(clock: ClockState, color: 'w' | 'b', now: number): number {
  const base = clock.remainingMs[color] ?? 0
  if (clock.running !== color) return Math.max(0, base)
  return Math.max(0, base - Math.max(0, now - clock.updatedAt))
}

export function ClockDisplay({
  clock,
  color,
  label,
  className
}: ClockDisplayProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const running = clock?.running === color
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!running) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [running, clock?.updatedAt])

  if (!clock) return null

  const left = remainingAt(clock, color, now)
  const expired = left <= 0

  return (
    <div
      role="timer"
      aria-label={label}
      className={cx(styles.clock, running && styles.running, expired && styles.expired, className)}
    >
      <span className={cx(styles.time, 'mono')}>{formatClock(left)}</span>
      {expired ? <span className={styles.flag}>{t('clock.expired')}</span> : null}
    </div>
  )
}
