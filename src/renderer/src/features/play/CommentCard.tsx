import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { Language } from '@shared/types/settings'
import type { CoachEvidenceLine, CoachExplanation, Eval, Move } from '@shared/types/game'
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
  move?: (Pick<Move, 'san' | 'by' | 'eval' | 'liveEval'> & Partial<Pick<Move, 'ply'>>) | null
  showQuality?: boolean
  /** Language the text was written in. */
  language?: Language | null
  /** Eyebrow above the prose: the question that was asked, "Coach", "Suggerimento". */
  title?: string | null
  /** The text is still arriving: the card shows a caret and a placeholder while it is empty. */
  streaming?: boolean
  className?: string
  explanation?: CoachExplanation | null
  selected?: boolean
  onSelectMove?: () => void
  selectionLabel?: string
  onPreviewLine?: (line: CoachEvidenceLine, step: number) => void
  onClearPreview?: () => void
}

function formatEvaluation(value: Eval | undefined): string | null {
  if (!value) return null
  if (typeof value.mate === 'number') return `M${value.mate > 0 ? '+' : ''}${value.mate}`
  if (typeof value.cp === 'number') {
    const pawns = value.cp / 100
    return `${pawns > 0 ? '+' : ''}${pawns.toFixed(2)}`
  }
  return null
}

