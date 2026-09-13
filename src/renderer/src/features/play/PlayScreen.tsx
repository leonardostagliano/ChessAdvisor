import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { gameStatus } from '@shared/chess/notation'
import type { Eval } from '@shared/types/game'
import { Board, type BoardArrow } from '../../board/Board'
import { EvalBar } from '../../board/EvalBar'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/EmptyState'
import { cx } from '../../components/ui/cx'
import { useEngineStore } from '../../stores/engineStore'
import { boardFen, boardLastMove, isBrowsing, startFenOf, useGameStore } from '../../stores/gameStore'
import { ArchiveList } from './ArchiveList'
import { ClockDisplay } from './ClockDisplay'
import { CoachTab } from './CoachTab'
import { CommentsTab } from './CommentsTab'
import { GameControls } from './GameControls'
import { MoveList } from './MoveList'
import { NewGameDialog } from './NewGameDialog'
import { OpponentCard } from './OpponentCard'
import { ResultBanner } from './ResultBanner'
import styles from './PlayScreen.module.css'

/**
 * The play area (spec §4.3): opponent card, board with the eval bar on its left, clocks and
 * captured pieces above and below, and the tabbed panel on the right — Commenti, Mosse, Coach.
 *
 * The archive lives here too, as a second view of the same area, because resuming a game is the
 * other way into the board.
 */

const GLYPHS: Record<string, string> = { p: '♟', n: '♞', b: '♝', r: '♜', q: '♛' }
const VALUES: Record<string, number> = { p: 1, n: 3, b: 3, r: 5, q: 9 }
const ORDER = ['q', 'r', 'b', 'n', 'p']
const PROMOTABLE = ['q', 'r', 'b', 'n']

/** The three tabs of the right-hand panel, in the order spec §4.3 lists them. */
export type PanelTab = 'comments' | 'moves' | 'coach'
const TABS: { id: PanelTab; key: string }[] = [
  { id: 'comments', key: 'play.comments' },
  { id: 'moves', key: 'play.moves' },
  { id: 'coach', key: 'play.coach' }
]

export interface Captured {
  /** Black pieces White has taken, and vice versa; lowercase letters, strongest first. */
  w: string[]
  b: string[]
  /** Material difference from White's point of view, in pawns. */
  balance: number
}

function counts(fen: string): Map<string, number> {
  const board = String(fen ?? '').split(/\s+/)[0] ?? ''
  const map = new Map<string, number>()
  for (const char of board) {
    if (!/[a-zA-Z]/.test(char)) continue
    map.set(char, (map.get(char) ?? 0) + 1)
  }
  return map
}

/**
 * Pieces of one colour that have left the board, promotions netted out: a promotion takes one of
 * that colour's own pawns away and adds a piece of another type, which a plain count diff would
 * otherwise read as a captured pawn (and silently swallow the new piece).
 */
function missingOf(start: Map<string, number>, now: Map<string, number>, white: boolean): string[] {
  const at = (map: Map<string, number>, piece: string): number => map.get(white ? piece.toUpperCase() : piece) ?? 0
  const promoted = PROMOTABLE.reduce((sum, piece) => sum + Math.max(0, at(now, piece) - at(start, piece)), 0)
  return ORDER.flatMap((piece) => {
    const surplus = piece === 'p' ? promoted : 0
    const missing = Math.max(0, at(start, piece) - at(now, piece) - surplus)
    return Array.from({ length: missing }, () => piece)
  })
}

/** What each side has captured, by comparing the current position with the one it started from. */
export function capturedPieces(startFen: string, fen: string): Captured {
  const start = counts(startFen)
  const now = counts(fen)
  const w = missingOf(start, now, false)
  const b = missingOf(start, now, true)
  const value = (pieces: string[]): number => pieces.reduce((sum, piece) => sum + (VALUES[piece] ?? 0), 0)
  return { w, b, balance: value(w) - value(b) }
}

