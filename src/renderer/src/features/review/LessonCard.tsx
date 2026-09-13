import { useTranslation } from 'react-i18next'
import type { ReviewLesson } from '@shared/types/api'
import { Button } from '../../components/ui/Button'
import { cx } from '../../components/ui/cx'
import { useUiStore } from '../../stores/uiStore'
import styles from './Review.module.css'

/**
 * "Lezione della partita" (spec §4.4): three takeaways and a summary, asked with an `outputSchema`
 * and clamped to three by the main process.
 *
 * A lesson keeps the language it was written in (spec §4.3): when the UI language has changed
 * since, the card says so and offers to ask for it again in the language on screen.
 */

export interface LessonCardProps {
  lesson?: ReviewLesson | null
  /** True while the lesson turn is running. */
  busy?: boolean
  onGenerate(): void
}

export function LessonCard({
  lesson,
  busy = false,
  onGenerate
}: LessonCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const language = useUiStore((state) => state.language)
  const foreign = !!lesson && lesson.language !== language
  const languageName = t(language === 'it' ? 'settings.languageIt' : 'settings.languageEn')

  return (
    <section className={styles.card} aria-label={t('review.lesson')}>
      <header className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{t('review.lesson')}</h3>
        <div className={styles.actions}>
          {foreign ? (
            <span className={styles.badge}>
              {t('coach.languageBadge', {
                language: t(
                  lesson.language === 'it' ? 'settings.languageIt' : 'settings.languageEn'
                )
              })}
            </span>
          ) : null}
          {/* The lesson is asked for from the header; here the button only asks for it again,
              which is what a lesson written in another language needs (spec §4.3). */}
          {lesson ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onGenerate}>
              {busy
                ? t('review.lessonWriting')
                : t('review.regenerate', { language: languageName })}
            </Button>
          ) : null}
        </div>
      </header>

      {!lesson ? (
        <p className={styles.note}>{t('review.lessonEmpty')}</p>
      ) : (
        <>
          <ol className={styles.takeaways}>
            {lesson.takeaways.map((takeaway, index) => (
              <li key={`${index}-${takeaway.slice(0, 12)}`} className={styles.takeaway}>
                <span className={styles.takeawayIndex} aria-hidden="true">{`${index + 1}.`}</span>
                <span className="selectable">{takeaway}</span>
              </li>
            ))}
          </ol>
          {lesson.summary ? (
            <p className={cx(styles.summary, 'selectable')}>{lesson.summary}</p>
          ) : null}
        </>
      )}
    </section>
  )
}
