import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { Exercise } from '@shared/types/training'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/EmptyState'
import { cx } from '../../components/ui/cx'
import { exercisesOfKind, useTrainingStore } from '../../stores/trainingStore'
import { useUiStore } from '../../stores/uiStore'
import { ExercisePlayer } from './ExercisePlayer'
import styles from './Training.module.css'

/**
 * "Dalle tue partite" (spec §6.4): the mistakes the engine found in the games the user had
 * analysed, turned into positions to play again.
 *
 * Nothing is generated here — the exercises are built by the main process after every analysis —
 * so until the first analysed match with a mistake in it the tab says so plainly and points at
 * the board, which is the only way to make more of them.
 */

export function OwnGamesTab(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const exercises = useTrainingStore((state) => state.exercises)
  const selected = useTrainingStore((state) => state.selectedExercise)
  const setArea = useUiStore((state) => state.setArea)
  const own = exercisesOfKind(exercises, 'own_game')
  const current: Exercise | null =
    own.find((exercise) => exercise.id === selected) ?? own[0] ?? null
  const sourceGameId = current?.sourceGameId ?? null
  const sourcePly = current?.sourcePly ?? null

  // The list is rebuilt whenever an analysis finishes: keep a selection that still exists.
  useEffect(() => {
    if (current && current.id !== selected) useTrainingStore.getState().selectExercise(current.id)
  }, [current, selected])

  if (own.length === 0) {
    return (
      <EmptyState
        eyebrow={t('training.own.title')}
        title={t('training.own.emptyTitle')}
        body={t('training.own.emptyBody')}
        action={t('training.own.emptyAction')}
        onAction={() => setArea('play')}
      />
    )
  }

  return (
    <div className={styles.split}>
      <section className={styles.card} aria-label={t('training.own.title')}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('training.own.title')}</h2>
        </div>
        <p className={styles.note}>{t('training.own.hint')}</p>
        {current ? (
          <ExercisePlayer exercise={current}>
            {sourceGameId ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => useUiStore.getState().openReview(sourceGameId, sourcePly)}
              >
                {t('training.own.openReview')}
              </Button>
            ) : null}
          </ExercisePlayer>
        ) : (
          <p className={styles.note}>{t('training.exercise.none')}</p>
        )}
      </section>

      <section className={styles.card} aria-label={t('training.own.listLabel')}>
        <h3 className={styles.cardTitle}>{t('training.own.listLabel')}</h3>
        <ul className={styles.list} data-testid="own-exercises">
          {own.map((exercise) => (
            <li key={exercise.id}>
              <button
                type="button"
                className={cx(styles.rowButton, exercise.id === current?.id && styles.rowActive)}
                aria-pressed={exercise.id === current?.id}
                data-exercise={exercise.id}
                data-status={exercise.status}
                onClick={() => useTrainingStore.getState().selectExercise(exercise.id)}
              >
                <span className={styles.rowTitle}>
                  {t(`themes.${exercise.theme}`, { defaultValue: exercise.theme })}
                </span>
                <span className={styles.rowMeta}>
                  <span>
                    {t('training.own.source', {
                      date: new Date(exercise.createdAt).toLocaleDateString(i18n.language)
                    })}
                  </span>
                  {typeof exercise.sourcePly === 'number' ? (
                    <span>{t('training.own.ply', { ply: exercise.sourcePly })}</span>
                  ) : null}
                  <span
                    className={cx(
                      styles.chip,
                      exercise.status === 'solved' && styles.chipSolved,
                      exercise.status === 'failed' && styles.chipFailed
                    )}
                  >
                    {t(`training.status.${exercise.status}`)}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
