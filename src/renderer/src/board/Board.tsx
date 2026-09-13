import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Chessground } from '@lichess-org/chessground'
import type { Api as ChessgroundApi } from '@lichess-org/chessground/api'
import type { Config } from '@lichess-org/chessground/config'
import type { Color, Key } from '@lichess-org/chessground/types'
import { legalMoves } from '@shared/chess/notation'
import { cx } from '../components/ui/cx'

import '@lichess-org/chessground/assets/chessground.base.css'
import '@lichess-org/chessground/assets/chessground.cburnett.css'
import './board-theme.css'
import styles from './Board.module.css'

/** One coach arrow. `color` is a chessground brush name. */
export interface BoardArrow {
  from: string
  to: string
  color?: 'green' | 'red' | 'blue' | 'yellow'
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
 * UCI of the move chessground just played. A promotion is always completed with a queen in M1:
 * the under-promotion picker arrives with the review screen, and a queen is the right guess in
 * far more than 95 % of the games this app is meant for.
 */
export function uciOf(fen: string, orig: string, dest: string): string {
  const promotion = legalMoves(fen).find(
    (move) => move.uci.length === 5 && move.uci.startsWith(`${orig}${dest}`)
  )
  if (!promotion) return `${orig}${dest}`
  const queen = legalMoves(fen).find((move) => move.uci === `${orig}${dest}q`)
  return (queen ?? promotion).uci
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
        autoShapes: (arrows ?? []).map((arrow) => ({
          orig: arrow.from as Key,
          dest: arrow.to as Key,
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

  useEffect(() => {
    if (initialConfigRef.current === config) return
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

  return (
    <div ref={frameRef} className={cx(styles.frame, className)} role="group" aria-label={label ?? t('board.label')}>
      <div ref={hostRef} className={cx('cg-wrap', styles.board)} style={{ width: size, height: size }} />
    </div>
  )
}
