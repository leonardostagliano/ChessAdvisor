import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Chessground } from '@lichess-org/chessground'
import type { Api as ChessgroundApi } from '@lichess-org/chessground/api'
import type { Config } from '@lichess-org/chessground/config'
import type { DrawBrushes } from '@lichess-org/chessground/draw'
import type { Color, Key } from '@lichess-org/chessground/types'
import { legalMoves } from '@shared/chess/notation'
import { cx } from '../components/ui/cx'

import '@lichess-org/chessground/assets/chessground.base.css'
import '@lichess-org/chessground/assets/chessground.cburnett.css'
import './board-theme.css'
import styles from './Board.module.css'

/**
 * One coach arrow. `color` is a chessground brush name; `accent` is ours (spec §4.2: the hint is
 * drawn in the accent colour of the current palette).
 */
export interface BoardArrow {
  from: string
  /** Destination square; leave it out to draw a circle on `from` instead of an arrow. */
  to?: string
  color?: 'green' | 'red' | 'blue' | 'yellow' | 'accent'
}

export type PromotionRole = 'queen' | 'rook' | 'bishop' | 'knight'
export const PROMOTION_ROLES: { role: PromotionRole; letter: 'q' | 'r' | 'b' | 'n' }[] = [
  { role: 'queen', letter: 'q' },
  { role: 'knight', letter: 'n' },
  { role: 'rook', letter: 'r' },
  { role: 'bishop', letter: 'b' }
]

/** True when `orig → dest` is a pawn promotion in `fen` (any promotion piece is legal there). */
export function isPromotion(fen: string, orig: string, dest: string): boolean {
  return legalMoves(fen).some((move) => move.uci.length === 5 && move.uci.startsWith(`${orig}${dest}`))
}

export interface BoardMovable {
  /** Side allowed to move; `undefined` locks the board. */
  color?: 'white' | 'black'
  /** Overrides the destinations derived from `fen` (only the review screen needs this). */
  dests?: Map<string, string[]>
}

export interface BoardProps {
  fen: string
  orientation?: 'white' | 'black'
  lastMove?: [string, string] | null
  movable?: BoardMovable
  onMove?(uci: string): void
  check?: boolean
  arrows?: BoardArrow[]
  /** Browsing a past position: pieces stay put and nothing is draggable. */
  viewOnly?: boolean
  coordinates?: boolean
  /** Accessible name of the board region; defaults to the translated "Chessboard". */
  label?: string
  className?: string
}

/** Spec §4.3: a square is never smaller than 44 px nor larger than 96 px. */
export const MIN_SQUARE_PX = 44
export const MAX_SQUARE_PX = 96
const DEFAULT_SQUARE_PX = 64
const ANIMATION_MS = 200
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'
/** Night accent, used when the palette cannot be read (tests, a detached document). */
const FALLBACK_ACCENT = '#e0a458'

/**
 * The accent of the palette in use, as a plain colour string: chessground writes the brush colour
 * straight into an SVG attribute, where a `var(--accent)` reference would not resolve.
 */
export function accentColor(): string {
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
    return value.length > 0 ? value : FALLBACK_ACCENT
  } catch {
    return FALLBACK_ACCENT
  }
}

/**
 * chessground's four default brushes plus the accent one. The defaults have to be restated because
 * the type demands them, and the colours are chessground's own.
 */
export function arrowBrushes(accent: string): DrawBrushes {
  return {
    green: { key: 'g', color: '#15781B', opacity: 1, lineWidth: 10 },
    red: { key: 'r', color: '#882020', opacity: 1, lineWidth: 10 },
    blue: { key: 'b', color: '#003088', opacity: 1, lineWidth: 10 },
    yellow: { key: 'y', color: '#e68f00', opacity: 1, lineWidth: 10 },
    accent: { key: 'accent', color: accent, opacity: 0.95, lineWidth: 11 }
  }
}

function reducedMotionNow(): boolean {
  try {
    return window.matchMedia?.(REDUCED_MOTION_QUERY).matches ?? false
  } catch {
    return false
  }
}

/**
 * The OS "reduce motion" setting, kept live.
 *
 * chessground slides the pieces from JavaScript (it writes `transform` frame by frame and only
 * looks at `animation.enabled`), so the blanket `transition-duration` override in themes.css
 * cannot reach it: the board has to read the media query itself and turn the animation off.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedMotionNow)

  useEffect(() => {
    let media: MediaQueryList | undefined
    try {
      media = window.matchMedia?.(REDUCED_MOTION_QUERY)
    } catch {
      media = undefined
    }
    if (!media) return
    const onChange = (event: MediaQueryListEvent | MediaQueryList): void => setReduced(event.matches)
    onChange(media)
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange)
      return () => media?.removeEventListener('change', onChange)
    }
    media.addListener(onChange)
    return () => media?.removeListener(onChange)
  }, [])

  return reduced
}

/** Board edge for a container of `width` × `height`, always a multiple of 8 for crisp squares. */
export function boardSizeFor(width: number, height: number): number {
  const candidates = [width, height].filter((value) => Number.isFinite(value) && value > 0)
  const available = candidates.length > 0 ? Math.min(...candidates) : DEFAULT_SQUARE_PX * 8
  const square = Math.min(MAX_SQUARE_PX, Math.max(MIN_SQUARE_PX, Math.floor(available / 8)))
  return square * 8
}

