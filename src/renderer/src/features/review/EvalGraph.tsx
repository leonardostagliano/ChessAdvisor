import { useTranslation } from 'react-i18next'
import type { Eval, Game, Move, MoveClassification } from '@shared/types/game'
import { whiteWinPercent } from '../../board/EvalBar'
import { cx } from '../../components/ui/cx'
import styles from './Review.module.css'

/**
 * Evaluation of the whole game as one inline SVG (spec §4.4): x is the ply, y the winning chance
 * of White, so the curve reads the same way for both colours and a drop is always someone losing
 * ground. No chart library: a polyline, an area, a marker and one dot per key moment.
 *
 * Accessibility (spec §7: never colour alone): every point carries a `<title>` with the move and
 * its judgement in words, the graph itself is labelled, and the key moments are repeated as text
 * in the list beside it. The dots only add colour on top of that.
 */

/** Geometry of the drawing, in user units; the SVG scales uniformly to its container. */
export const GRAPH_WIDTH = 640
export const GRAPH_HEIGHT = 120

export interface EvalPoint {
  /** `0` is the starting position, then one point per played ply. */
  ply: number
  /** Winning chance of White at that position, 0–100. */
  white: number
  /** Move that produced the position; absent for the starting one. */
  move?: Move
  classification?: MoveClassification
  /** One of `Game.analysis.keyMoments`: a mistake or a blunder of the user. */
  key?: boolean
}

/** Colour that played `move`, read from the position it produced. */
function mover(move: Move): 'w' | 'b' {
  return move.fenAfter.split(/\s+/)[1] === 'b' ? 'w' : 'b'
}

/** An evaluation stored from the mover's point of view, turned back into White's. */
export function toWhite(value: Eval | undefined, by: 'w' | 'b'): Eval | undefined {
  if (!value) return undefined
  if (by === 'w') return value
  if (typeof value.mate === 'number') return { mate: -value.mate }
  if (typeof value.cp === 'number') return { cp: -value.cp }
  return value
}

/**
 * One point per position, the starting one included: `moves.length + 1` in total. A ply the
 * analysis has not filled keeps the value of the position before it, so the line never jumps to
 * an invented 50%.
 */
export function evalPoints(game: Game | null | undefined): EvalPoint[] {
  const moves = game?.moves ?? []
  if (moves.length === 0) return []
  const keyMoments = new Set(game?.analysis?.keyMoments ?? [])
  const first = moves[0]!
  let current = whiteWinPercent(toWhite(first.eval?.before, mover(first)))
  const points: EvalPoint[] = [{ ply: 0, white: current }]
  for (const move of moves) {
    const after = toWhite(move.eval?.after, mover(move))
    if (after) current = whiteWinPercent(after)
    points.push({
      ply: move.ply,
      white: current,
      move,
      ...(move.eval ? { classification: move.eval.classification } : {}),
      ...(keyMoments.has(move.ply) ? { key: true } : {})
    })
  }
  return points
}

const x = (index: number, total: number): number => (total <= 1 ? 0 : (index / (total - 1)) * GRAPH_WIDTH)
const y = (white: number): number => GRAPH_HEIGHT - (Math.min(100, Math.max(0, white)) / 100) * GRAPH_HEIGHT

export interface EvalGraphProps {
  game: Game | null
  /** Ply on the board: `-1` is the starting position, then the index of the played ply. */
  cursor: number
  /** Called with the new cursor when a point is clicked. */
  onSelect(cursor: number): void
  className?: string
}

export function EvalGraph({ game, cursor, onSelect, className }: EvalGraphProps): React.JSX.Element | null {
  const { t } = useTranslation()
  const points = evalPoints(game)
  if (points.length === 0) return null

  const total = points.length
  const line = points.map((point, index) => `${x(index, total).toFixed(2)},${y(point.white).toFixed(2)}`).join(' ')
  const area = `0,${GRAPH_HEIGHT} ${line} ${GRAPH_WIDTH},${GRAPH_HEIGHT}`
  const selected = Math.min(Math.max(cursor + 1, 0), total - 1)
  const band = GRAPH_WIDTH / total

  const label = (point: EvalPoint): string =>
    point.move
      ? t('review.pointLabel', {
          ply: point.ply,
          san: point.move.san,
          judgement: point.classification ? t(`review.classification.${point.classification}`) : t('review.noJudgement'),
          percent: Math.round(point.white)
        })
      : t('review.startLabel', { percent: Math.round(point.white) })

  return (
    <svg
      className={cx(styles.graph, className)}
      data-testid="eval-graph"
      viewBox={`0 0 ${GRAPH_WIDTH} ${GRAPH_HEIGHT}`}
      role="img"
      aria-label={t('review.graphAria', { count: points.length - 1 })}
    >
      <rect className={styles.graphGround} x={0} y={0} width={GRAPH_WIDTH} height={GRAPH_HEIGHT} />
      <polygon className={styles.graphArea} points={area} />
      <line className={styles.graphMid} x1={0} y1={GRAPH_HEIGHT / 2} x2={GRAPH_WIDTH} y2={GRAPH_HEIGHT / 2} />
      <polyline className={styles.graphLine} points={line} fill="none" />

      {points.map((point, index) =>
        point.key ? (
          <circle
            key={`key-${point.ply}`}
            className={cx(styles.graphDot, styles[`dot_${point.classification ?? 'good'}` as const])}
            cx={x(index, total)}
            cy={y(point.white)}
            r={5}
            fill="currentColor"
          >
            <title>{label(point)}</title>
          </circle>
        ) : null
      )}

      <line
        className={styles.graphCursor}
        x1={x(selected, total)}
        y1={0}
        x2={x(selected, total)}
        y2={GRAPH_HEIGHT}
      />
      <circle className={styles.graphMarker} cx={x(selected, total)} cy={y(points[selected]!.white)} r={4} />

      {/* One transparent band per point: clicking anywhere over a ply selects it. */}
      {points.map((point, index) => (
        <rect
          key={`hit-${point.ply}-${index}`}
          className={styles.graphHit}
          data-ply={point.ply}
          x={Math.max(0, x(index, total) - band / 2)}
          y={0}
          width={band}
          height={GRAPH_HEIGHT}
          onClick={() => onSelect(index - 1)}
        >
          <title>{label(point)}</title>
        </rect>
      ))}
    </svg>
  )
}
