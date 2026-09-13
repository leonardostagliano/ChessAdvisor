import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { EmptyState } from '../../components/EmptyState'
import { initProfileStore, useProfileStore } from '../../stores/profileStore'
import { useUiStore } from '../../stores/uiStore'
import { AccuracyTrend } from './AccuracyTrend'
import { ClassificationBars } from './ClassificationBars'
import { LevelCard } from './LevelCard'
import { OpeningsTable } from './OpeningsTable'
import { WeakThemes } from './WeakThemes'
import styles from './Progress.module.css'

/**
 * "Progressi" (spec §6.9): everything the app has learned about the player, from the level and its
 * confidence down to the openings table.
 *
 * The screen is a pure function of the profile: the main process writes it when a match is
 * analysed and pushes `profile:changed`, and the only thing the user can start from here is a new
 * qualitative assessment. Until the first analysed match there is nothing honest to draw, so the
 * guided empty state of M0 stays — with the difference that the button now takes the user to the
 * board instead of being disabled.
 *
 * The study plan of spec §6.8 belongs to M5 and is deliberately absent: a placeholder for work
 * that does not exist yet would be a promise the app cannot keep.
 */

export function ProgressScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const setArea = useUiStore((state) => state.setArea)
  const profile = useProfileStore((state) => state.profile)
  const loading = useProfileStore((state) => state.loading)
  const refreshing = useProfileStore((state) => state.refreshing)
  const error = useProfileStore((state) => state.error)
  const distribution = useProfileStore((state) => state.distribution)

  // The screen owns the subscription: nothing else in the renderer reads the profile yet.
  useEffect(() => initProfileStore(), [])

  const analysed = (profile?.history.length ?? 0) > 0

  if (!analysed) {
    return (
      <div className={styles.screen}>
        <header className={styles.header}>
          <p className="eyebrow">{t('rail.progress')}</p>
          <h1 className={styles.title}>{t('empty.progress.title')}</h1>
        </header>
        <EmptyState
          title={t('empty.progress.title')}
          body={t('empty.progress.body')}
          action={t('progress.goToPlay')}
          disabled={loading}
          onAction={() => setArea('play')}
          note={t('empty.note')}
        />
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>
    )
  }

  const level = profile!.level

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <p className="eyebrow">{t('rail.progress')}</p>
        <h1 className={styles.title}>{t('progress.title')}</h1>
        <p className={styles.subtitle}>{t('progress.subtitle')}</p>
      </header>

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.grid}>
        <LevelCard
          className={styles.wide}
          level={level}
          qualitative={profile!.qualitative ?? null}
          busy={refreshing}
          onRefresh={() => void useProfileStore.getState().refreshQualitative()}
        />
        <AccuracyTrend className={styles.wide} history={profile!.history} />
        <ClassificationBars distribution={distribution} />
        <WeakThemes themeStats={profile!.themeStats} />
        <OpeningsTable className={styles.wide} openings={profile!.openingStats} />
      </div>
    </div>
  )
}
