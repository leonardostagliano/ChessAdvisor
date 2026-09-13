import { useTranslation } from 'react-i18next'
import type { Language } from '@shared/types/settings'
import { cx } from '../../components/ui/cx'
import { useUiStore } from '../../stores/uiStore'
import styles from './CommentCard.module.css'

/**
 * One thing the coach said (spec §4.2): a comment on a move, an answer to a question, a hint.
 *
 * The text keeps the language it was written in — changing the UI language mid-game only applies
 * from the next turn (spec §4.3) — so a card whose language is no longer the UI one says so with
 * a small badge instead of pretending to be translated.
 */

export interface CommentCardProps {
  text: string
  /** Move the comment is about; absent for an answer or a hint. */
  move?: { san: string; by: 'user' | 'ai' } | null
  /** Language the text was written in. */
  language?: Language | null
  /** Eyebrow above the prose: the question that was asked, "Coach", "Suggerimento". */
  title?: string | null
  /** The text is still arriving: the card shows a caret and a placeholder while it is empty. */
  streaming?: boolean
  className?: string
}

export function CommentCard({
  text,
  move,
  language,
  title,
  streaming = false,
  className
}: CommentCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const uiLanguage = useUiStore((state) => state.language)
  const foreign = !!language && language !== uiLanguage
  const body = text.length > 0 ? text : streaming ? t('coach.writing') : ''

  return (
    <article className={cx(styles.card, streaming && styles.streaming, className)}>
      {move || title || foreign ? (
        <header className={styles.head}>
          {move ? (
            <span className={cx(styles.move, 'mono')} title={move.by === 'ai' ? t('opponent.title') : t('play.you')}>
              {move.san}
            </span>
          ) : null}
          {title ? <span className={styles.title}>{title}</span> : null}
          {foreign ? (
            <span className={styles.badge}>
              {t('coach.languageBadge', {
                language: t(language === 'it' ? 'settings.languageIt' : 'settings.languageEn')
              })}
            </span>
          ) : null}
        </header>
      ) : null}
      <p className={cx(styles.text, 'selectable')}>
        {body}
        {streaming ? <span className={styles.caret} aria-hidden="true" /> : null}
      </p>
    </article>
  )
}
