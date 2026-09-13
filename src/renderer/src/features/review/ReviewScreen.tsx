import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { Eval, Game, Move } from '@shared/types/game'
import { Board } from '../../board/Board'
import { EvalBar, evalLabel } from '../../board/EvalBar'
import { Button } from '../../components/ui/Button'
import { cx } from '../../components/ui/cx'
import { useEngineStore } from '../../stores/engineStore'
import { initReviewStore, useReviewStore } from '../../stores/reviewStore'
import { CommentCard } from '../play/CommentCard'
import { resultTone } from '../play/ResultBanner'
import { EvalGraph, toWhite } from './EvalGraph'
import { KeyMoments } from './KeyMoments'
import { LessonCard } from './LessonCard'
import { ReviewMoveList, fenBeforeOf, lineInSan, numberedLine, START_FEN } from './ReviewMoveList'
import styles from './Review.module.css'

/**
 * Post-game review (spec §4.4).
 *
 * Everything on screen comes from one game read through the bridge and from the analysis the main
 * process owns: the result, the accuracy of both colours, the evaluation graph, the key moments,
 * the board with its move list, and the coach's prose — a comment per move, a comment per key
 * moment, and the lesson of the game.
 *
 * The screen is also the lifetime of the review's Codex thread: it opens when the screen mounts
 * and is closed on the way out, so no thread survives a review nobody is reading.
 */

export interface ReviewScreenProps {
  gameId: string
  onClose(): void
}

/** Colour that played `move`, read from the position it produced. */
function mover(move: Move): 'w' | 'b' {
  return move.fenAfter.split(/\s+/)[1] === 'b' ? 'w' : 'b'
}

/** Evaluation of the position on the board, always from White's point of view. */
export function evalAtCursor(game: Game | null, cursor: number): Eval | null {
  const moves = game?.moves ?? []
  if (moves.length === 0) return null
  if (cursor < 0) return toWhite(moves[0]?.eval?.before, mover(moves[0]!)) ?? null
  const move = moves[cursor]
  return move ? (toWhite(move.eval?.after, mover(move)) ?? null) : null
}

