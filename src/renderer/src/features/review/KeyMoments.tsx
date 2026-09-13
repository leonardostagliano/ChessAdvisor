import { useTranslation } from 'react-i18next'
import type { Game } from '@shared/types/game'
import { cx } from '../../components/ui/cx'
import { fenBeforeOf, lineInSan } from './ReviewMoveList'
import styles from './Review.module.css'

/**
 * The key moments of the game (spec §3.1 rule 8, §4.4): the user's own mistakes and blunders, each
 * with the move played, the move the engine preferred and how much winning chance it cost.
 *
 * Clicking one takes the board there; "Commenta i momenti chiave", in the header of the review,
 * asks the coach for one comment per moment (at most eight, as the main process enforces) and the
 * commented ones say so.
 */

export interface KeyMomentsProps {
  game: Game
  /** Ply on the board: `-1` is the starting position, then the index of the played ply. */
  cursor: number
  onSelect(cursor: number): void
  /** False while the analysis has not run: there is nothing to list yet. */
  analysed?: boolean
}

export function KeyMoments({
  game,
  cursor,
  onSelect,
  analysed = true
}: KeyMomentsProps): React.JSX.Element {
  const { t } = useTranslation()
  const plies = game.analysis?.keyMoments ?? []
  const moments = plies
    .map((ply) => {
      const index = game.moves.findIndex((move) => move.ply === ply)
      return index < 0 ? null : { index, move: game.moves[index]! }
    })
    .filter((entry): entry is { index: number; move: Game['moves'][number] } => entry !== null)

  return (
    <section className={styles.card} aria-label={t('review.keyMoments')}>
      <header className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{t('review.keyMoments')}</h3>
        <span className={styles.note}>
          {t('review.keyMomentsCount', { count: moments.length })}
        </span>
      </header>

      {!analysed ? (
        <p className={styles.note}>{t('review.keyMomentsPending')}</p>
      ) : moments.length === 0 ? (
        <p className={styles.note}>{t('review.keyMomentsEmpty')}</p>
      ) : (
        <ul className={styles.moments}>
          {moments.map(({ index, move }) => {
            const evaluation = move.eval
            const best = evaluation
              ? (lineInSan(fenBeforeOf(game, index), [evaluation.bestMove], 1)[0] ??
                evaluation.bestMove)
              : ''
            return (
              <li key={move.ply}>
                <button
                  type="button"
                  className={cx(styles.moment, index === cursor && styles.momentSelected)}
                  aria-current={index === cursor ? 'true' : undefined}
                  onClick={() => onSelect(index)}
                >
                  <span className={styles.momentTexts}>
                    <span className={styles.momentTitle}>
                      <span className="mono">{`${move.ply}. ${move.san}`}</span>
                      {best ? (
                        <span className={styles.momentMeta}>
                          {t('review.insteadOf', { move: best })}
                        </span>
                      ) : null}
                    </span>
                    <span className={styles.momentMeta}>
                      {evaluation ? (
                        <span>
                          {t('review.loss', { value: evaluation.winPercentLoss.toFixed(1) })}
                        </span>
                      ) : null}
                      {move.coachComment ? <span>{t('review.commented')}</span> : null}
                    </span>
                  </span>
                  {evaluation ? (
                    <span
                      className={cx(
                        styles.chip,
                        styles[`mark_${evaluation.classification}` as const]
                      )}
                    >
                      {t(`review.classification.${evaluation.classification}`)}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
