import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SessionState } from '@shared/types/session'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { useGameStore } from '../../stores/gameStore'
import styles from './PlayScreen.module.css'

/**
 * The six actions of a game (spec §4.3): new game, take back, hint, resign, offer a draw,
 * save and exit. Every one of them is a main-process call; the buttons only decide when they
 * make sense, and resigning — the one irreversible action — asks for a confirmation first.
 */

export interface GameControlsProps {
  session: SessionState
  onNewGame(): void
  /** Called after "Salva ed esci" so the screen can go back to the archive. */
  onExit?(): void
}

/** A take back needs a move of the user's to remove (spec §4.3). */
export function canTakeBack(session: SessionState): boolean {
  if (!session.game || session.status === 'finished') return false
  return session.game.moves.some((move) => move.by === 'user')
}

export function GameControls({ session, onNewGame, onExit }: GameControlsProps): React.JSX.Element {
  const { t } = useTranslation()
  const busy = useGameStore((state) => state.busy)
  const coachRequest = useGameStore((state) => state.coachRequest)
  const requestHint = useGameStore((state) => state.requestHint)
  const takeback = useGameStore((state) => state.takeback)
  const resign = useGameStore((state) => state.resign)
  const offerDraw = useGameStore((state) => state.offerDraw)
  const close = useGameStore((state) => state.close)

  const [confirmResign, setConfirmResign] = useState(false)
  const [drawState, setDrawState] = useState<'idle' | 'pending' | 'accepted' | 'declined'>('idle')
  const [drawReason, setDrawReason] = useState('')

  const playing = !!session.game && session.status === 'playing'

  const askDraw = async (): Promise<void> => {
    setDrawState('pending')
    setDrawReason('')
    const answer = await offerDraw()
    if (!answer) {
      setDrawState('idle')
      return
    }
    setDrawState(answer.accepted ? 'accepted' : 'declined')
    setDrawReason(answer.reason)
  }

  return (
    <div className={styles.controls}>
      <div className={styles.controlButtons}>
        <Button variant="primary" onClick={onNewGame}>
          {t('controls.newGame')}
        </Button>
        <Button disabled={!canTakeBack(session) || busy} onClick={() => void takeback()}>
          {t('controls.takeback')}
        </Button>
        {/* The hint is a coach turn, not a game action: it never waits on `busy`, only on the
            coach being free and on the position on the board being the user's to play. */}
        <Button
          disabled={!playing || coachRequest !== null || session.ai.thinking}
          onClick={() => void requestHint()}
        >
          {t('coach.hint')}
        </Button>
        <Button variant="danger" disabled={!playing || busy} onClick={() => setConfirmResign(true)}>
          {t('controls.resign')}
        </Button>
        <Button
          disabled={!playing || busy || session.ai.thinking || drawState === 'pending'}
          onClick={() => void askDraw()}
        >
          {t('controls.offerDraw')}
        </Button>
        <Button
          variant="ghost"
          disabled={!session.game || busy}
          onClick={() => {
            void close().then(() => onExit?.())
          }}
        >
          {t('controls.saveAndExit')}
        </Button>
      </div>

      {drawState !== 'idle' ? (
        <p className={styles.controlNote} role="status">
          {drawState === 'pending'
            ? t('controls.drawPending')
            : drawState === 'accepted'
              ? t('controls.drawAccepted')
              : t('controls.drawDeclined', { reason: drawReason })}
        </p>
      ) : null}

      <Modal
        open={confirmResign}
        size="sm"
        title={t('controls.resignTitle')}
        onClose={() => setConfirmResign(false)}
        footer={
          <div className={styles.modalActions}>
            <Button variant="ghost" onClick={() => setConfirmResign(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmResign(false)
                void resign()
              }}
            >
              {t('controls.resign')}
            </Button>
          </div>
        }
      >
        <p>{t('controls.resignBody')}</p>
      </Modal>
    </div>
  )
}
