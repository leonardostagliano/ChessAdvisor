import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { CoachLogEntry, Game } from '@shared/types/game'
import type { SessionState } from '@shared/types/session'
import { Button } from '../../components/ui/Button'
import { cx } from '../../components/ui/cx'
import { useEngineStore } from '../../stores/engineStore'
import { useGameStore } from '../../stores/gameStore'
import { CommentCard } from './CommentCard'
import styles from './CoachPanel.module.css'

/**
 * The Coach tab (spec §4.2): free questions, the hint button, and the history of everything the
 * coach has said outside the comments feed.
 *
 * The history is read from `Game.coachLog`, which the main process persists, so it survives a
 * resume and a recreated thread; only the answer currently streaming lives in the store.
 */

/**
 * Questions, answers and hints, in the order they happened; comments belong to the other tab.
 *
 * The hint on the board is also the last thing written to the log, so it is left out here: it is
 * shown once, as the live card with the button that takes the arrow away.
 */
export function coachDialogue(
  game: Game | null | undefined,
  activeHint?: { move: string; reason: string } | null
): CoachLogEntry[] {
  const entries = (game?.coachLog ?? []).filter((entry) => entry.kind !== 'comment')
  const last = entries[entries.length - 1]
  if (activeHint && last?.kind === 'hint' && last.move === activeHint.move && last.text === activeHint.reason) {
    return entries.slice(0, -1)
  }
  return entries
}

export interface CoachTabProps {
  session: SessionState
  /** Overrides the mirrored engine state; only tests and previews pass it. */
  engineAvailable?: boolean
}

export function CoachTab({ session, engineAvailable }: CoachTabProps): React.JSX.Element {
  const { t } = useTranslation()
  const mirrored = useEngineStore((state) => state.available)
  const askCoach = useGameStore((state) => state.askCoach)
  const requestHint = useGameStore((state) => state.requestHint)
  const clearHint = useGameStore((state) => state.clearHint)
  const stream = useGameStore((state) => state.coachStream)
  const request = useGameStore((state) => state.coachRequest)
  const [draft, setDraft] = useState('')
  const feedRef = useRef<HTMLDivElement>(null)

  const oracle = engineAvailable ?? mirrored
  const game = session.game
  const hint = session.coach.hint
  const dialogue = coachDialogue(game, hint)
  const pending = request !== null
  const answering = request === 'answer'

  useEffect(() => {
    const node = feedRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [dialogue.length, stream?.text, hint?.uci, answering])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const question = draft.trim()
    if (question.length === 0 || pending || !game) return
    setDraft('')
    void askCoach(question)
  }

  return (
    <div className={styles.panel}>
      <div className={styles.head}>
        <Button
          size="sm"
          variant="secondary"
          disabled={!game || pending || session.status !== 'playing'}
          onClick={() => void requestHint()}
        >
          {t('coach.hint')}
        </Button>
        {!oracle ? (
          <span className={styles.badge} title={t('coach.noOracleHint')}>
            {t('coach.noOracle')}
          </span>
        ) : null}
      </div>

      <div className={styles.feed} ref={feedRef}>
        {dialogue.length === 0 && !hint && !answering ? <p className={styles.empty}>{t('coach.empty')}</p> : null}

        {dialogue.map((entry) => (
          <CommentCard
            key={entry.id}
            text={entry.text}
            language={entry.language}
            title={
              entry.kind === 'question'
                ? t('coach.you')
                : entry.kind === 'hint'
                  ? t('coach.hintOf', { move: entry.move ?? '' })
                  : t('coach.name')
            }
            className={entry.kind === 'question' ? styles.question : undefined}
          />
        ))}

        {hint ? (
          <div className={styles.hint}>
            <CommentCard text={hint.reason} title={t('coach.hintOf', { move: hint.move })} />
            <Button size="sm" variant="ghost" onClick={() => void clearHint()}>
              {t('coach.hideHint')}
            </Button>
          </div>
        ) : null}

        {answering ? <CommentCard text={stream?.text ?? ''} title={t('coach.name')} streaming /> : null}
      </div>

      <form className={styles.ask} onSubmit={submit}>
        <label className={styles.askLabel} htmlFor="coach-question">
          {t('coach.question')}
        </label>
        <div className={styles.askRow}>
          <input
            id="coach-question"
            className={cx(styles.input, 'selectable')}
            value={draft}
            placeholder={t('coach.questionPlaceholder')}
            disabled={!game || pending}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button type="submit" variant="primary" disabled={!game || pending || draft.trim().length === 0}>
            {t('coach.send')}
          </Button>
        </div>
        {pending ? (
          <p className={styles.pending} role="status">
            {t('coach.thinking')}
          </p>
        ) : null}
      </form>
    </div>
  )
}
