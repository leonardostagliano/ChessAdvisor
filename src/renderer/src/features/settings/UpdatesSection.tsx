import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppVersionInfo } from '@shared/types/api'
import type { UpdatePhase, UpdateStatus } from '@shared/updates'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { Switch } from '../../components/ui/Switch'
import { updateErrorText } from '../../state/updatePrompt'
import screen from '../Screen.module.css'
import styles from './UpdatesSection.module.css'

const PHASE_KEY: Record<UpdatePhase, string> = {
  idle: 'updates.phase.idle',
  authenticating: 'updates.phase.authenticating',
  checking: 'updates.phase.checking',
  'up-to-date': 'updates.phase.upToDate',
  available: 'updates.phase.available',
  downloading: 'updates.phase.downloading',
  downloaded: 'updates.phase.downloaded',
  installing: 'updates.phase.installing',
  error: 'updates.phase.error'
}

/** Updates and licences panel of the Settings screen. */
export function UpdatesSection(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [version, setVersion] = useState<AppVersionInfo | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [notices, setNotices] = useState<string | null>(null)
  const [noticesOpen, setNoticesOpen] = useState(false)
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    const bridge = window.api
    if (!bridge?.updates) return
    const unsubscribe = bridge.on('updates:changed', (next) => {
      if (alive.current) setStatus(next)
    })
    void bridge.updates
      .status()
      .then((next) => {
        if (alive.current) setStatus(next)
      })
      .catch(() => undefined)
    void bridge.app
      .versionInfo()
      .then((info) => {
        if (alive.current) setVersion(info)
      })
      .catch(() => undefined)
    return () => {
      alive.current = false
      unsubscribe()
    }
  }, [])

  /** Every command shares the same busy guard and error surface. */
  const run = useCallback(
    async (action: (updates: NonNullable<typeof window.api>['updates']) => Promise<UpdateStatus>) => {
      const bridge = window.api
      if (!bridge?.updates || pending) return
      setPending(true)
      setError('')
      try {
        const next = await action(bridge.updates)
        if (alive.current) setStatus(next)
      } catch (failure) {
        if (alive.current) setError(updateErrorText(failure, t('updates.failed')))
      } finally {
        if (alive.current) setPending(false)
      }
    },
    [pending, t]
  )

  const openNotices = useCallback(async () => {
    setNoticesOpen(true)
    if (notices !== null) return
    try {
      const text = await window.api.app.readNotices()
      if (alive.current) setNotices(text)
    } catch (failure) {
      if (alive.current) setNotices(updateErrorText(failure, t('updates.failed')))
    }
  }, [notices, t])

  const connected = status?.authSource === 'github-app' && !!status.githubAccount
  const authenticating = status?.phase === 'authenticating'
  const busy = pending || authenticating
  const versionLabel = version
    ? version.isPackaged
      ? `v${version.version}`
      : t('updates.developmentVersion', { version: version.version })
    : (status?.currentVersion ?? '—')
  const checkedAt = status?.checkedAt ? new Date(status.checkedAt).toLocaleString(i18n.language) : t('updates.never')
  const percent = status?.download && status.download.totalBytes > 0 ? Math.max(0, Math.min(100, status.download.percent)) : null

  return (
    <>
      <section className={screen.card}>
        <h2 className={screen.cardTitle}>{t('updates.title')}</h2>
        <p className={screen.subtitle}>{t('updates.subtitle')}</p>

        <dl className={styles.grid}>
          <dt className={styles.term}>{t('updates.currentVersion')}</dt>
          <dd className={`${styles.value} mono selectable`}>{versionLabel}</dd>
          <dt className={styles.term}>{t('updates.account')}</dt>
          <dd className={styles.value}>{connected ? status?.githubAccount : t('updates.notConnected')}</dd>
          <dt className={styles.term}>{t('updates.lastCheck')}</dt>
          <dd className={styles.value}>{checkedAt}</dd>
          <dt className={styles.term}>{t('updates.state')}</dt>
          <dd className={styles.value}>
            <span className={styles.phase} data-phase={status?.phase ?? 'idle'}>
              {t(PHASE_KEY[status?.phase ?? 'idle'])}
            </span>
          </dd>
        </dl>

        {status?.message ? (
          <p className={styles.message} data-error={status.phase === 'error'}>
            {status.message}
          </p>
        ) : null}
        {error ? (
          <p className={styles.message} data-error="true" role="alert">
            {error}
          </p>
        ) : null}

        {status?.phase === 'downloading' && percent !== null ? (
          <div className={styles.progressTrack} role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
        ) : null}

        <div className={styles.actions}>
          <Button variant="primary" disabled={busy} onClick={() => void run((updates) => updates.authenticate())}>
            {t('updates.connectAndCheck')}
          </Button>
          <Button disabled={busy || !connected} onClick={() => void run((updates) => updates.check())}>
            {t('updates.check')}
          </Button>
          <Button disabled={busy || !status?.canDownload} onClick={() => void run((updates) => updates.download())}>
            {t('updates.download')}
          </Button>
          <Button disabled={busy || !status?.canInstall} onClick={() => void run((updates) => updates.install())}>
            {t('updates.installAndRestart')}
          </Button>
          {authenticating ? (
            <Button variant="danger" onClick={() => void run((updates) => updates.cancelAuthentication())}>
              {t('updates.cancelConnection')}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            disabled={!status?.release}
            onClick={() => {
              void window.api.updates.openRelease()
            }}
          >
            {t('updates.openRelease')}
          </Button>
        </div>

        {status?.release?.notes ? (
          <details className={styles.notes}>
            <summary className={styles.notesSummary}>{t('updates.releaseNotes', { version: status.release.version })}</summary>
            <div className={`${styles.notesBody} selectable`}>{status.release.notes}</div>
          </details>
        ) : null}

        <Switch
          checked={status?.preferences.autoCheck ?? true}
          disabled={busy || !status}
          label={t('updates.autoCheck')}
          hint={t('updates.autoCheckHint')}
          onChange={(checked) => void run((updates) => updates.savePreferences({ autoCheck: checked }))}
        />
      </section>

      <section className={screen.card}>
        <h2 className={screen.cardTitle}>{t('about.title')}</h2>
        <div className={screen.field}>
          <span className={screen.fieldTexts}>
            <span className={screen.fieldLabel}>{t('about.notices')}</span>
            <span className={screen.fieldHint}>{t('about.noticesHint')}</span>
          </span>
          <Button onClick={() => void openNotices()}>{t('about.open')}</Button>
        </div>
      </section>

      <Modal open={noticesOpen} size="lg" title={t('about.notices')} onClose={() => setNoticesOpen(false)}>
        <div className={`${styles.notices} selectable`}>{notices ?? t('about.loading')}</div>
      </Modal>
    </>
  )
}
