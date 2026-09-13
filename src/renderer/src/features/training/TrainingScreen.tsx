import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from '../../components/ui/cx'
import { initTrainingStore, TRAINING_TABS, useTrainingStore, type TrainingTab } from '../../stores/trainingStore'
import { EndgamesTab } from './EndgamesTab'
import { OpeningsTab } from './OpeningsTab'
import { OwnGamesTab } from './OwnGamesTab'
import { StudyPlanTab } from './StudyPlanTab'
import { ThematicTab } from './ThematicTab'
import styles from './Training.module.css'

/**
 * "Allenamento" (spec §6.4–§6.8): the five ways of training, one per tab.
 *
 * The screen owns the section's subscription — `training:changed` and the coach's stream — and
 * nothing else: each tab reads what it needs from the store, and the store is a mirror of the
 * files the main process keeps. Which tab is open lives in the store too, so a study-plan item
 * can send the user straight to the material it points at.
 */

const TABS: { id: TrainingTab; key: string }[] = TRAINING_TABS.map((id) => ({ id, key: `training.tab.${id}` }))

export function TrainingScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const tab = useTrainingStore((state) => state.tab)
  const error = useTrainingStore((state) => state.error)

  useEffect(() => initTrainingStore(), [])

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <p className="eyebrow">{t('rail.training')}</p>
        <h1 className={styles.title}>{t('training.title')}</h1>
        <p className={styles.subtitle}>{t('training.subtitle')}</p>
      </header>

      <div className={styles.tabs} role="tablist" aria-label={t('training.areas')}>
        {TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`training-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`training-panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            className={cx(styles.tab, tab === entry.id && styles.tabActive)}
            onClick={() => useTrainingStore.getState().setTab(entry.id)}
          >
            {t(entry.key)}
          </button>
        ))}
      </div>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.panel} role="tabpanel" id={`training-panel-${tab}`} aria-labelledby={`training-tab-${tab}`}>
        {tab === 'own' ? (
          <OwnGamesTab />
        ) : tab === 'thematic' ? (
          <ThematicTab />
        ) : tab === 'openings' ? (
          <OpeningsTab />
        ) : tab === 'endgames' ? (
          <EndgamesTab />
        ) : (
          <StudyPlanTab />
        )}
      </div>
    </div>
  )
}
