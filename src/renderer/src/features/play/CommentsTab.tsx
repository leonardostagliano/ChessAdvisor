import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { Game, Move } from '@shared/types/game'
import type { SessionState } from '@shared/types/session'
import { Button } from '../../components/ui/Button'
import { Switch } from '../../components/ui/Switch'
import { useGameStore } from '../../stores/gameStore'
import { CommentCard } from './CommentCard'
import styles from './CoachPanel.module.css'

/**
 * The Commenti tab (spec §4.2): one card per commented ply, newest last, with the text of the
 * comment in flight streaming into the card at the bottom.
 *
 * Turning the comments back on never comments backwards: the plies played while they were hidden
 * stay uncommented until the user asks for them explicitly, and then at most six of them.
 */

/** Plies still without a comment; the "Commenta le mosse saltate" button acts on the last six. */
export function uncommentedMoves(game: Game | null | undefined): Move[] {
  return (game?.moves ?? []).filter((move) => !move.coachComment)
}

export interface CommentsTabProps {
  session: SessionState
}

export function CommentsTab({ session }: CommentsTabProps): React.JSX.Element {
  const { t } = useTranslation()
  const setCommentsVisible = useGameStore((state) => state.setCommentsVisible)
  const commentSkipped = useGameStore((state) => state.commentSkipped)
  const stream = useGameStore((state) => state.coachStream)
  const request = useGameStore((state) => state.coachRequest)
  const busy = useGameStore((state) => state.busy)
  const feedRef = useRef<HTMLDivElement>(null)

  const game = session.game
  const visible = session.coach.commentsVisible
  const commented = (game?.moves ?? []).filter((move) => move.coachComment)
  const skipped = uncommentedMoves(game)
  // A coach that is busy without a request of ours is writing a comment: answers and hints are
  // always started from the Coach tab, which marks itself while they run.
  const writing = visible && session.coach.busy && request === null

  useEffect(() => {
    const node = feedRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [commented.length, stream?.text, writing])

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <Switch
          checked={visible}
          onChange={(next) => void setCommentsVisible(next)}
          label={t('coach.showComments')}
          disabled={!game}
        />
        {visible && skipped.length > 0 ? (
          <Button size="sm" disabled={!game || busy || session.coach.busy} onClick={() => void commentSkipped()}>
            {t('coach.commentSkipped')}
          </Button>
        ) : null}
      </div>

      <div className={styles.feed} ref={feedRef}>
        {!visible ? (
          <p className={styles.empty}>{t('coach.commentsHidden')}</p>
        ) : commented.length === 0 && !writing ? (
          <p className={styles.empty}>{t('coach.noComments')}</p>
        ) : (
          <>
            {commented.map((move) => (
              <CommentCard
                key={`${move.ply}-${move.uci}`}
                text={move.coachComment ?? ''}
                move={{ san: move.san, by: move.by }}
                language={move.coachCommentLanguage ?? null}
              />
            ))}
            {writing ? <CommentCard text={stream?.text ?? ''} streaming /> : null}
          </>
        )}
      </div>
    </div>
  )
}
