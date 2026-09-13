import { useTranslation } from 'react-i18next'
import type { Eval } from '@shared/types/game'
import { cx } from '../components/ui/cx'
import styles from './EvalBar.module.css'

export interface EvalBarProps {
  /** Score of the position, always from White's point of view; `null` while nothing is known. */
  evaluation?: Eval | null
  orientation?: 'white' | 'black'
  /** Spec §8: with no Stockfish the bar is not rendered at all. */
  available?: boolean
  className?: string
}

/** Lichess' logistic mapping of a centipawn score to a winning percentage (spec §6, step 3). */
const WIN_PERCENT_SCALE = 0.00368208

/** White's share of the bar, 0–100. A mate is all the way to one side. */
export function whiteWinPercent(evaluation?: Eval | null): number {
  if (!evaluation) return 50
  if (typeof evaluation.mate === 'number') {
    if (evaluation.mate === 0) return 50
    return evaluation.mate > 0 ? 100 : 0
  }
  if (typeof evaluation.cp !== 'number' || !Number.isFinite(evaluation.cp)) return 50
  const share = 50 + 50 * (2 / (1 + Math.exp(-WIN_PERCENT_SCALE * evaluation.cp)) - 1)
  return Math.min(100, Math.max(0, share))
}

/** `+0.8`, `-1.3`, `M3`, `-M2`; an em dash while the engine has not answered yet. */
export function evalLabel(evaluation?: Eval | null): string {
  if (!evaluation) return '—'
  if (typeof evaluation.mate === 'number') {
    const plies = Math.abs(evaluation.mate)
    return evaluation.mate < 0 ? `-M${plies}` : `M${plies}`
  }
  if (typeof evaluation.cp !== 'number' || !Number.isFinite(evaluation.cp)) return '—'
  const pawns = evaluation.cp / 100
  const text = Math.abs(pawns).toFixed(1)
  if (Math.abs(pawns) < 0.05) return '0.0'
  return `${pawns > 0 ? '+' : '-'}${text}`
}

export function EvalBar({
  evaluation,
  orientation = 'white',
  available = true,
  className
}: EvalBarProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!available) return null

  const white = whiteWinPercent(evaluation)
  const label = evalLabel(evaluation)
  const side = describe(evaluation, t)
  const flipped = orientation === 'black'
  // Keep the text out of the filled part: it goes to whichever end has room for it.
  const labelAtTop = flipped ? white >= 50 : white < 50

  return (
    <div
      className={cx(styles.bar, flipped && styles.flipped, className)}
      role="img"
      aria-label={t('board.evalAria', { value: `${label} (${side})` })}
      title={`${t('board.evalTitle')}: ${label}`}
    >
      <div className={styles.fill} style={{ height: `${white}%` }} />
      <span className={cx(styles.value, labelAtTop ? styles.valueTop : styles.valueBottom, 'mono')}>
        {label}
      </span>
    </div>
  )
}

function describe(evaluation: Eval | null | undefined, t: (key: string) => string): string {
  if (!evaluation) return t('board.evalWaiting')
  if (typeof evaluation.mate === 'number' && evaluation.mate !== 0) {
    return evaluation.mate > 0 ? t('board.evalMateWhite') : t('board.evalMateBlack')
  }
  const cp = typeof evaluation.cp === 'number' ? evaluation.cp : 0
  if (Math.abs(cp) < 30) return t('board.evalEven')
  return cp > 0 ? t('board.evalWhite') : t('board.evalBlack')
}
