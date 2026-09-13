import { useTranslation } from 'react-i18next'
import type { Game, GameResult } from '@shared/types/game'
import { Button } from '../../components/ui/Button'
import { cx } from '../../components/ui/cx'
import styles from './PlayScreen.module.css'

/**
 * The end of a game (spec §4.3): the outcome from the user's point of view, the way into the
 * post-game review (spec §4.4) and the way into the next game.
 */

export interface ResultBannerProps {
  game: Game
  onNewGame(): void
  /** Opens the review of this game; absent only where there is nowhere to open it. */
  onReview?(): void
}

export type ResultTone = 'win' | 'loss' | 'draw'

/** Outcome seen from the user's colour. */
export function resultTone(result: GameResult, userColor: 'w' | 'b'): ResultTone {
  if (result.outcome === '1/2-1/2') return 'draw'
  const winner = result.outcome === '1-0' ? 'w' : 'b'
  return winner === userColor ? 'win' : 'loss'
}

export function ResultBanner({
  game,
  onNewGame,
  onReview
}: ResultBannerProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (!game.result) return null

  const tone = resultTone(game.result, game.userColor)

  return (
    <section
      className={cx(styles.result, styles[`result_${tone}` as const])}
      role="status"
      aria-live="polite"
    >
      <div>
        <p className="eyebrow">{t('result.title')}</p>
        <h2 className={styles.resultTitle}>
          {`${t(`result.${tone}`)} ${t(`result.reason.${game.result.reason}`)}`}
        </h2>
        <p className={cx(styles.resultScore, 'mono')}>{game.result.outcome}</p>
      </div>
      <div className={styles.resultActions}>
        {onReview ? (
          <Button variant="primary" onClick={onReview}>
            {t('review.open')}
          </Button>
        ) : null}
        <Button variant={onReview ? 'secondary' : 'primary'} onClick={onNewGame}>
          {t('controls.newGame')}
        </Button>
      </div>
    </section>
  )
}
