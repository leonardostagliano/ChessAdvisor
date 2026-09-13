import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { applyMove } from '@shared/chess/notation'
import type { Exercise } from '@shared/types/training'
import { Board } from '../../board/Board'
import { Button } from '../../components/ui/Button'
import { cx } from '../../components/ui/cx'
import { streamingText, useTrainingStore } from '../../stores/trainingStore'
import { lineInSan, numberedLine } from '../review/ReviewMoveList'
import { ExplanationCard } from './ExplanationCard'
import styles from './Training.module.css'

/**
 * One exercise played on the board (spec §6.4, §6.5).
 *
 * The rules of the position live in the main process: every move goes through
 * `training.exercises.attempt`, which answers with the position the board must show next — the
 * reply of the opponent included. The player only owns what is visible: the position on screen,
 * the feedback under it, how many times the move was missed and whether the solution has been
 * asked for. Nothing here guesses whether a move is right: a wrong move leaves the board exactly
 * as it was, so the user can simply try again.
 *
 * The solution is offered after two failed attempts (spec §6.4) and never before: an exercise
 * that gives itself away is not an exercise.
 */

/** Failed attempts after which "Mostra soluzione" appears (spec §6.4). */
export const REVEAL_AFTER_FAILURES = 2
/** How long the position after the user's move is shown before the reply is played. */
export const REPLY_DELAY_MS = 320

export type ExerciseFeedback = 'idle' | 'correct' | 'alternative' | 'wrong' | 'solved' | 'over'

export interface ExercisePlayerProps {
  exercise: Exercise
  /** "3/10" over a thematic set; absent for a single exercise. */
  position?: { index: number; total: number } | null
  /** Called the first time the exercise is solved, so a set can offer the next one. */
  onSolved?(): void
  /** Rendered under the actions: the "next exercise" button of a set, a link to the review… */
  children?: React.ReactNode
}

/** Side to move in a FEN, as the board wants its orientation. */
function sideToMove(fen: string): 'w' | 'b' {
  return fen.split(/\s+/)[1] === 'b' ? 'b' : 'w'
}

