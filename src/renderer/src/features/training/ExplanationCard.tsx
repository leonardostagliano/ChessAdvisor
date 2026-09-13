import { useTranslation } from 'react-i18next'
import { cx } from '../../components/ui/cx'
import styles from './Training.module.css'

/**
 * The coach's prose in the training section (spec §6.4, §6.6): the explanation of an exercise and
 * the mini-lesson of an opening are the same card.
 *
 * It is an `aria-live` region because the text arrives a chunk at a time: a screen reader has to
 * be told politely that something is being written, exactly as the coach cards of the game do.
 * With nothing to say the card is not rendered at all — an empty box would be a promise the
 * section cannot keep.
 */

export interface ExplanationCardProps {
  /** Text written so far; empty while the turn has been announced but has not streamed yet. */
  text: string
  /** The text is still arriving. */
  streaming?: boolean
  /** Eyebrow above the prose; defaults to the coach's name. */
  title?: string
  className?: string
}

export function ExplanationCard({
  text,
  streaming = false,
  title,
  className
}: ExplanationCardProps): React.JSX.Element | null {
  const { t } = useTranslation()
  if (text.length === 0 && !streaming) return null

  return (
    <article
      className={cx(styles.explanation, className)}
      aria-live="polite"
      data-testid="explanation-card"
    >
      <header className={styles.explanationHead}>{title ?? t('coach.name')}</header>
      <p className={cx(styles.prose, 'selectable')}>
        {text.length > 0 ? text : t('coach.writing')}
        {streaming ? <span className={styles.caret} aria-hidden="true" /> : null}
      </p>
    </article>
  )
}
