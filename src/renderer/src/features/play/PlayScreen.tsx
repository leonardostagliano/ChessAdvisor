import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { gameStatus } from '@shared/chess/notation'
import type { Eval, Move } from '@shared/types/game'
import { tabStripKeyDown, useMoveKeys } from '../../app/keyboard'
import { Board, type BoardArrow } from '../../board/Board'
import { EvalBar } from '../../board/EvalBar'
import { Button } from '../../components/ui/Button'
import { cx } from '../../components/ui/cx'
import { Switch } from '../../components/ui/Switch'
import { useEngineStore } from '../../stores/engineStore'
import {
  boardFen,
  boardLastMove,
  isBrowsing,
  startFenOf,
  useGameStore
} from '../../stores/gameStore'
import { useUiStore } from '../../stores/uiStore'
import { ArchiveList } from './ArchiveList'
import { ClockDisplay } from './ClockDisplay'
import { CoachTab } from './CoachTab'
import { CommentsTab } from './CommentsTab'
import { GameControls } from './GameControls'
import { MoveList } from './MoveList'
import { moveQuality } from './moveQuality'
import { NewGameDialog } from './NewGameDialog'
import { OpponentCard } from './OpponentCard'
import { PlayHome } from './PlayHome'
import { ResultBanner } from './ResultBanner'
import { ReviewScreen } from '../review/ReviewScreen'
import styles from './PlayScreen.module.css'