function CapturedRow({ pieces, balance, label }: { pieces: string[]; balance: number; label: string }): React.JSX.Element {
  return (
    <div className={styles.captured} aria-label={label}>
      <span className={styles.capturedPieces} aria-hidden="true">
        {pieces.map((piece, index) => (
          <span key={`${piece}-${index}`}>{GLYPHS[piece] ?? ''}</span>
        ))}
      </span>
      {balance > 0 ? <span className={cx(styles.capturedBalance, 'mono')}>{`+${balance}`}</span> : null}
    </div>
  )
}

export function PlayScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const session = useGameStore((state) => state.session)
  const browsePly = useGameStore((state) => state.browsePly)
  const setBrowsePly = useGameStore((state) => state.setBrowsePly)
  const returnToLive = useGameStore((state) => state.returnToLive)
  const userMove = useGameStore((state) => state.userMove)
  const storeError = useGameStore((state) => state.error)
  const engineAvailable = useEngineStore((state) => state.available)

  const [view, setView] = useState<'game' | 'archive'>('game')
  const [tab, setTab] = useState<PanelTab>('moves')
  const [dialogOpen, setDialogOpen] = useState(false)

  const browsing = isBrowsing({ session, browsePly })
  const fen = boardFen({ session, browsePly })
  const lastMove = boardLastMove({ session, browsePly })
  const game = session.game
  const playing = !!game && session.status === 'playing'
  const userColor = game?.userColor ?? 'w'

  const evaluation: Eval | null = session.liveEval
    ? { ...(session.liveEval.cp !== undefined ? { cp: session.liveEval.cp } : {}), ...(session.liveEval.mate !== undefined ? { mate: session.liveEval.mate } : {}) }
    : null
  const captured = useMemo(() => capturedPieces(startFenOf(game), fen), [game, fen])
  const check = useMemo(() => gameStatus(fen).check, [fen])

  // The hint belongs to the live position: browsing a past ply puts the arrow away until we are
  // back on it, and the main process drops the hint itself as soon as the user moves (spec §4.2).
  const hint = session.coach.hint
  const arrows = useMemo<BoardArrow[]>(
    () => (hint && !browsing ? [{ from: hint.uci.slice(0, 2), to: hint.uci.slice(2, 4), color: 'accent' }] : []),
    [hint, browsing]
  )
  const aiColor: 'w' | 'b' = userColor === 'w' ? 'b' : 'w'
  // "Solo il mio tempo" gives the opponent no clock at all, so there is nothing to draw for it.
  const aiClock = game?.clock?.aiClock === true

  // Browsing asks the engine for the score of the position on screen; going back to the live
  // position asks for that one again, so the bar never keeps a stale number (spec §4.3). The live
  // position needs nothing else: the main process already pushes a fresh `liveEval` after every
  // move and takeback, so echoing each new FEN back through `game:navigateEval` would only queue
  // the same analysis twice.
  const browsedRef = useRef(false)
  useEffect(() => {
    if (!game || !engineAvailable) return
    const live = browsePly === null
    if (live && !browsedRef.current) return
    browsedRef.current = !live
    void useGameStore.getState().navigateEval(fen)
  }, [game, engineAvailable, browsePly, fen])

  const movableColor = playing && session.userToMove && !session.ai.thinking && !browsing ? (userColor === 'w' ? 'white' : 'black') : undefined

  return (
    <div className={styles.screen}>
      <header className={styles.head}>
        <div>
          <p className="eyebrow">{t('rail.play')}</p>
          <h1 className={styles.title}>{t('play.title')}</h1>
        </div>
        <div className={styles.headActions} role="group" aria-label={t('rail.play')}>
          <Button
            variant={view === 'game' ? 'secondary' : 'ghost'}
            aria-pressed={view === 'game'}
            onClick={() => setView('game')}
          >
            {t('play.tabGame')}
          </Button>
          <Button
            variant={view === 'archive' ? 'secondary' : 'ghost'}
            aria-pressed={view === 'archive'}
            onClick={() => setView('archive')}
          >
            {t('play.tabArchive')}
          </Button>
          <Button variant="primary" onClick={() => setDialogOpen(true)}>
            {t('controls.newGame')}
          </Button>
        </div>
      </header>

      {view === 'archive' ? (
        <ArchiveList
          onResumed={() => {
            setView('game')
          }}
        />
      ) : !game ? (
        <EmptyState
          title={t('play.noGameTitle')}
          body={t('play.noGameBody')}
          action={t('controls.newGame')}
          onAction={() => setDialogOpen(true)}
        />
      ) : (
        <div className={styles.layout}>
          <div className={styles.column}>
            <OpponentCard session={session} />
            {game.result ? <ResultBanner game={game} onNewGame={() => setDialogOpen(true)} /> : null}

            <div className={styles.aside}>
              <CapturedRow
                pieces={userColor === 'w' ? captured.b : captured.w}
                balance={userColor === 'w' ? -captured.balance : captured.balance}
                label={t('play.capturedByOpponent')}
              />
              {aiClock ? <ClockDisplay clock={session.clock} color={aiColor} label={t('play.clockOpponent')} /> : null}
            </div>

            <div className={styles.boardRow}>
              <EvalBar
                evaluation={evaluation}
                orientation={userColor === 'w' ? 'white' : 'black'}
                available={engineAvailable}
              />
              <Board
                fen={fen}
                orientation={userColor === 'w' ? 'white' : 'black'}
                lastMove={lastMove ?? null}
                check={check}
                viewOnly={browsing || !playing}
                movable={{ color: movableColor }}
                arrows={arrows}
                onMove={(uci) => void userMove(uci)}
              />
            </div>

            <div className={styles.aside}>
              <CapturedRow
                pieces={userColor === 'w' ? captured.w : captured.b}
                balance={userColor === 'w' ? captured.balance : -captured.balance}
                label={t('play.capturedByYou')}
              />
              <ClockDisplay clock={session.clock} color={userColor} label={t('play.clockYou')} />
            </div>

            {!engineAvailable ? <p className={styles.note}>{t('play.engineUnavailable')}</p> : null}
            {session.error ? (
              <p className={styles.error} role="alert">
                {session.error}
              </p>
            ) : null}
            {storeError ? (
              <p className={styles.error} role="alert">
                {storeError}
              </p>
            ) : null}

            <GameControls session={session} onNewGame={() => setDialogOpen(true)} onExit={() => setView('archive')} />
          </div>

          <aside className={styles.panel}>
            <div className={styles.tabs} role="tablist" aria-label={t('play.panel')}>
              {TABS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="tab"
                  id={`play-tab-${entry.id}`}
                  aria-selected={tab === entry.id}
                  aria-controls={`play-panel-${entry.id}`}
                  tabIndex={tab === entry.id ? 0 : -1}
                  className={cx(styles.tab, tab === entry.id && styles.tabActive)}
                  onClick={() => setTab(entry.id)}
                >
                  {t(entry.key)}
                </button>
              ))}
            </div>
            <div
              className={styles.panelBody}
              role="tabpanel"
              id={`play-panel-${tab}`}
              aria-labelledby={`play-tab-${tab}`}
            >
              {tab === 'moves' ? (
                <MoveList
                  moves={game.moves}
                  browsePly={browsePly}
                  onSelect={(ply) => (ply === null ? returnToLive() : setBrowsePly(ply))}
                />
              ) : tab === 'comments' ? (
                <CommentsTab session={session} />
              ) : (
                <CoachTab session={session} engineAvailable={engineAvailable} />
              )}
            </div>
            {browsing && tab === 'moves' ? (
              <div className={styles.panelFoot}>
                <p className={styles.note}>{t('play.browsing')}</p>
                <Button size="sm" onClick={() => returnToLive()}>
                  {t('play.returnToLive')}
                </Button>
              </div>
            ) : tab === 'moves' ? (
              <div className={styles.panelFoot}>
                <p className={styles.note}>{t('archive.plies', { count: game.moves.length })}</p>
              </div>
            ) : null}
          </aside>
        </div>
      )}

      <NewGameDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onStarted={() => setView('game')}
      />
    </div>
  )
}
