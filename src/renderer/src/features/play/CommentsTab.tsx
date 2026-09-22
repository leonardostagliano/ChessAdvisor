import { useMemo, useRef } from 'react'
import { Chess } from 'chess.js'
import { useTranslation } from 'react-i18next'
import { useFollowFeed } from './useFollowFeed'
import type { CoachEvidenceLine, CoachExplanation, Game, Move } from '@shared/types/game'
import type { SessionState } from '@shared/types/session'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/EmptyState'
import { Switch } from '../../components/ui/Switch'
import { useGameStore } from '../../stores/gameStore'
import { useUiStore } from '../../stores/uiStore'
import { CommentCard } from './CommentCard'
import { instantMoveExplanation } from './instantCoach'
import styles from './CoachPanel.module.css'

const STANDARD_START_FEN = new Chess().fen()

/**
 * The Commenti tab (spec §4.2): one card per ply, newest last. Verified local facts are available
 * immediately and remain readable later; the AI explanation upgrades the same card when ready.
 *
 * Turning AI comments back on never requests them backwards: moves played while they were hidden
 * retain only their local reading until the user explicitly requests the last six AI comments.
 */

/** Plies still without a comment; the "Commenta le mosse saltate" button acts on the last six. */
export function uncommentedMoves(game: Game | null | undefined): Move[] {
  return (game?.moves ?? []).filter((move) => !move.coachComment && !move.coachExplanation)
}

export interface CommentsTabProps {
  session: SessionState
  showQuality?: boolean
  selectedPly?: number | null
  onSelectMove?: (move: Move) => void
  onPreviewLine?: (move: Move, line: CoachEvidenceLine, step: number) => void
  onClearPreview?: () => void
  annotationsEnabled?: boolean
  onAnnotationsEnabledChange?: (enabled: boolean) => void
}

export function CommentsTab({ session, showQuality = true, selectedPly, onSelectMove, onPreviewLine, onClearPreview, annotationsEnabled, onAnnotationsEnabledChange }: CommentsTabProps): React.JSX.Element {
  const { t } = useTranslation()
  const setCommentsVisible = useGameStore((state) => state.setCommentsVisible)
  const commentSkipped = useGameStore((state) => state.commentSkipped)
  const stream = useGameStore((state) => state.coachStream)
  const request = useGameStore((state) => state.coachRequest)
  const busy = useGameStore((state) => state.busy)
  const language = useUiStore((state) => state.language)
  const feedRef = useRef<HTMLDivElement>(null)
  const instantCache = useRef(new Map<string, CoachExplanation | null>())
  const cacheGameId = useRef<string | null>(null)

  const game = session.game
  const visible = session.coach.commentsVisible
  const moves = game?.moves ?? []
  const activePly = session.coach.activeCommentPly
  const instantByPly = useMemo(() => {
    const result = new Map<number, CoachExplanation>()
    if (!game) return result
    if (cacheGameId.current !== game.id) {
      instantCache.current.clear()
      cacheGameId.current = game.id
    }
    game.moves.forEach((move, index) => {
      if (move.coachComment || move.coachExplanation) return
      const fenBefore = index > 0 ? game.moves[index - 1]!.fenAfter : game.startFen ?? STANDARD_START_FEN
      const key = `${fenBefore}|${move.uci}|${move.fenAfter}|${game.userColor}|${language}`
      if (!instantCache.current.has(key))
        instantCache.current.set(key, instantMoveExplanation(move, fenBefore, game.userColor, language))
      const explanation = instantCache.current.get(key)
      if (explanation) result.set(move.ply, explanation)
    })
    return result
  }, [game?.moves, game?.startFen, game?.userColor, game?.id, language])
  const entries = moves.filter((move) =>
    move.coachComment || move.coachExplanation || instantByPly.has(move.ply)
  )
  const skipped = uncommentedMoves(game)
  // A coach that is busy without a request of ours is writing a comment: answers and hints are
  // always started from the Coach tab, which marks itself while they run.
  const writing = visible && session.coach.busy && request === null
  const streamText = stream?.streamId === session.coach.streamId ? stream.text : ''

  useFollowFeed(feedRef, [entries.length, streamText, writing])

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <Switch
          checked={visible}
          onChange={(next) => void setCommentsVisible(next)}
          label={t('coach.showComments')}
          disabled={!game}
        />
        {onAnnotationsEnabledChange ? <Switch checked={annotationsEnabled ?? true} onChange={onAnnotationsEnabledChange} label={t('coach.annotationToggle')} disabled={!game} /> : null}
        {visible && skipped.length > 0 ? (
          <Button
            size="sm"
            disabled={!game || busy || session.coach.busy}
            onClick={() => void commentSkipped()}
          >
            {t('coach.commentSkipped')}
          </Button>
        ) : null}
      </div>

      <div className={styles.feed} ref={feedRef}>
        {!visible ? (
          <EmptyState
            title={t('coach.commentsHiddenTitle')}
            body={t('coach.commentsHidden')}
            action={t('coach.commentsHiddenAction')}
            disabled={!game}
            onAction={() => void setCommentsVisible(true)}
          />
        ) : entries.length === 0 && !writing ? (
          <EmptyState
            title={t('coach.noCommentsTitle')}
            body={t('coach.noComments')}
            {...(skipped.length > 0 && game
              ? {
                  action: t('coach.commentSkipped'),
                  disabled: busy || session.coach.busy,
                  onAction: () => void commentSkipped()
                }
              : {})}
          />
        ) : (
          <>
            {entries.map((move) => {
              const active = writing && activePly === move.ply
              const provisional = !move.coachComment && !move.coachExplanation
                ? instantByPly.get(move.ply)
                : null
              return (
                <CommentCard
                  key={`${move.ply}-${move.uci}`}
                  text={active ? streamText : move.coachComment ?? ''}
                  move={move}
                  explanation={move.coachExplanation ?? provisional}
                  title={provisional ? t('coach.instantRead') : undefined}
                  streaming={active && !move.coachComment && !move.coachExplanation}
                  selected={selectedPly === move.ply}
                  onSelectMove={onSelectMove ? () => onSelectMove(move) : undefined}
                  onPreviewLine={onPreviewLine ? (line, step) => onPreviewLine(move, line, step) : undefined}
                  onClearPreview={onClearPreview}
                  showQuality={showQuality}
                  language={provisional ? language : move.coachCommentLanguage ?? null}
                />
              )
            })}
            {writing && (activePly == null || !entries.some((move) => move.ply === activePly))
              ? <CommentCard text={streamText} title={t('coach.name')} streaming /> : null}
          </>
        )}
      </div>
    </div>
  )
}