/** Side to move as chessground spells it. */
export function turnColorOf(fen: string): Color {
  return String(fen ?? '').split(/\s+/)[1] === 'b' ? 'black' : 'white'
}

/** Stable fingerprint of everything in a config that changes what chessground shows or allows. */
export function configSignature(config: Config): string {
  const dests = config.movable?.dests
  const destsSig = dests ? [...dests.entries()].map(([from, to]) => `${from}:${to.join('')}`).sort().join('|') : ''
  const shapes = (config.drawable?.autoShapes ?? []).map((s) => `${s.orig}${s.dest ?? ''}${s.brush ?? ''}`).join('|')
  return [
    config.fen,
    config.orientation,
    config.turnColor,
    config.check === true ? 'check' : String(config.check ?? ''),
    config.coordinates,
    config.viewOnly,
    (config.lastMove ?? []).join(''),
    config.movable?.color ?? '',
    destsSig,
    config.animation?.enabled,
    shapes
  ].join('#')
}

/** `from → [to, …]` for every legal move of `fen`; promotions collapse onto their target square. */
export function destsOf(fen: string): Map<Key, Key[]> {
  const dests = new Map<Key, Key[]>()
  for (const move of legalMoves(fen)) {
    const from = move.uci.slice(0, 2) as Key
    const to = move.uci.slice(2, 4) as Key
    const list = dests.get(from)
    if (!list) dests.set(from, [to])
    else if (!list.includes(to)) list.push(to)
  }
  return dests
}

/**
 * UCI of the move chessground just played. For a promotion the letter comes from the picker;
 * without a choice (programmatic callers) the queen is used.
 */
export function uciOf(fen: string, orig: string, dest: string, promotion?: 'q' | 'r' | 'b' | 'n'): string {
  const candidates = legalMoves(fen).filter(
    (move) => move.uci.length === 5 && move.uci.startsWith(`${orig}${dest}`)
  )
  if (candidates.length === 0) return `${orig}${dest}`
  const wanted = `${orig}${dest}${promotion ?? 'q'}`
  return (candidates.find((move) => move.uci === wanted) ?? candidates[0]!).uci
}

