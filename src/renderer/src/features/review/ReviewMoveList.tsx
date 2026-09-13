import { useEffect, useRef, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { Chess } from 'chess.js'
import { normalizeMove } from '@shared/chess/notation'
import type { Game, Move, MoveClassification } from '@shared/types/game'
import { cx } from '../../components/ui/cx'
import { moveNumber, moverColor } from '../play/MoveList'
import styles from './Review.module.css'

/**
 * The move list of the review (spec §4.4): the same pairing as the one in game, plus the judgement
 * of every ply and keyboard navigation with ← and →.
 *
 * The judgement is never colour alone (spec §7): each badge is a conventional annotation symbol
 * with the full word as its accessible name.
 */

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'

/** Symbol shown next to a move for each classification of the pipeline (spec §3.1, rule 5). */
export const CLASSIFICATION_MARKS: Record<MoveClassification, string> = {
  book: '≡',
  best: '★',
  excellent: '!',
  good: '·',
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??'
}

/** Position the ply at `index` (0-based) was played from. */
export function fenBeforeOf(game: Game | null | undefined, index: number): string {
  const previous = game?.moves[index - 1]
  return previous ? previous.fenAfter : (game?.startFen ?? START_FEN)
}

/**
 * A UCI line rendered in SAN from `fen`. A tail that no longer applies (the engine line is longer
 * than the position allows, or the game left the book) is simply dropped.
 */
export function lineInSan(fen: string, uci: string[], max = 6): string[] {
  let chess: Chess
  try {
    chess = new Chess(fen)
  } catch {
    return []
  }
  const san: string[] = []
  for (const step of uci.slice(0, max)) {
    const normalized = normalizeMove(chess.fen(), step)
    if (!normalized) break
    try {
      san.push(chess.move(normalized.san).san)
    } catch {
      break
    }
  }
  return san
}

/** `1. e4 e5 2. Nf3` from a list of SAN moves played from `fen`. */
export function numberedLine(fen: string, san: string[]): string {
  const fields = fen.split(/\s+/)
  const blackToMove = fields[1] === 'b'
  const start = Number(fields[5])
  let number = Number.isFinite(start) && start > 0 ? start : 1
  const parts: string[] = []
  san.forEach((step, index) => {
    const isBlack = blackToMove ? index % 2 === 0 : index % 2 === 1
    if (!isBlack) parts.push(`${number}.`)
    else if (index === 0) parts.push(`${number}...`)
    parts.push(step)
    if (isBlack) number += 1
  })
  return parts.join(' ')
}

export interface ReviewMoveListProps {
  moves: Move[]
  /** Ply on the board: `-1` is the starting position, then the index of the played ply. */
  cursor: number
  onSelect(cursor: number): void
}

interface Row {
  number: number
  white?: { index: number; move: Move }
  black?: { index: number; move: Move }
}

function rowsOf(moves: Move[]): Row[] {
  const rows: Row[] = []
  moves.forEach((move, index) => {
    const number = moveNumber(move)
    const colour = moverColor(move)
    let row = rows[rows.length - 1]
    if (!row || row.number !== number || (colour === 'w' ? row.white : row.black)) {
      row = { number }
      rows.push(row)
    }
    if (colour === 'w') row.white = { index, move }
    else row.black = { index, move }
  })
  return rows
}

export function ReviewMoveList({
  moves,
  cursor,
  onSelect
}: ReviewMoveListProps): React.JSX.Element {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  const rows = rowsOf(moves)

  // Keep the selected move in view while the arrows walk the game.
  useEffect(() => {
    const node = listRef.current?.querySelector('[aria-current="true"]')
    // `scrollIntoView` is missing in jsdom and in any environment without a layout engine.
    if (node instanceof HTMLElement && typeof node.scrollIntoView === 'function')
      node.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const last = moves.length - 1
    if (event.key === 'ArrowLeft') onSelect(Math.max(-1, cursor - 1))
    else if (event.key === 'ArrowRight') onSelect(Math.min(last, cursor + 1))
    else if (event.key === 'Home') onSelect(-1)
    else if (event.key === 'End') onSelect(last)
    else return
    event.preventDefault()
  }

  if (moves.length === 0) {
    return <p className={styles.note}>{t('play.noMoves')}</p>
  }

  return (
    <div
      className={styles.moveList}
      ref={listRef}
      role="group"
      tabIndex={0}
      aria-label={t('review.moveListAria')}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        aria-current={cursor === -1 ? 'true' : undefined}
        className={cx(styles.moveStart, cursor === -1 && styles.moveSelected)}
        onClick={() => onSelect(-1)}
      >
        {t('play.startPosition')}
      </button>
      <ol className={styles.moveRows}>
        {rows.map((row) => (
          <li key={row.number} className={styles.moveRow}>
            <span className={cx(styles.moveNumber, 'mono')}>{row.number}.</span>
            {(['white', 'black'] as const).map((side) => {
              const entry = row[side]
              if (!entry) return <span key={side} className={styles.moveEmpty} aria-hidden="true" />
              const { index, move } = entry
              const classification = move.eval?.classification
              return (
                <button
                  key={side}
                  type="button"
                  aria-current={index === cursor ? 'true' : undefined}
                  className={cx(styles.move, index === cursor && styles.moveSelected)}
                  onClick={() => onSelect(index)}
                >
                  <span className="mono">{move.san}</span>
                  {classification ? (
                    <span
                      className={cx(styles.mark, styles[`mark_${classification}` as const])}
                      title={t(`review.classification.${classification}`)}
                      aria-label={t(`review.classification.${classification}`)}
                    >
                      {CLASSIFICATION_MARKS[classification]}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </li>
        ))}
      </ol>
    </div>
  )
}
