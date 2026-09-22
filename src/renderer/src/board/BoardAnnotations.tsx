import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CoachAnnotation } from '@shared/types/game'
import { cx } from '../components/ui/cx'
import styles from './Board.module.css'

export function squarePosition(
  square: string,
  orientation: 'white' | 'black'
): { x: number; y: number } {
  const file = square.charCodeAt(0) - 97
  const rank = Number(square[1]) - 1
  return orientation === 'white' ? { x: file, y: 7 - rank } : { x: 7 - file, y: rank }
}

/** Numbered anchors keep every involved piece visible; only one sentence covers the board. */
export function BoardAnnotations({
  annotations,
  orientation,
  onHide,
  visible = true
}: {
  annotations: CoachAnnotation[]
  orientation: 'white' | 'black'
  onHide?: () => void
  visible?: boolean
}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [selected, setSelected] = useState(0)
  const activeIndex = Math.min(selected, annotations.length - 1)
  const active = annotations[activeIndex]
  if (!active) return null
  // Keep the controls in one place while paging through the involved pieces.
  const position = squarePosition(annotations[0]!.square, orientation)
  if (!visible) return null
  return (
    <div
      className={styles.annotations}
      role="group"
      aria-label={t('coach.annotationLabels')}
      data-testid="board-annotations"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        event.stopPropagation()
        setSelected(
          Math.max(
            0,
            Math.min(annotations.length - 1, activeIndex + (event.key === 'ArrowRight' ? 1 : -1))
          )
        )
      }}
    >
      {annotations.map((annotation, index) => {
        const point = squarePosition(annotation.square, orientation)
        return (
          <div
            key={`${annotation.square}-${index}`}
            className={cx(
              styles.annotationSquare,
              annotation.kind === 'threat' && styles.annotationThreat,
              index === activeIndex && styles.annotationSelected
            )}
            style={{ left: `${point.x * 12.5}%`, top: `${point.y * 12.5}%` }}
            data-square={annotation.square}
          >
            <button
              type="button"
              className={styles.annotationMarker}
              aria-pressed={index === activeIndex}
              aria-label={`${index + 1}. ${annotation.square}: ${annotation.label}`}
              onClick={() => setSelected(index)}
            >
              {index + 1}
            </button>
          </div>
        )
      })}
      <div
        className={cx(
          styles.annotationCaption,
          position.y >= 4 ? styles.annotationCaptionTop : styles.annotationCaptionBottom
        )}
      >
        <div className={styles.annotationHeading}>
          <strong>{active.square}</strong>
          <span>
            {t('coach.annotationProgress', { current: activeIndex + 1, total: annotations.length })}
          </span>
          {onHide ? (
            <button
              type="button"
              className={styles.annotationClose}
              aria-label={t('coach.hideAnnotations')}
              onClick={onHide}
            >
              ×
            </button>
          ) : null}
        </div>
        <p aria-live="polite">{active.label}</p>
        {annotations.length > 1 ? (
          <div className={styles.annotationActions}>
            <button
              type="button"
              aria-label={t('coach.previousAnnotation')}
              disabled={activeIndex === 0}
              onClick={() => setSelected(activeIndex - 1)}
            >
              <span aria-hidden="true">←</span> {t('coach.annotationPrevious')}
            </button>
            <button
              type="button"
              aria-label={t('coach.nextAnnotation')}
              disabled={activeIndex === annotations.length - 1}
              onClick={() => setSelected(activeIndex + 1)}
            >
              {t('coach.annotationNext')} <span aria-hidden="true">→</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