export function Board({
  fen,
  orientation = 'white',
  lastMove,
  movable,
  onMove,
  check = false,
  arrows,
  viewOnly = false,
  coordinates = true,
  label,
  className
}: BoardProps): React.JSX.Element {
  const { t } = useTranslation()
  const frameRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<ChessgroundApi | null>(null)
  // Kept in a ref so a new callback identity never rebuilds the chessground instance.
  const moveRef = useRef<{ fen: string; onMove?: (uci: string) => void }>({ fen, onMove })
  useEffect(() => {
    moveRef.current = { fen, onMove }
  }, [fen, onMove])

  const [size, setSize] = useState(DEFAULT_SQUARE_PX * 8)
  const reducedMotion = useReducedMotion()
  // A pawn that reached the last rank and waits for the promotion piece: chessground has already
  // moved it visually; the move is sent (or the board restored) only when the picker closes.
  const [promotion, setPromotion] = useState<{ orig: Key; dest: Key; color: Color } | null>(null)
  const promotionCancelRef = useRef<() => void>(() => {})

  const choosePromotion = (letter: 'q' | 'r' | 'b' | 'n'): void => {
    if (!promotion) return
    const current = moveRef.current
    setPromotion(null)
    current.onMove?.(uciOf(current.fen, promotion.orig, promotion.dest, letter))
  }
  const cancelPromotion = (): void => {
    if (!promotion) return
    setPromotion(null)
    // Put the pawn back: the position never changed in the main process.
    apiRef.current?.set({ fen: moveRef.current.fen, lastMove: lastMove ? [lastMove[0] as Key, lastMove[1] as Key] : [] })
  }
  promotionCancelRef.current = cancelPromotion

  useEffect(() => {
    if (!promotion) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        promotionCancelRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [promotion])

  const config = useMemo<Config>(() => {
    const locked = viewOnly || !movable?.color
    return {
      fen,
      orientation,
      turnColor: turnColorOf(fen),
      check,
      coordinates,
      viewOnly,
      ...(lastMove ? { lastMove: [lastMove[0] as Key, lastMove[1] as Key] } : { lastMove: [] }),
      animation: reducedMotion ? { enabled: false, duration: 0 } : { enabled: true, duration: ANIMATION_MS },
      highlight: { lastMove: true, check: true },
      movable: {
        free: false,
        color: locked ? undefined : movable?.color,
        dests: locked ? new Map<Key, Key[]>() : ((movable?.dests as Map<Key, Key[]> | undefined) ?? destsOf(fen)),
        showDests: true,
        events: {
          after: (orig: Key, dest: Key) => {
            const current = moveRef.current
            if (isPromotion(current.fen, orig, dest)) {
              setPromotion({ orig, dest, color: turnColorOf(current.fen) })
              return
            }
            current.onMove?.(uciOf(current.fen, orig, dest))
          }
        }
      },
      // Premoves would need the main process to accept a move before it is legal: not in M1.
      premovable: { enabled: false },
      draggable: { enabled: !locked, showGhost: true },
      selectable: { enabled: !locked },
      drawable: {
        enabled: false,
        visible: true,
        // Read once per config: a palette change while an arrow is on the board keeps the colour
        // it was drawn with until the next move, which is as long as a hint ever lives.
        brushes: arrowBrushes(accentColor()),
        autoShapes: (arrows ?? []).map((arrow) => ({
          orig: arrow.from as Key,
          ...(arrow.to ? { dest: arrow.to as Key } : {}),
          brush: arrow.color ?? 'green'
        }))
      }
    }
  }, [fen, orientation, lastMove, movable, check, arrows, viewOnly, coordinates, reducedMotion])

  // The config of the very first render, so mounting and updating never disagree.
  const initialConfigRef = useRef(config)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = Chessground(host, initialConfigRef.current)
    apiRef.current = api
    return () => {
      api.destroy()
      apiRef.current = null
    }
  }, [])

  // Only push a new config when something the board renders actually changed: parents re-render on
  // every session tick (live eval, timers) with fresh object references, and a redundant `set()`
  // interrupts the user's click-to-move selection.
  const signatureRef = useRef<string>(configSignature(config))
  useEffect(() => {
    if (initialConfigRef.current === config) return
    const signature = configSignature(config)
    if (signature === signatureRef.current) return
    signatureRef.current = signature
    apiRef.current?.set(config)
  }, [config])

  // Sizing: the board is always square and the square stays inside the 44–96 px band.
  useLayoutEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const measure = (): void => {
      const next = boardSizeFor(frame.clientWidth, frame.clientHeight)
      setSize((current) => (current === next ? current : next))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(frame)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    apiRef.current?.redrawAll()
  }, [size])

  // chessground caches the board's bounding rect and maps pointer positions through it. A layout
  // shift that does not change the board's size (the opponent card growing, a banner appearing)
  // leaves that cache stale, so clicks and drops land on the wrong square. Refresh it in the
  // capture phase, before chessground's own handler reads the position.
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // Unconditional: a redraw of 32 pieces costs a few milliseconds and it is the only way to be
    // sure the very first interaction after mount uses a rect measured after layout.
    const refresh = (): void => {
      apiRef.current?.redrawAll()
    }
    const settle = requestAnimationFrame(() => apiRef.current?.redrawAll())
    host.addEventListener('mousedown', refresh, true)
    host.addEventListener('touchstart', refresh, true)
    return () => {
      cancelAnimationFrame(settle)
      host.removeEventListener('mousedown', refresh, true)
      host.removeEventListener('touchstart', refresh, true)
    }
  }, [])

  // Promotion picker geometry: a column of four squares over the destination file, starting from
  // the promotion rank and running towards the centre of the board (as lichess does).
  const square = size / 8
  const promotionStyle = (() => {
    if (!promotion) return null
    const file = promotion.dest.charCodeAt(0) - 97
    const column = orientation === 'white' ? file : 7 - file
    const fromTop = (orientation === 'white') === (promotion.color === 'white')
    return { left: column * square, top: fromTop ? 0 : size - 4 * square, width: square, height: 4 * square }
  })()

  return (
    <div ref={frameRef} className={cx(styles.frame, className)} role="group" aria-label={label ?? t('board.label')}>
      <div className={styles.stage} style={{ width: size, height: size }}>
        <div ref={hostRef} className={cx('cg-wrap', styles.board)} style={{ width: size, height: size }} />
        {promotion && promotionStyle ? (
          <>
            <button type="button" className={styles.promotionBackdrop} aria-label={t('board.promotion.cancel')} onClick={cancelPromotion} />
            <div className={cx('cg-wrap', styles.promotion)} style={promotionStyle} role="dialog" aria-label={t('board.promotion.title')} data-testid="promotion-picker">
              {PROMOTION_ROLES.map(({ role, letter }, index) => (
                <button
                  key={role}
                  type="button"
                  className={styles.promotionChoice}
                  style={{ width: square, height: square }}
                  aria-label={t(`board.promotion.${role}`)}
                  title={t(`board.promotion.${role}`)}
                  autoFocus={index === 0}
                  onClick={() => choosePromotion(letter)}
                >
                  <piece className={`${promotion.color} ${role}`} />
                </button>
              ))}
            </div>
          </>
        ) : null}
      </div>
    </div>
  )
}
