import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/EmptyState'
import { cx } from '../../components/ui/cx'
import { useTrainingStore } from '../../stores/trainingStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './Training.module.css'

/**
 * "Finali" (spec §6.7): the curated endgames of `endgames.json`, each with the goal the user has
 * to reach and the state of their attempts at it.
 *
 * "Gioca" is not an exercise: it starts a real game from the position against the opponent at the
 * highest level, so the tab hands the user over to the board as soon as the session is up.
 */

export function EndgamesTab(): React.JSX.Element {
  const { t } = useTranslation()
  const language = useUiStore((state) => state.language)
  const endgames = useTrainingStore((state) => state.endgames)
  const request = useTrainingStore((state) => state.request)
  const loading = useTrainingStore((state) => state.loading)

  // The catalogue ships with the app: an empty list means the dataset could not be read.
  if (endgames.length === 0) {
    return (
      <EmptyState
        eyebrow={t('training.endgames.title')}
        title={t('training.endgames.emptyTitle')}
        body={t('training.endgames.emptyBody')}
        action={t('training.endgames.reload')}
        disabled={loading}
        onAction={() => void useTrainingStore.getState().load()}
      />
    )
  }

  return (
    <section className={styles.card} aria-label={t('training.endgames.listLabel')}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{t('training.endgames.title')}</h2>
        <p className={styles.note}>{t('training.endgames.hint')}</p>
      </div>

      <ul className={styles.grid} data-testid="endgames">
        {endgames.map((endgame) => {
          const starting = request?.kind === 'endgame' && request.ref === endgame.id
          const gameId = endgame.gameId
          return (
            <li key={endgame.id} className={styles.card} data-endgame={endgame.id} data-status={endgame.status}>
              <h3 className={styles.rowTitle}>{endgame.name[language]}</h3>
              <div className={styles.chips}>
                <span className={styles.chip}>{t(`training.endgames.goal.${endgame.goal}`)}</span>
                <span className={styles.chip}>{t(`training.endgames.difficulty.${endgame.difficulty}`)}</span>
                <span className={styles.chip}>{t(`themes.${endgame.theme}`, { defaultValue: endgame.theme })}</span>
                <span
                  className={cx(
                    styles.chip,
                    endgame.status === 'solved' && styles.chipSolved,
                    endgame.status === 'failed' && styles.chipFailed
                  )}
                >
                  {t(`training.status.${endgame.status}`)}
                </span>
                {endgame.attempts > 0 ? <span className={styles.chip}>{t('training.attempts', { count: endgame.attempts })}</span> : null}
              </div>
              <div className={styles.actions}>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={starting}
                  onClick={() => void useTrainingStore.getState().startEndgame(endgame.id)}
                >
                  {starting ? t('training.endgames.starting') : t('training.endgames.play')}
                </Button>
                {gameId ? (
                  <Button size="sm" variant="ghost" onClick={() => useUiStore.getState().openReview(gameId, null)}>
                    {t('training.own.openReview')}
                  </Button>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
