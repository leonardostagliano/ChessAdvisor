import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'
import {
  UpdatePromptController,
  updatePromptApi,
  type UpdatePromptApi,
  type UpdatePromptState
} from '../state/updatePrompt'
import styles from './AppUpdatePrompt.module.css'

export interface AppUpdatePromptProps {
  /**
   * Set while an AI turn is running: the dialog stays hidden rather than
   * interrupting the game (Task 10 wires the game flag).
   */
  blocked?: boolean
  /** Injection point for tests; defaults to the preload bridge. */
  api?: UpdatePromptApi | null
}

const EMPTY: UpdatePromptState = { status: null, version: null, pending: null, error: '' }

/** Offers one update at a time; a single confirmation covers download and install. */
export function AppUpdatePrompt({
  blocked = false,
  api
}: AppUpdatePromptProps = {}): React.JSX.Element | null {
  const { t } = useTranslation()
  const [state, setState] = useState<UpdatePromptState>(EMPTY)
  const controller = useRef<UpdatePromptController | null>(null)
  const messages = useRef({
    failed: t('updates.failed'),
    releaseChanged: t('updates.releaseChanged')
  })
  messages.current = { failed: t('updates.failed'), releaseChanged: t('updates.releaseChanged') }

  useEffect(() => {
    const port = api ?? updatePromptApi()
    if (!port) return
    const next = new UpdatePromptController(port, setState, messages.current)
    controller.current = next
    void next.start()
    return () => {
      next.dispose()
      controller.current = null
      setState(EMPTY)
    }
  }, [api])

  const busy = !!state.pending
  // An installation already started must stay on screen even if a turn begins meanwhile.
  const open = !!state.version && !!state.status && (!blocked || busy)
  if (!open || !state.status) return null

  const progress = state.status.download
  const percent =
    progress && progress.totalBytes > 0 && Number.isFinite(progress.percent)
      ? Math.max(0, Math.min(100, progress.percent))
      : undefined
  const canConfirm =
    !busy &&
    state.status.release?.version === state.version &&
    (state.status.canDownload || state.status.canInstall)
  const confirmLabel = busy
    ? state.pending === 'downloading'
      ? t('updates.downloadingShort')
      : t('updates.restarting')
    : state.status.canInstall
      ? t('updates.installAndRestart')
      : t('updates.confirmDownload')

  return (
    <Modal
      open
      size="sm"
      closeOnBackdrop={!busy}
      title={t('updates.promptTitle')}
      onClose={() => controller.current?.dismiss()}
      footer={
        <div className={styles.actions}>
          <Button variant="secondary" disabled={busy} onClick={() => controller.current?.dismiss()}>
            {t('updates.later')}
          </Button>
          <Button
            variant="primary"
            disabled={!canConfirm}
            onClick={() => void controller.current?.confirm()}
          >
            {confirmLabel}
          </Button>
        </div>
      }
    >
      <div className={styles.body} aria-busy={busy}>
        <p className={styles.lead}>{t('updates.promptBody', { version: state.version })}</p>
        <p className={styles.note}>{t('updates.promptKeep')}</p>
        {busy ? (
          <div className={styles.progress} role="status" aria-live="polite">
            <div className={styles.progressLabel}>
              <span>
                {state.pending === 'downloading'
                  ? t('updates.downloading')
                  : t('updates.installing')}
              </span>
              {state.pending === 'downloading' && percent !== undefined ? (
                <span className="mono">{Math.round(percent)}%</span>
              ) : null}
            </div>
            <div className={styles.track}>
              <div
                className={styles.fill}
                data-indeterminate={state.pending !== 'downloading' || percent === undefined}
                style={
                  state.pending === 'downloading' && percent !== undefined
                    ? { width: `${percent}%` }
                    : undefined
                }
              />
            </div>
          </div>
        ) : null}
        {state.error ? (
          <div className={styles.error} role="alert">
            {state.error}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
