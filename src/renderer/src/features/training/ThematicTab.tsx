import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/EmptyState'
import { cx } from '../../components/ui/cx'
import { solvedCount, useTrainingStore } from '../../stores/trainingStore'
import { ExercisePlayer } from './ExercisePlayer'
import styles from './Training.module.css'

/**
 * "Tattica" (spec §6.5): a set of ten puzzles on one theme, chosen by the coach from the profile
 * and drawn from the bundled lichess database.
 *
 * The set lives as long as the window: it is a session of training, not a saved object, and only
 * the exercises inside it are persisted (they carry their own status). Solving one offers the
 * next; the user can also walk the set with the two arrows, because skipping a puzzle that does
 * not click is part of training too.
 */

export function ThematicTab(): React.JSX.Element {
  const { t } = useTranslation()
  const set = useTrainingStore((state) => state.thematic)
  const exercises = useTrainingStore((state) => state.exercises)
  const requests = useTrainingStore((state) => state.requests)
  const [index, setIndex] = useState(0)
  const drawing = requests.some((request) => request.kind === 'thematic')

  // A new set always starts from its first puzzle.
  useEffect(() => {
    setIndex(0)
  }, [set])

  const newSet = (
    <Button
      variant="primary"
      disabled={drawing}
      onClick={() => void useTrainingStore.getState().nextThematic()}
    >
      {drawing ? t('training.thematic.drawing') : t('training.thematic.newSet')}
    </Button>
  )

  if (!set) {
    return (
      <EmptyState
        eyebrow={t('training.thematic.title')}
        title={t('training.thematic.emptyTitle')}
        body={t('training.thematic.emptyBody')}
      >
        <div className={styles.actions}>{newSet}</div>
      </EmptyState>
    )
  }

  const total = set.exercises.length
  // The set holds the exercises as they were when it was drawn; their status changes underneath.
  const stored = new Map(exercises.map((exercise) => [exercise.id, exercise]))
  const current = set.exercises[Math.min(index, Math.max(0, total - 1))] ?? null
  const exercise = current ? (stored.get(current.id) ?? current) : null
  const solved = solvedCount(exercises, set)

  return (
    <div className={styles.panel}>
      <section
        className={styles.card}
        aria-label={t('training.thematic.setLabel')}
        data-testid="thematic-set"
      >
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>
            {t(`themes.${set.theme}`, { defaultValue: set.theme })}
          </h2>
          <div className={styles.actions}>{newSet}</div>
        </div>
        <div className={styles.chips}>
          <span className={cx(styles.chip, 'mono')}>
            {t('training.thematic.range', { min: set.ratingMin, max: set.ratingMax })}
          </span>
          <span className={styles.chip} data-testid="thematic-solved">
            {t('training.thematic.solvedCount', { solved, total })}
          </span>
        </div>
        <p className={styles.prose}>{set.motivation}</p>
        {set.fallback ? <p className={styles.note}>{t('training.thematic.fallback')}</p> : null}
      </section>

      {exercise ? (
        <section className={styles.card} aria-label={t('training.thematic.title')}>
          <ExercisePlayer
            exercise={exercise}
            position={{ index: Math.min(index, total - 1) + 1, total }}
          >
            <Button
              size="sm"
              disabled={index <= 0}
              onClick={() => setIndex((value) => Math.max(0, value - 1))}
            >
              {t('training.exercise.previous')}
            </Button>
            <Button
              size="sm"
              disabled={index >= total - 1}
              onClick={() => setIndex((value) => Math.min(total - 1, value + 1))}
            >
              {t('training.exercise.next')}
            </Button>
          </ExercisePlayer>
        </section>
      ) : (
        <p className={styles.note}>{t('training.thematic.empty')}</p>
      )}
    </div>
  )
}
