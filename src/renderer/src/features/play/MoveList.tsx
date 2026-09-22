import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Move } from '@shared/types/game'
import { moveQuality } from './moveQuality'
import { cx } from '../../components/ui/cx'
import styles from './PlayScreen.module.css'

/**
 * Navigable move list (spec §4.3).
 *
 * Selecting a ply only changes what the board shows: the game is never touched, and the caller
 * offers "back to the current position" while a past ply is selected.
 */

export interface MoveListProps {
  moves: Move[]
  showQuality?: boolean
  /** Ply shown on the board; `null` is the live position, `-1` the position before move 1. */
  browsePly: number | null
  onSelect(ply: number | null): void
}

export interface MoveRow {
  number: number
  white?: { ply: number; move: Move }
  black?: { ply: number; move: Move }
}

/** Colour that played `move`, read from the position it produced. */
export function moverColor(move: Move): 'w' | 'b' {
  return move.fenAfter.split(/\s+/)[1] === 'b' ? 'w' : 'b'
}

/** Move number of `move`, from the fullmove counter of the position it produced. */
export function moveNumber(move: Move): number {
  const fullmove = Number(move.fenAfter.split(/\s+/)[5])
  const base = Number.isFinite(fullmove) && fullmove > 0 ? fullmove : 1
  return moverColor(move) === 'w' ? base : base - 1
}

/**
 * Pairs the plies into numbered rows. A game that starts from a set-up FEN with Black to move
 * gets a row whose white half is empty, exactly like a PGN written with `1...`.
 */
export function moveRows(moves: Move[]): MoveRow[] {
  const rows: MoveRow[] = []
  moves.forEach((move, ply) => {
    const number = moveNumber(move)
    const colour = moverColor(move)
    let row = rows[rows.length - 1]
    if (!row || row.number !== number || (colour === 'w' ? row.white : row.black)) {
      row = { number }
      rows.push(row)
    }
    if (colour === 'w') row.white = { ply, move }
    else row.black = { ply, move }
  })
  return rows
}

export function MoveList({
  moves,
  browsePly,
  onSelect,
  showQuality = true
}: MoveListProps): React.JSX.Element {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  const rows = moveRows(moves)
  const livePly = moves.length - 1
  const selected = browsePly ?? livePly

  // A new move always scrolls the list to the bottom, unless the user is browsing the past.
  useEffect(() => {
    if (browsePly !== null) return
    const node = listRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [moves.length, browsePly])

  if (moves.length === 0) {
    return <p className={styles.panelEmpty}>{t('play.noMoves')}</p>
  }

  return (
    <div className={styles.moveList} ref={listRef}>
      <button
        type="button"
        className={cx(styles.moveStart, selected === -1 && styles.moveSelected)}
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
              const { ply, move } = entry
              const quality = showQuality ? moveQuality(move) : null
              const classification = quality?.evaluation.classification
              const qualityLabel = classification
                ? t(`review.classification.${classification}`)
                : null
              const qualityTitle = qualityLabel
                ? quality?.quick
                  ? t('play.qualityQuickTitle', { classification: qualityLabel })
                  : qualityLabel
                : null
              return (
                <button
                  key={side}
                  type="button"
                  aria-current={ply === selected ? 'true' : undefined}
                  className={cx(styles.move, ply === selected && styles.moveSelected)}
                  onClick={() => onSelect(ply === livePly ? null : ply)}
                >
                  <span className="mono">{move.san}</span>
                  {classification && qualityTitle ? (
                    <span
                      className={cx(
                        styles.qualityBadge,
                        styles[`quality_${classification}` as const]
                      )}
                      title={qualityTitle}
                      aria-label={qualityTitle}
                      data-testid="move-quality-badge"
                      data-quality-source={quality?.quick ? 'live' : 'final'}
                    >
                      {classification === 'book'
                        ? '≡'
                        : classification === 'best'
                          ? '★'
                          : classification === 'excellent'
                            ? '!'
                            : classification === 'good'
                              ? '·'
                              : classification === 'inaccuracy'
                                ? '?!'
                                : classification === 'mistake'
                                  ? '?'
                                  : '??'}
                    </span>
                  ) : null}
                  {move.fallback ? (
                    <span
                      className={styles.moveFlag}
                      title={
                        move.fallback === 'engine'
                          ? t('opponent.fallbackEngine')
                          : t('opponent.fallbackRandom')
                      }
                      aria-label={
                        move.fallback === 'engine'
                          ? t('opponent.fallbackEngine')
                          : t('opponent.fallbackRandom')
                      }
                    >
                      {move.fallback === 'engine' ? 'SF' : '??'}
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