export function ExercisePlayer({
  exercise,
  position = null,
  onSolved,
  children
}: ExercisePlayerProps): React.JSX.Element {
  const { t } = useTranslation()
  const [fen, setFen] = useState(exercise.fen)
  const [feedback, setFeedback] = useState<ExerciseFeedback>('idle')
  const [done, setDone] = useState(false)
  const [failures, setFailures] = useState(0)
  const [revealed, setRevealed] = useState(false)
  const [lastMove, setLastMove] = useState<[string, string] | null>(null)
  const [pending, setPending] = useState(false)
  const request = useTrainingStore((state) => state.request)
  const explanation = useTrainingStore(
    (state) => state.explanations[exercise.id] ?? exercise.explanation ?? ''
  )
  const streaming = useTrainingStore((state) => streamingText(state, 'explain', exercise.id))
  const replyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = (): void => {
    if (replyTimer.current) clearTimeout(replyTimer.current)
    replyTimer.current = null
  }

  /** Back to the starting position, forgetting everything this window knew about the attempt. */
  const restart = useCallback((): void => {
    clearTimer()
    setFen(exercise.fen)
    setFeedback('idle')
    setDone(false)
    setFailures(0)
    setRevealed(false)
    setLastMove(null)
    setPending(false)
  }, [exercise.fen])

  // Every exercise starts from its own position: changing the one on screen resets everything the
  // player knows about it, including a reply that was still waiting to be animated.
  useEffect(() => {
    restart()
    // The identity of the exercise is what starts it over, not a new object with the same id:
    // the record is rewritten at every attempt, and the board must not jump back mid-solution.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exercise.id])

  useEffect(() => clearTimer, [])

  const explaining = request?.kind === 'explain' && request.ref === exercise.id
  const turn = sideToMove(fen)
  const orientation = exercise.sideToMove === 'w' ? 'white' : 'black'
  const movable = done || pending || revealed ? undefined : turn === 'w' ? 'white' : 'black'

  const play = useCallback(
    async (uci: string): Promise<void> => {
      if (pending || done || revealed) return
      setPending(true)
      const before = fen
      const result = await useTrainingStore.getState().attempt(exercise.id, uci)
      if (!result) {
        setPending(false)
        return
      }
      if (!result.correct) {
        // `done` without `correct` means the solution had already run out: the exercise is over,
        // not missed, so it does not count as a failure either.
        if (result.done) {
          setDone(true)
          setFeedback('over')
        } else {
          setFailures((count) => count + 1)
          setFeedback('wrong')
        }
        setFen(result.fen)
        setPending(false)
        return
      }

      // The answer already holds the position after the reply: the move of the user is shown on
      // its own first, then the reply lands, so the two are never one single jump (spec §6.5).
      const own = applyMove(before, uci)
      setLastMove([uci.slice(0, 2), uci.slice(2, 4)])
      if (result.reply && own && own.fen !== result.fen) {
        setFen(own.fen)
        const reply = result.reply
        clearTimer()
        replyTimer.current = setTimeout(() => {
          setFen(result.fen)
          setLastMove([reply.slice(0, 2), reply.slice(2, 4)])
          setPending(false)
        }, REPLY_DELAY_MS)
      } else {
        setFen(result.fen)
        setPending(false)
      }

      setFeedback(result.alternativesAccepted ? 'alternative' : result.done ? 'solved' : 'correct')
      if (result.done) {
        setDone(true)
        onSolved?.()
      }
    },
    [exercise.id, fen, onSolved, pending, revealed, done]
  )

  const solutionLine = numberedLine(
    exercise.fen,
    lineInSan(exercise.fen, exercise.solution, exercise.solution.length)
  )
  const canReveal =
    !revealed && !done && failures >= REVEAL_AFTER_FAILURES && solutionLine.length > 0
  const message =
    feedback === 'solved'
      ? t('training.exercise.solved')
      : feedback === 'alternative'
        ? t('training.exercise.correctAlternative')
        : feedback === 'correct'
          ? t('training.exercise.correct')
          : feedback === 'wrong'
            ? t('training.exercise.wrong')
            : feedback === 'over'
              ? t('training.exercise.over')
              : null

  return (
    <div
      className={styles.player}
      data-testid="exercise-player"
      data-exercise={exercise.id}
      data-feedback={feedback}
    >
      <div className={styles.cardHead}>
        <p className={styles.prompt}>
          {exercise.sideToMove === 'w'
            ? t('training.exercise.promptW')
            : t('training.exercise.promptB')}
        </p>
        {position ? (
          <span className={cx(styles.chip, 'mono')} data-testid="exercise-position">
            {t('training.exercise.progress', { index: position.index, total: position.total })}
          </span>
        ) : null}
      </div>

      <div className={styles.chips}>
        <span className={styles.chip}>
          {t(`themes.${exercise.theme}`, { defaultValue: exercise.theme })}
        </span>
        {typeof exercise.rating === 'number' ? (
          <span className={cx(styles.chip, 'mono')}>
            {t('training.exercise.rating', { value: exercise.rating })}
          </span>
        ) : null}
        <span
          className={cx(
            styles.chip,
            exercise.status === 'solved' && styles.chipSolved,
            exercise.status === 'failed' && styles.chipFailed
          )}
        >
          {t(`training.status.${exercise.status}`)}
        </span>
        {exercise.attempts > 0 ? (
          <span className={styles.chip}>
            {t('training.attempts', { count: exercise.attempts })}
          </span>
        ) : null}
      </div>

      <div className={styles.board}>
        <Board
          fen={fen}
          orientation={orientation}
          lastMove={lastMove}
          movable={{ ...(movable ? { color: movable } : {}) }}
          viewOnly={!movable}
          label={t('training.exercise.boardLabel')}
          onMove={(uci) => void play(uci)}
        />
      </div>

      {message ? (
        <p
          className={cx(
            styles.feedback,
            (feedback === 'correct' || feedback === 'alternative' || feedback === 'solved') &&
              styles.feedbackCorrect,
            feedback === 'wrong' && styles.feedbackWrong
          )}
          role="status"
          data-testid="exercise-feedback"
        >
          {message}
        </p>
      ) : null}

      {revealed ? (
        <p className={cx(styles.solution, 'mono')} data-testid="exercise-solution">
          {t('training.exercise.solution', { line: solutionLine })}
        </p>
      ) : null}

      <div className={styles.actions}>
        {canReveal ? (
          <Button size="sm" onClick={() => setRevealed(true)}>
            {t('training.exercise.reveal')}
          </Button>
        ) : null}
        <Button
          size="sm"
          onClick={() => {
            restart()
            void useTrainingStore.getState().reset(exercise.id)
          }}
        >
          {t('training.exercise.reset')}
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={explaining}
          onClick={() => void useTrainingStore.getState().explain(exercise.id)}
        >
          {explaining ? t('training.exercise.explaining') : t('training.exercise.explain')}
        </Button>
        {children}
      </div>

      <ExplanationCard
        text={streaming !== null ? streaming : explanation}
        streaming={streaming !== null}
      />
    </div>
  )
}
