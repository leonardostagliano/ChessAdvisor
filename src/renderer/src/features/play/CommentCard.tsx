import { useTranslation } from 'react-i18next'
import type { Language } from '@shared/types/settings'
import type { Move } from '@shared/types/game'
import { cx } from '../../components/ui/cx'
import { useUiStore } from '../../stores/uiStore'
import styles from './CommentCard.module.css'
import { moveQuality } from './moveQuality'

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
  move?: Pick<Move, 'san' | 'by' | 'eval' | 'liveEval'> | null
  showQuality?: boolean
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
  showQuality = true,
  streaming = false,
  className
}: CommentCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const uiLanguage = useUiStore((state) => state.language)
  const foreign = !!language && language !== uiLanguage
  const body = text.length > 0 ? text : streaming ? t('coach.writing') : ''
  const quality = move && showQuality ? moveQuality(move) : null
  const classification = quality?.evaluation.classification
  const classificationLabel = classification ? t(`review.classification.${classification}`) : null
  const qualityTitle = classificationLabel
    ? quality?.quick
      ? t('play.qualityQuickTitle', { classification: classificationLabel })
      : classificationLabel
    : null

  return (
    // While the text streams in, the card is a polite live region: a screen reader is told the
    // coach is writing without being interrupted mid-sentence (task T22 item 4).
    <article
      className={cx(styles.card, streaming && styles.streaming, className)}
      {...(streaming ? { 'aria-live': 'polite' as const, 'aria-busy': true } : {})}
    >
      {move || title || foreign ? (
        <header className={styles.head}>
          {move ? (
            <span
              className={cx(styles.move, 'mono')}
              title={move.by === 'ai' ? t('opponent.title') : t('play.you')}
            >
              {move.san}
            </span>
          ) : null}
          {classification && qualityTitle ? (
            <span
              className={cx(styles.quality, styles[`quality_${classification}` as const])}
              title={qualityTitle}
              aria-label={qualityTitle}
              data-testid="move-quality-badge"
              data-quality-source={quality?.quick ? 'live' : 'final'}
            >
              {classificationLabel}
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