/**
 * The play area (spec §4.3): opponent card, board with the eval bar on its left, clocks and
 * captured pieces above and below, and the tabbed panel on the right — Commenti, Mosse, Coach.
 *
 * The archive lives here too, as a second view of the same area, because resuming a game is the
 * other way into the board, and so does the post-game review (spec §4.4), which is opened from the
 * result banner of the game just played or from any finished game of the archive.
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
const TAB_IDS: readonly PanelTab[] = TABS.map((entry) => entry.id)

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
  const at = (map: Map<string, number>, piece: string): number =>
    map.get(white ? piece.toUpperCase() : piece) ?? 0
  const promoted = PROMOTABLE.reduce(
    (sum, piece) => sum + Math.max(0, at(now, piece) - at(start, piece)),
    0
  )
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
  const value = (pieces: string[]): number =>
    pieces.reduce((sum, piece) => sum + (VALUES[piece] ?? 0), 0)
  return { w, b, balance: value(w) - value(b) }
}

function CapturedRow({
  pieces,
  balance,
  label
}: {
  pieces: string[]
  balance: number
  label: string
}): React.JSX.Element {
  return (
    <div className={styles.captured} aria-label={label}>
      <span className={styles.capturedPieces} aria-hidden="true">
        {pieces.map((piece, index) => (
          <span key={`${piece}-${index}`}>{GLYPHS[piece] ?? ''}</span>
        ))}
      </span>
      {balance > 0 ? (
        <span className={cx(styles.capturedBalance, 'mono')}>{`+${balance}`}</span>
      ) : null}
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
  const browseBy = useGameStore((state) => state.browseBy)
  const storeError = useGameStore((state) => state.error)
  const engineAvailable = useEngineStore((state) => state.available)

  const [view, setView] = useState<'game' | 'archive' | 'review'>('game')
  const [reviewGameId, setReviewGameId] = useState<string | null>(null)
  const [reviewPly, setReviewPly] = useState<number | null>(null)
  const [tab, setTab] = useState<PanelTab>('moves')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [liveMoveFeedback, setLiveMoveFeedback] = useState(true)
  const [feedbackSettingError, setFeedbackSettingError] = useState<string | null>(null)
  const [feedbackMove, setFeedbackMove] = useState<Move | null>(null)
  const feedbackTimer = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    const bridge = typeof window === 'undefined' ? undefined : window.api
    if (!bridge) return
    void bridge.settings
      .get()
      .then((value) => {
        if (alive && value) setLiveMoveFeedback(value.liveMoveFeedback)
      })
      .catch(() => undefined)
    const unsubscribe = bridge.on('settings:changed', (value) => {
      if (alive) setLiveMoveFeedback(value.liveMoveFeedback)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const saveLiveMoveFeedback = useCallback(
    async (next: boolean): Promise<void> => {
      const previous = liveMoveFeedback
      setLiveMoveFeedback(next)
      setFeedbackSettingError(null)
      try {
        const saved = await window.api?.settings.save({ liveMoveFeedback: next })
        if (saved) setLiveMoveFeedback(saved.liveMoveFeedback)
      } catch {
        setLiveMoveFeedback(previous)
        setFeedbackSettingError(t('play.qualitySettingFailed'))
      }
    },
    [liveMoveFeedback, t]
  )

  // Another area (the training section, spec §6.4) can ask for a review of one ply: the request
  // is one-shot, so it is consumed as soon as it is honoured.
  const reviewTarget = useUiStore((state) => state.reviewTarget)
  useEffect(() => {
    if (!reviewTarget) return
    setReviewGameId(reviewTarget.gameId)
    setReviewPly(reviewTarget.ply)
    setView('review')
    useUiStore.getState().clearReviewTarget()
  }, [reviewTarget])

  const browsing = isBrowsing({ session, browsePly })
  const fen = boardFen({ session, browsePly })
  const lastMove = boardLastMove({ session, browsePly })
  const game = session.game
  const playing = !!game && session.status === 'playing'
  const userColor = game?.userColor ?? 'w'

  const feedbackSeen = useRef<{ gameId: string | null; length: number; assessment: string | null }>(
    {
      gameId: null,
      length: 0,
      assessment: null
    }
  )
  const latestMove = game?.moves.at(-1) ?? null
  const latestQuality = latestMove ? moveQuality(latestMove) : null
  const latestAssessment = latestMove
    ? latestMove.eval
      ? `final:${latestMove.ply}`
      : latestMove.liveEval
        ? `live:${latestMove.ply}:${latestMove.liveEval.assessedAt}`
        : null
    : null
  const gameId = game?.id ?? null
  const moveCount = game?.moves.length ?? 0

  useEffect(() => {
    const previous = feedbackSeen.current
    const changedGame = previous.gameId !== gameId
    const wentBack = previous.gameId === gameId && moveCount < previous.length
    const newMove = previous.gameId === gameId && moveCount > previous.length
    const assessmentArrived =
      previous.gameId === gameId &&
      moveCount === previous.length &&
      latestAssessment !== previous.assessment

    feedbackSeen.current = { gameId, length: moveCount, assessment: latestAssessment }
    if (
      changedGame ||
      wentBack ||
      view !== 'game' ||
      browsing ||
      !liveMoveFeedback ||
      !game ||
      !latestMove
    ) {
      if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current)
      feedbackTimer.current = null
      setFeedbackMove(null)
      return
    }
    if (newMove && !latestQuality) {
      if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current)
      feedbackTimer.current = null
      setFeedbackMove(null)
      return
    }
    if (!latestQuality || (!newMove && !assessmentArrived)) return

    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current)
    setFeedbackMove(latestMove)
    feedbackTimer.current = window.setTimeout(() => {
      feedbackTimer.current = null
      setFeedbackMove(null)
    }, 2400)
  }, [
    gameId,
    moveCount,
    latestAssessment,
    view,
    browsing,
    liveMoveFeedback,
    game,
    latestMove,
    latestQuality
  ])

  useEffect(
    () => () => {
      if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current)
    },
    []
  )

  const evaluation: Eval | null = session.liveEval
    ? {
        ...(session.liveEval.cp !== undefined ? { cp: session.liveEval.cp } : {}),
        ...(session.liveEval.mate !== undefined ? { mate: session.liveEval.mate } : {})
      }
    : null
  const captured = useMemo(() => capturedPieces(startFenOf(game), fen), [game, fen])
  const check = useMemo(() => gameStatus(fen).check, [fen])

  // The hint belongs to the live position: browsing a past ply puts the arrow away until we are
  // back on it, and the main process drops the hint itself as soon as the user moves (spec §4.2).
  const hint = session.coach.hint
  const arrows = useMemo<BoardArrow[]>(
    () =>
      hint && !browsing
        ? [
            // A ring on the piece to move, then the arrow to its destination: spec §4.2.
            { from: hint.uci.slice(0, 2), color: 'accent' },
            { from: hint.uci.slice(0, 2), to: hint.uci.slice(2, 4), color: 'accent' }
          ]
        : [],
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

  // ← → Home End walk the game while the board is on screen (task T22 item 4); the move list and
  // the dialogs handle their own keys first, and this never fires while the user is writing.
  useMoveKeys({
    previous: useCallback(() => browseBy(-1), [browseBy]),
    next: useCallback(() => browseBy(1), [browseBy]),
    first: useCallback(() => setBrowsePly(-1), [setBrowsePly]),
    last: useCallback(() => returnToLive(), [returnToLive]),
    enabled: view === 'game' && (game?.moves.length ?? 0) > 0
  })

  const movableColor =
    playing && session.userToMove && !session.ai.thinking && !browsing
      ? userColor === 'w'
        ? 'white'
        : 'black'
      : undefined

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

      {view === 'review' && reviewGameId ? (
        <ReviewScreen
          gameId={reviewGameId}
          ply={reviewPly}
          onClose={() => setView(game ? 'game' : 'archive')}
        />
      ) : view === 'archive' ? (
        <ArchiveList
          onResumed={() => {
            setView('game')
          }}
          onNewGame={() => setDialogOpen(true)}
          onReview={(id) => {
            setReviewGameId(id)
            setReviewPly(null)
            setView('review')
          }}
        />
      ) : !game ? (
        <PlayHome onNewGame={() => setDialogOpen(true)} onArchive={() => setView('archive')} />
      ) : (
        <div className={styles.layout}>
          <div className={styles.column}>
            <div className={styles.table}>
              <OpponentCard
                session={session}
                meta={
                  <div className={styles.opponentMeta}>
                    <CapturedRow
                      pieces={userColor === 'w' ? captured.b : captured.w}
                      balance={userColor === 'w' ? -captured.balance : captured.balance}
                      label={t('play.capturedByOpponent')}
                    />
                    {aiClock ? (
                      <ClockDisplay
                        clock={session.clock}
                        color={aiColor}
                        label={t('play.clockOpponent')}
                      />
                    ) : null}
                  </div>
                }
              />
              {game.result ? (
                <ResultBanner
                  game={game}
                  onNewGame={() => setDialogOpen(true)}
                  onReview={() => {
                    setReviewGameId(game.id)
                    setReviewPly(null)
                    setView('review')
                  }}
                />
              ) : null}

              <div className={styles.boardViewport}>
                <div className={styles.boardRow}>
                  <EvalBar
                    evaluation={evaluation}
                    orientation={userColor === 'w' ? 'white' : 'black'}
                    available={engineAvailable}
                  />
                  <div className={styles.boardStage}>
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
                    {feedbackMove && liveMoveFeedback ? (
                      <div
                        className={cx(
                          styles.qualityOverlay,
                          styles[
                            `quality_${moveQuality(feedbackMove)?.evaluation.classification ?? 'good'}` as const
                          ]
                        )}
                        role="status"
                        aria-live="polite"
                        data-testid="move-quality-overlay"
                      >
                        <span className={styles.qualityActor}>
                          {feedbackMove.by === 'user' ? t('play.you') : t('opponent.title')}
                        </span>
                        <strong>
                          {t(
                            `review.classification.${moveQuality(feedbackMove)?.evaluation.classification ?? 'good'}`
                          )}
                        </strong>
                        <span className={cx(styles.qualitySan, 'mono')}>{feedbackMove.san}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>

              <div className={styles.playerStrip}>
                <div className={styles.playerIdentity}>
                  <span
                    className={cx(
                      styles.playerStone,
                      userColor === 'w' ? styles.stoneWhite : styles.stoneBlack
                    )}
                    aria-hidden="true"
                  />
                  <span>
                    <strong>{t('play.you')}</strong>
                    <small>
                      {session.userToMove ? t('play.yourTurn') : t('play.waitingOpponent')}
                    </small>
                  </span>
                </div>
                <div className={styles.playerMeta}>
                  <CapturedRow
                    pieces={userColor === 'w' ? captured.w : captured.b}
                    balance={userColor === 'w' ? captured.balance : -captured.balance}
                    label={t('play.capturedByYou')}
                  />
                  <ClockDisplay
                    clock={session.clock}
                    color={userColor}
                    label={t('play.clockYou')}
                  />
                </div>
              </div>
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

            <GameControls
              session={session}
              onNewGame={() => setDialogOpen(true)}
              onExit={() => setView('archive')}
            />
          </div>

          <aside className={styles.panel}>
            <div
              className={styles.tabs}
              role="tablist"
              aria-label={t('play.panel')}
              onKeyDown={(event) => tabStripKeyDown(event, TAB_IDS, tab, setTab)}
            >
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
            {tab === 'moves' ? (
              <div className={styles.qualityToolbar}>
                <Switch
                  checked={liveMoveFeedback}
                  onChange={(next) => void saveLiveMoveFeedback(next)}
                  label={t('settings.liveMoveFeedback')}
                />
                {feedbackSettingError ? (
                  <p className={styles.qualitySettingError} role="alert">
                    {feedbackSettingError}
                  </p>
                ) : null}
              </div>
            ) : null}
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
                  showQuality={liveMoveFeedback}
                  onSelect={(ply) => (ply === null ? returnToLive() : setBrowsePly(ply))}
                />
              ) : tab === 'comments' ? (
                <CommentsTab session={session} showQuality={liveMoveFeedback} />
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
                <p className={styles.note} aria-live="polite">
                  {liveMoveFeedback && latestMove?.liveEvalStatus === 'pending'
                    ? t('play.qualityPending')
                    : liveMoveFeedback && latestMove?.liveEvalStatus === 'unavailable'
                      ? t('play.qualityUnavailable')
                      : t('archive.plies', { count: game.moves.length })}
                </p>
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