export function ReviewScreen({ gameId, onClose }: ReviewScreenProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const engineAvailable = useEngineStore((state) => state.available)
  const game = useReviewStore((state) => state.game)
  const status = useReviewStore((state) => state.status)
  const cursor = useReviewStore((state) => state.cursor)
  const loading = useReviewStore((state) => state.loading)
  const activity = useReviewStore((state) => state.activity)
  const stream = useReviewStore((state) => state.stream)
  const request = useReviewStore((state) => state.request)
  const error = useReviewStore((state) => state.error)
  const setCursor = useReviewStore((state) => state.setCursor)

  // The screen owns the review: it subscribes to the three channels, opens the game and closes
  // the `training` thread on the way out.
  useEffect(() => {
    const stop = initReviewStore()
    void useReviewStore.getState().open(gameId)
    return () => {
      stop()
      void useReviewStore.getState().close()
    }
  }, [gameId])

  if (!game) {
    return (
      <section className={styles.screen} aria-label={t('review.title')}>
        <div className={styles.empty}>
          <p className={styles.note}>{loading ? t('review.loading') : t('review.notFound')}</p>
          <Button onClick={onClose}>{t('review.close')}</Button>
        </div>
      </section>
    )
  }

  const moves = game.moves
  const move = cursor >= 0 ? (moves[cursor] ?? null) : null
  const fen = move ? move.fenAfter : (game.startFen ?? START_FEN)
  const lastMove: [string, string] | undefined = move ? [move.uci.slice(0, 2), move.uci.slice(2, 4)] : undefined
  const analysis = game.analysis
  const tone = game.result ? resultTone(game.result, game.userColor) : 'draw'
  const busy = request !== null
  const streaming = activity && activity.streamId && move && activity.ply === move.ply ? (stream?.text ?? '') : null

  const evaluation = evalAtCursor(game, cursor)
  const fenBefore = move ? fenBeforeOf(game, cursor) : (game.startFen ?? START_FEN)
  const bestLine = move?.eval ? numberedLine(fenBefore, lineInSan(fenBefore, move.eval.bestLine.length > 0 ? move.eval.bestLine : [move.eval.bestMove])) : ''

  const running = status.state === 'running'
  const analysed = !!analysis
  const percent = running && status.total ? Math.round(((status.ply ?? 0) / Math.max(1, status.total)) * 100) : 0

  return (
    <section className={styles.screen} aria-label={t('review.title')}>
      <header className={cx(styles.head, styles[`head_${tone}` as const])}>
        <div className={styles.headTexts}>
          <p className="eyebrow">{t('review.title')}</p>
          <h2 className={styles.title}>
            {game.result ? `${t(`result.${tone}`)} ${t(`result.reason.${game.result.reason}`)}` : t('archive.statusInProgress')}
          </h2>
          <div className={styles.chips}>
            {game.result ? <span className={cx(styles.chip, 'mono')}>{game.result.outcome}</span> : null}
            <span className={styles.chip}>{t('archive.against', { model: game.opponent.model })}</span>
            <span className={styles.chip}>{game.userColor === 'w' ? t('archive.asWhite') : t('archive.asBlack')}</span>
            {game.opening ? (
              <span className={styles.chip} title={game.opening.name}>
                {`${game.opening.eco} · ${game.opening.name}`}
              </span>
            ) : null}
            <span className={styles.chip}>{new Date(game.updatedAt).toLocaleDateString(i18n.language)}</span>
          </div>
        </div>
        <div className={styles.actions}>
          <Button size="sm" disabled={busy || !analysed || (analysis?.keyMoments.length ?? 0) === 0} onClick={() => void useReviewStore.getState().commentKeyMoments()}>
            {request === 'keyMoments' ? t('review.commenting') : t('review.commentKeyMoments')}
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void useReviewStore.getState().lesson()}>
            {request === 'lesson' ? t('review.lessonWriting') : t('review.lesson')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t('review.close')}
          </Button>
        </div>
      </header>

      {running ? (
        <div className={styles.progress}>
          <div
            className={styles.progressTrack}
            role="progressbar"
            aria-label={t('review.analysing')}
            aria-valuemin={0}
            aria-valuemax={status.total ?? 0}
            aria-valuenow={status.ply ?? 0}
          >
            <div className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
          <p className={styles.note}>{t('review.analysingProgress', { ply: status.ply ?? 0, total: status.total ?? 0 })}</p>
        </div>
      ) : null}

      {status.state === 'unavailable' ? <p className={styles.note}>{t('review.unavailable')}</p> : null}

      {!analysed && !running && status.state !== 'unavailable' ? (
        <div className={styles.empty}>
          <p className={styles.note}>{t('review.notAnalysed')}</p>
          <Button variant="primary" disabled={!engineAvailable} onClick={() => void useReviewStore.getState().analyze()}>
            {t('review.analyse')}
          </Button>
        </div>
      ) : null}

      {analysis ? (
        <div className={styles.stats}>
          {(['w', 'b'] as const).map((colour) => (
            <div key={colour} className={styles.stat}>
              <span className={styles.statLabel}>{colour === 'w' ? t('review.white') : t('review.black')}</span>
              <span className={cx(styles.statValue, 'mono')}>{t('review.accuracyValue', { value: analysis.accuracy[colour].toFixed(1) })}</span>
              <span className={styles.statHint}>{t('review.acplValue', { value: analysis.acpl[colour] })}</span>
            </div>
          ))}
        </div>
      ) : null}

      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.layout}>
        <div className={styles.column}>
          <EvalGraph game={game} cursor={cursor} onSelect={setCursor} />

          <div className={styles.boardRow}>
            <EvalBar evaluation={evaluation} orientation={game.userColor === 'w' ? 'white' : 'black'} available={engineAvailable} />
            <Board
              fen={fen}
              orientation={game.userColor === 'w' ? 'white' : 'black'}
              lastMove={lastMove ?? null}
              viewOnly
              movable={{}}
            />
          </div>

          <section className={styles.card} aria-label={t('review.moveDetails')}>
            <header className={styles.cardHead}>
              <h3 className={cx(styles.cardTitle, 'mono')}>{move ? `${move.ply}. ${move.san}` : t('play.startPosition')}</h3>
              {move ? (
                <Button size="sm" disabled={busy} onClick={() => void useReviewStore.getState().commentMove(move.ply)}>
                  {request === 'move' ? t('review.commenting') : t('review.commentMove')}
                </Button>
              ) : null}
            </header>

            {move?.eval ? (
              <>
                <div className={styles.details}>
                  <div className={styles.detail}>
                    <span className={styles.detailLabel}>{t('review.evalBefore')}</span>
                    <span className={cx(styles.detailValue, 'mono')}>{evalLabel(toWhite(move.eval.before, mover(move)))}</span>
                  </div>
                  <div className={styles.detail}>
                    <span className={styles.detailLabel}>{t('review.evalAfter')}</span>
                    <span className={cx(styles.detailValue, 'mono')}>{evalLabel(toWhite(move.eval.after, mover(move)))}</span>
                  </div>
                  <div className={styles.detail}>
                    <span className={styles.detailLabel}>{t('review.judgement')}</span>
                    <span className={cx(styles.detailValue, styles[`mark_${move.eval.classification}` as const])}>
                      {t(`review.classification.${move.eval.classification}`)}
                    </span>
                  </div>
                  <div className={styles.detail}>
                    <span className={styles.detailLabel}>{t('review.winLoss')}</span>
                    <span className={cx(styles.detailValue, 'mono')}>{move.eval.winPercentLoss.toFixed(1)}</span>
                  </div>
                </div>
                {bestLine ? <p className={cx(styles.bestLine, 'mono')}>{t('review.bestLine', { line: bestLine })}</p> : null}
              </>
            ) : (
              <p className={styles.note}>{move ? t('review.moveNotAnalysed') : t('review.startHint')}</p>
            )}

            {streaming !== null ? (
              <CommentCard text={streaming} streaming title={t('coach.name')} />
            ) : move?.coachComment ? (
              <CommentCard text={move.coachComment} language={move.coachCommentLanguage ?? null} title={t('coach.name')} />
            ) : null}
          </section>
        </div>

        <aside className={styles.aside}>
          <section className={styles.card} aria-label={t('play.moves')}>
            <h3 className={styles.cardTitle}>{t('play.moves')}</h3>
            <ReviewMoveList moves={moves} cursor={cursor} onSelect={setCursor} />
          </section>
          <KeyMoments game={game} cursor={cursor} onSelect={setCursor} analysed={analysed} />
          <LessonCard lesson={analysis?.lesson ?? null} busy={request === 'lesson'} onGenerate={() => void useReviewStore.getState().lesson()} />
        </aside>
      </div>
    </section>
  )
}
