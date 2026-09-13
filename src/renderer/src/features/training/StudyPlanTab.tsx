import { useTranslation } from 'react-i18next'
import type { StudyPlanItem, StudyPlanView } from '@shared/types/training'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/EmptyState'
import { cx } from '../../components/ui/cx'
import { useTrainingStore } from '../../stores/trainingStore'
import { useUiStore } from '../../stores/uiStore'
import styles from './Training.module.css'

/**
 * "Piano di studio" (spec §6.8): four to eight activities the coach chose from the catalogue of
 * what this app can actually offer, each with the reason it is there.
 *
 * Two things make the plan honest. An activity whose material is gone is marked and degrades to
 * the generic activity of its type — it is never silently dropped, because the user asked for it
 * and deserves to know. And the app says when the plan is stale (too many games played since, or
 * too many dangling references) instead of quietly regenerating it behind the user's back.
 */

/** Takes the user where an item points; an invalid reference lands on the generic activity. */
export function openStudyItem(item: StudyPlanItem): void {
  const training = useTrainingStore.getState()
  const ref = item.invalidRef ? null : item.activity.ref
  switch (item.activity.type) {
    case 'own_game':
      training.setTab('own')
      if (ref) training.selectExercise(ref)
      return
    case 'thematic':
      training.setTab('thematic')
      return
    case 'opening':
      training.setTab('openings')
      training.selectOpening(ref)
      return
    case 'endgame':
      training.setTab('endgames')
      return
    default:
      useUiStore.getState().setArea('play')
  }
}

/** Items done out of the total, as the progress line of the card reads them. */
export function planProgress(view: StudyPlanView | null): { done: number; total: number } {
  const items = view?.plan?.items ?? []
  return { done: items.filter((item) => item.done).length, total: items.length }
}

export function StudyPlanTab(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const view = useTrainingStore((state) => state.plan)
  const request = useTrainingStore((state) => state.request)
  const generating = request?.kind === 'plan'
  const items = view?.plan?.items ?? []

  const generate = (
    <Button
      variant="primary"
      disabled={generating}
      onClick={() => void useTrainingStore.getState().generatePlan()}
    >
      {generating
        ? t('training.plan.generating')
        : items.length > 0
          ? t('training.plan.regenerate')
          : t('training.plan.generate')}
    </Button>
  )

  if (items.length === 0) {
    return (
      <EmptyState
        eyebrow={t('training.plan.title')}
        title={t('training.plan.emptyTitle')}
        body={t('training.plan.emptyBody')}
      >
        <div className={styles.actions}>{generate}</div>
      </EmptyState>
    )
  }

  const { done, total } = planProgress(view)
  const percent = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <section
      className={styles.card}
      aria-label={t('training.plan.listLabel')}
      data-testid="study-plan"
    >
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{t('training.plan.title')}</h2>
        <div className={styles.actions}>{generate}</div>
      </div>
      <p className={styles.note}>{t('training.plan.hint')}</p>

      <div className={styles.progressRow}>
        <span className={cx(styles.note, 'mono')} data-testid="plan-progress">
          {t('training.plan.progress', { done, total })}
        </span>
        <div
          className={styles.progressTrack}
          role="progressbar"
          aria-label={t('training.plan.progress', { done, total })}
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
        >
          <div className={styles.progressFill} style={{ width: `${percent}%` }} />
        </div>
      </div>

      {view?.plan ? (
        <p className={styles.note}>
          {t('training.plan.generatedAt', {
            date: new Date(view.plan.generatedAt).toLocaleDateString(i18n.language)
          })}
        </p>
      ) : null}

      {view?.suggestRegenerate ? (
        <p className={styles.banner} role="status" data-testid="plan-stale">
          {view.invalidRefs > 2
            ? t('training.plan.staleRefs', { count: view.invalidRefs })
            : t('training.plan.staleGames', { count: view.gamesSincePlan })}
        </p>
      ) : null}

      <ul className={styles.planList}>
        {items.map((item) => (
          <li
            key={item.id}
            className={cx(styles.planItem, item.done && styles.planItemDone)}
            data-item={item.id}
            data-type={item.activity.type}
            data-done={item.done ? 'true' : 'false'}
          >
            <label className={styles.planCheckbox}>
              <input
                type="checkbox"
                checked={item.done}
                onChange={(event) =>
                  void useTrainingStore.getState().markDone(item.id, event.target.checked)
                }
              />
              {t('training.plan.done')}
            </label>
            <div className={styles.planTexts}>
              <span className={styles.planTitle}>{item.title}</span>
              <span className={styles.planWhy}>{item.why}</span>
              <span className={styles.rowMeta}>
                <span className={styles.chip}>
                  {t(`training.plan.activity.${item.activity.type}`)}
                </span>
                {item.invalidRef ? (
                  <span className={styles.note}>{t('training.plan.invalid')}</span>
                ) : null}
              </span>
            </div>
            <Button size="sm" onClick={() => openStudyItem(item)}>
              {t('training.plan.open')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * The same plan, shrunk to a card of the Progressi dashboard (spec §6.9): how far it has got and
 * the first activities still to do, with one way in.
 */
export function StudyPlanSummary({ className }: { className?: string }): React.JSX.Element {
  const { t } = useTranslation()
  const view = useTrainingStore((state) => state.plan)
  const request = useTrainingStore((state) => state.request)
  const generating = request?.kind === 'plan'
  const items = view?.plan?.items ?? []
  const { done, total } = planProgress(view)
  const next = items.filter((item) => !item.done).slice(0, 3)

  const open = (): void => {
    useTrainingStore.getState().setTab('plan')
    useUiStore.getState().setArea('training')
  }

  return (
    <section
      className={cx(styles.card, className)}
      aria-label={t('training.plan.title')}
      data-testid="study-plan-summary"
    >
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{t('training.plan.title')}</h2>
        {total > 0 ? (
          <span className={cx(styles.note, 'mono')}>
            {t('training.plan.progress', { done, total })}
          </span>
        ) : null}
      </div>

      {total === 0 ? (
        <>
          <p className={styles.note}>{t('training.plan.summaryEmpty')}</p>
          <div className={styles.actions}>
            <Button
              variant="primary"
              disabled={generating}
              onClick={() => void useTrainingStore.getState().generatePlan()}
            >
              {generating ? t('training.plan.generating') : t('training.plan.generate')}
            </Button>
          </div>
        </>
      ) : (
        <>
          <ul className={styles.planList}>
            {next.map((item) => (
              <li key={item.id} className={styles.planItem} data-item={item.id}>
                <div className={styles.planTexts}>
                  <span className={styles.planTitle}>{item.title}</span>
                  <span className={styles.planWhy}>{item.why}</span>
                </div>
              </li>
            ))}
          </ul>
          <div className={styles.actions}>
            <Button onClick={open}>{t('training.plan.summaryGo')}</Button>
          </div>
        </>
      )}
    </section>
  )
}
