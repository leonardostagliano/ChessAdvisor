import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/EmptyState'
import { cx } from '../../components/ui/cx'
import { streamingText, useTrainingStore } from '../../stores/trainingStore'
import { useUiStore } from '../../stores/uiStore'
import { ExplanationCard } from './ExplanationCard'
import styles from './Training.module.css'

/**
 * "Aperture" (spec §6.6): the openings the user actually plays, with the deviations from theory
 * they repeat, and a mini-lesson the coach writes on demand.
 *
 * Everything on screen is computed by the main process from the profile and the analysed games;
 * the tab only chooses which row is open and follows the lesson while it streams.
 */

export function OpeningsTab(): React.JSX.Element {
  const { t } = useTranslation()
  const openings = useTrainingStore((state) => state.openings)
  const selected = useTrainingStore((state) => state.selectedOpening)
  const request = useTrainingStore((state) => state.request)
  const lessons = useTrainingStore((state) => state.lessons)
  const entry = openings.find((row) => row.eco === selected) ?? null
  // The plan turn is announced as a lesson with no reference: only a row that is open follows one.
  const streaming = useTrainingStore((state) => (entry ? streamingText(state, 'lesson', entry.eco) : null))

  // The overview is read once per window; `training:changed` never touches it, because it only
  // moves when a game is analysed — and that reopens the section anyway.
  useEffect(() => {
    if (openings.length === 0) void useTrainingStore.getState().loadOpenings()
  }, [openings.length])

  if (openings.length === 0) {
    return (
      <EmptyState
        eyebrow={t('training.openings.title')}
        title={t('training.openings.emptyTitle')}
        body={t('training.openings.emptyBody')}
        action={t('training.openings.emptyAction')}
        onAction={() => useUiStore.getState().setArea('play')}
      />
    )
  }

  const writing = request?.kind === 'lesson' && request.ref === entry?.eco
  const lesson = entry ? (lessons[entry.eco] ?? '') : ''

  return (
    <div className={styles.panel}>
      <section className={styles.card} aria-label={t('training.openings.tableLabel')}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t('training.openings.title')}</h2>
          <p className={styles.note}>{t('training.openings.hint')}</p>
        </div>
        <div className={styles.tableWrap}>
          <table className={styles.table} data-testid="training-openings">
            <thead>
              <tr>
                <th scope="col">{t('training.openings.columnEco')}</th>
                <th scope="col">{t('training.openings.columnName')}</th>
                <th scope="col" className={styles.numeric}>
                  {t('training.openings.columnGames')}
                </th>
                <th scope="col" className={styles.numeric}>
                  {t('training.openings.columnScore')}
                </th>
                <th scope="col" className={styles.numeric}>
                  {t('training.openings.columnAccuracy')}
                </th>
                <th scope="col">{t('training.openings.details')}</th>
              </tr>
            </thead>
            <tbody>
              {openings.map((row) => (
                <tr key={row.eco} data-eco={row.eco} className={cx(row.eco === entry?.eco && styles.rowSelected)}>
                  <td className="mono">{row.eco}</td>
                  <td>{row.name}</td>
                  <td className={styles.numeric}>{row.games}</td>
                  <td className={styles.numeric}>{t('training.openings.percentValue', { value: row.score.toFixed(0) })}</td>
                  <td className={styles.numeric}>{t('training.openings.percentValue', { value: row.avgAccuracyFirst10.toFixed(1) })}</td>
                  <td>
                    <Button
                      size="sm"
                      aria-label={t('training.openings.select', { name: row.name })}
                      aria-pressed={row.eco === entry?.eco}
                      onClick={() => useTrainingStore.getState().selectOpening(row.eco === entry?.eco ? null : row.eco)}
                    >
                      {t('training.openings.details')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {entry ? (
        <section className={styles.card} aria-label={entry.name} data-testid="opening-detail">
          <div className={styles.cardHead}>
            <h3 className={styles.cardTitle}>{`${entry.eco} · ${entry.name}`}</h3>
            <Button
              size="sm"
              variant="primary"
              disabled={writing}
              onClick={() => void useTrainingStore.getState().lesson(entry.eco)}
            >
              {writing ? t('training.openings.lessonBusy') : t('training.openings.lesson')}
            </Button>
          </div>

          <h4 className={styles.note}>{t('training.openings.deviations')}</h4>
          {entry.deviations.length === 0 ? (
            <p className={styles.note}>{t('training.openings.deviationsEmpty')}</p>
          ) : (
            <ul className={styles.deviations}>
              {entry.deviations.map((deviation) => (
                <li key={`${deviation.epd}-${deviation.san}`} className={styles.deviation} data-epd={deviation.epd}>
                  <span className={styles.deviationMove}>{deviation.san}</span>
                  <span>{t('training.openings.deviationCount', { count: deviation.count })}</span>
                  {deviation.bestSan ? <span>{t('training.openings.deviationBest', { san: deviation.bestSan })}</span> : null}
                </li>
              ))}
            </ul>
          )}

          <ExplanationCard text={streaming !== null ? streaming : lesson} streaming={streaming !== null} />
        </section>
      ) : null}
    </div>
  )
}