/** The model's structured stream must never appear as JSON in a prose card. */
export function visibleCommentStream(text: string): string {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('`') && !trimmed.startsWith('```json')) return ''
  if (!trimmed.startsWith('{') && !trimmed.startsWith('```json')) return text
  const content = trimmed.startsWith('```json') ? trimmed.slice(7) : trimmed
  try {
    const parsed: unknown = JSON.parse(content.replace(/```\s*$/, ''))
    if (parsed && typeof parsed === 'object') {
      const result = parsed as Record<string, unknown>
      if (typeof result.explanation === 'string') return result.explanation
      if (result.explanation && typeof result.explanation === 'object') {
        const nested = result.explanation as Record<string, unknown>
        if (typeof nested.explanation === 'string') return nested.explanation
        if (typeof nested.headline === 'string') return nested.headline
      }
      if (typeof result.headline === 'string') return result.headline
    }
  } catch {
    // Incomplete JSON is normal while the coach is writing.
  }
  // The headline arrives first in structured comments. Once explanation starts, show its growing
  // prose rather than keeping the already-complete headline on screen until the JSON closes.
  const match = content.match(/"explanation"\s*:\s*"((?:\\.|[^"\\])*)/) ??
    content.match(/"headline"\s*:\s*"((?:\\.|[^"\\])*)/)
  if (!match) return ''
  // Decode only complete escape sequences. A dangling backslash is an in-flight delta.
  const escaped = match[1]!.replace(/\\$/, '')
  try {
    return JSON.parse(`"${escaped}"`) as string
  } catch {
    return escaped.replace(/\\n/g, '\n').replace(/\\"/g, '"')
  }
}

export function CommentCard({
  text,
  move,
  language,
  title,
  showQuality = true,
  streaming = false,
  className,
  explanation,
  selected = false,
  onSelectMove,
  selectionLabel,
  onPreviewLine,
  onClearPreview
}: CommentCardProps): React.JSX.Element {
  const { t } = useTranslation()
  const uiLanguage = useUiStore((state) => state.language)
  const foreign = !!language && language !== uiLanguage
  const streamBody = streaming ? visibleCommentStream(text) : text
  const body = streamBody.length > 0 ? streamBody : streaming ? t('coach.writing') : ''
  const quality = move && showQuality ? moveQuality(move) : null
  const classification = quality?.evaluation.classification
  const classificationLabel = classification ? t(`review.classification.${classification}`) : null
  const qualityTitle = classificationLabel
    ? quality?.quick
      ? t('play.qualityQuickTitle', { classification: classificationLabel })
      : classificationLabel
    : null

  const hintId = useId()
  const answerId = useId()
  const [hintCount, setHintCount] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const reply =
    explanation?.evidence?.lines.find((line) => line.kind === 'reply' && line.moves.length > 0) ??
    (!move
      ? explanation?.evidence?.lines.find((line) => line.kind === 'best' && line.moves.length > 0)
      : undefined)
  const hasStudy = !!explanation?.question && (!!explanation.hints.length || !!reply)
  const canShowEvidence = !!explanation?.evidence?.lines.length && (!hasStudy || !reply || revealed)

  return (
    // While the text streams in, the card is a polite live region: a screen reader is told the
    // coach is writing without being interrupted mid-sentence (task T22 item 4).
    <article
      className={cx(
        styles.card,
        streaming && styles.streaming,
        explanation && styles.lessonCard,
        selected && styles.selected,
        className
      )}
      {...(streaming && !explanation ? { 'aria-live': 'polite' as const, 'aria-busy': true } : {})}
    >
      {move || title || foreign ? (
        <header className={styles.head}>
          {move?.ply && move.ply > 0 ? (
            <span className={styles.moveNumber}>
              {Math.ceil(move.ply / 2)}
              {move.ply % 2 === 0 ? '…' : '.'}
            </span>
          ) : null}
          {move ? (
            onSelectMove ? (
              <button
                type="button"
                className={cx(styles.move, styles.moveButton, 'mono')}
                onClick={onSelectMove}
                aria-pressed={selected}
                aria-label={t('coach.commentPosition', { move: move.san })}
              >
                {move.san}
              </button>
            ) : (
              <span
                className={cx(styles.move, 'mono')}
                title={move.by === 'ai' ? t('opponent.title') : t('play.you')}
              >
                {move.san}
              </span>
            )
          ) : null}
          {move ? (
            <span className={styles.actor}>
              {move.by === 'ai' ? t('opponent.title') : t('play.you')}
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
          {quality ? (
            <span className={styles.qualitySource}>
              {t(quality.quick ? 'coach.evidenceSource.live' : 'coach.evidenceSource.review')}
            </span>
          ) : null}
          {title ? <span className={styles.title}>{title}</span> : null}
          {!move && onSelectMove ? (
            <button
              type="button"
              className={styles.positionButton}
              onClick={onSelectMove}
              aria-pressed={selected}
            >
              {selectionLabel ?? t('coach.viewPosition')}
            </button>
          ) : null}
          {foreign ? (
            <span className={styles.badge}>
              {t('coach.languageBadge', {
                language: t(language === 'it' ? 'settings.languageIt' : 'settings.languageEn')
              })}
            </span>
          ) : null}
        </header>
      ) : null}
      {explanation ? (
        <div className={styles.lessonBody}>
          <h3 className={styles.headline}>{explanation.headline}</h3>
          <p className={cx(styles.text, 'selectable')}>{explanation.explanation}</p>
          {explanation.priority ? (
            <div className={styles.priority}>
              <span className={styles.priorityMark} aria-hidden="true">
                !
              </span>
              <div>
                <span className={styles.sectionLabel}>{t('coach.priority')}</span>
                <p>{explanation.priority}</p>
              </div>
            </div>
          ) : null}
          {hasStudy ? (
            <section className={styles.study} aria-label={t('coach.thinkBeforeAnswer')}>
              <span className={styles.sectionLabel}>{t('coach.thinkBeforeAnswer')}</span>
              <p className={styles.question}>{explanation.question}</p>
              {hintCount > 0 && !revealed ? (
                <div id={hintId} className={styles.hints} aria-live="polite">
                  {explanation.hints.slice(0, hintCount).map((hint, index) => (
                    <p key={index}>{hint}</p>
                  ))}
                </div>
              ) : null}
              {revealed && reply ? (
                <div id={answerId} className={styles.answer}>
                  <span className={styles.sectionLabel}>{t('coach.analysisAnswer')}</span>
                  <span className={styles.answerMove}>{reply.moves[0]!.san}</span>
                </div>
              ) : null}
              <div className={styles.actions}>
                {!revealed && hintCount < explanation.hints.length ? (
                  <button
                    type="button"
                    className={styles.action}
                    aria-controls={hintId}
                    aria-expanded={hintCount > 0}
                    onClick={() => setHintCount((count) => count + 1)}
                  >
                    {t(hintCount === 0 ? 'coach.giveHint' : 'coach.anotherHint')}
                  </button>
                ) : null}
                {reply ? (
                  <button
                    type="button"
                    className={cx(styles.action, styles.mainAction)}
                    aria-controls={answerId}
                    aria-expanded={revealed}
                    onClick={() => setRevealed((value) => !value)}
                  >
                    {t(revealed ? 'coach.hideAnswer' : 'coach.showAnswer')}
                  </button>
                ) : null}
              </div>
            </section>
          ) : null}
          {explanation.takeaway ? (
            <section className={styles.takeaway}>
              <span className={styles.sectionLabel}>{t('coach.takeaway')}</span>
              <p>{explanation.takeaway}</p>
            </section>
          ) : null}
          {explanation.evidence ? (
            <div className={styles.evidenceSource}>
              {t(`coach.evidenceSource.${explanation.evidence.source}`)}
            </div>
          ) : null}
          {canShowEvidence ? (
            <details className={styles.evidence}>
              <summary>{t('coach.analysisDetails')}</summary>
              <p className={styles.perspective}>{t('coach.whitePerspective')}</p>
              {formatEvaluation(explanation.evidence?.evalBefore) ||
              formatEvaluation(explanation.evidence?.evalAfter) ? (
                <p className={styles.evalRow}>
                  {t('coach.evaluation')}:{' '}
                  {[
                    formatEvaluation(explanation.evidence?.evalBefore),
                    formatEvaluation(explanation.evidence?.evalAfter)
                  ]
                    .filter(Boolean)
                    .join(' → ')}
                </p>
              ) : null}
              {explanation.evidence?.lines.map((line, lineIndex) => (
                <div className={styles.line} key={`${line.kind}-${lineIndex}`}>
                  <span className={styles.sectionLabel}>
                    {line.kind === 'best' && lineIndex > 0
                      ? t('coach.alternativeLine', { number: lineIndex + 1 })
                      : t(`coach.evidenceLine.${line.kind}`)}
                  </span>
                  <div className={styles.lineMoves}>
                    {line.moves.map((step, stepIndex) =>
                      onPreviewLine ? (
                        <button
                          type="button"
                          className={styles.sanButton}
                          key={`${step.uci}-${stepIndex}`}
                          onClick={() => {
                            onPreviewLine(line, stepIndex)
                            setPreviewing(true)
                          }}
                          aria-label={t('coach.previewMove', { move: step.san })}
                        >
                          {step.san}
                        </button>
                      ) : (
                        <span className={styles.sanText} key={`${step.uci}-${stepIndex}`}>
                          {step.san}
                        </span>
                      )
                    )}
                    {formatEvaluation(line.evaluation) ? (
                      <span className={styles.lineEval}>{formatEvaluation(line.evaluation)}</span>
                    ) : null}
                  </div>
                </div>
              ))}
              {previewing && onClearPreview ? (
                <button
                  type="button"
                  className={styles.clearPreview}
                  onClick={() => {
                    onClearPreview()
                    setPreviewing(false)
                  }}
                >
                  {t('coach.returnCommentPosition')}
                </button>
              ) : null}
            </details>
          ) : null}
          {streaming ? (
            <div className={styles.streamStatus} role="status">
              <span className={styles.sectionLabel}>{t('coach.refiningComment')}</span>
              {streamBody ? <p className={cx(styles.text, 'selectable')}>{streamBody}</p> : null}
            </div>
          ) : null}
        </div>
      ) : (
        <p className={cx(styles.text, 'selectable')}>
          {body}
          {streaming ? <span className={styles.caret} aria-hidden="true" /> : null}
        </p>
      )}
    </article>
  )
}
