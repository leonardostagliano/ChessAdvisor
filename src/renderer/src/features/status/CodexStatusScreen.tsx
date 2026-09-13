import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { CodexState } from '@shared/types/codex'
import { Button } from '../../components/ui/Button'
import { useCodexStore } from '../../stores/codexStore'
import styles from './CodexStatusScreen.module.css'

/**
 * Full-screen guidance for every Codex state that is not `ready` (spec §8).
 *
 * The app never installs or logs into anything on the user's behalf: each state explains what is
 * missing and gives the one action that fixes it — the paths that were searched, the `codex
 * login` command to copy, or the choice to accept a non-isolated environment for this run.
 */

export interface CodexStatusScreenProps {
  /** Defaults to the mirrored `codex:state`; passing one keeps the screen pure for previews. */
  state?: CodexState
  onRetry?(): void
  onContinueAnyway?(): void
}

const CODEX_DOCS = 'https://developers.openai.com/codex/cli/'

export function CodexStatusScreen({ state, onRetry, onContinueAnyway }: CodexStatusScreenProps): React.JSX.Element {
  const { t } = useTranslation()
  const mirrored = useCodexStore((store) => store.state)
  const retryStore = useCodexStore((store) => store.retry)
  const continueStore = useCodexStore((store) => store.continueAnyway)
  const current = state ?? mirrored

  const retry = useCallback((): void => {
    if (onRetry) onRetry()
    else void retryStore()
  }, [onRetry, retryStore])

  const retryButton = (
    <Button variant="primary" onClick={retry}>
      {t('codexStatus.retry')}
    </Button>
  )

  return (
    <div className={styles.screen}>
      <section className={styles.card}>
        <p className="eyebrow">{t('codexStatus.eyebrow')}</p>
        {current.status === 'starting' ? (
          <>
            <h1 className={styles.title}>{t('codexStatus.starting.title')}</h1>
            <p className={styles.body}>{t('codexStatus.starting.body')}</p>
            <div className={styles.actions}>
              <span className={styles.spinner} role="status" aria-label={t('codexStatus.starting.title')} />
            </div>
          </>
        ) : null}

        {current.status === 'not-installed' ? (
          <>
            <h1 className={styles.title}>{t('codexStatus.notInstalled.title')}</h1>
            <p className={styles.body}>{t('codexStatus.notInstalled.body')}</p>
            <ul className={styles.paths}>
              {current.searched.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
            <div className={styles.actions}>
              {retryButton}
              <Button
                variant="ghost"
                onClick={() => void window.api?.app.openExternal(CODEX_DOCS)}
              >
                {t('codexStatus.notInstalled.download')}
              </Button>
            </div>
          </>
        ) : null}

        {current.status === 'not-authenticated' ? (
          <>
            <h1 className={styles.title}>{t('codexStatus.notAuthenticated.title')}</h1>
            <p className={styles.body}>{t('codexStatus.notAuthenticated.body')}</p>
            <CopyableCommand command={t('codexStatus.notAuthenticated.command')} />
            <div className={styles.actions}>{retryButton}</div>
          </>
        ) : null}

        {current.status === 'not-isolated' ? (
          <>
            <h1 className={styles.title}>{t('codexStatus.notIsolated.title')}</h1>
            <p className={styles.body}>{t('codexStatus.notIsolated.body')}</p>
            <p className="eyebrow">{t('codexStatus.notIsolated.problems')}</p>
            <ul className={styles.problems}>
              {current.problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
            <div className={styles.actions}>
              {retryButton}
              <Button
                variant="secondary"
                onClick={() => {
                  if (onContinueAnyway) onContinueAnyway()
                  else continueStore()
                }}
              >
                {t('codexStatus.notIsolated.continueAnyway')}
              </Button>
            </div>
          </>
        ) : null}

        {current.status === 'crashed' ? (
          <>
            <h1 className={styles.title}>{t('codexStatus.crashed.title')}</h1>
            <p className={styles.body}>{t('codexStatus.crashed.body')}</p>
            {current.message ? <p className={styles.message}>{current.message}</p> : null}
            <div className={styles.actions}>{retryButton}</div>
          </>
        ) : null}
      </section>
    </div>
  )
}

/** `codex login` with a copy button; the text stays selectable for a manual copy too. */
function CopyableCommand({ command }: { command: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async (): Promise<void> => {
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (typeof clipboard?.writeText !== 'function') return
    try {
      await clipboard.writeText(command)
      setCopied(true)
    } catch {
      /* a hardened clipboard: the command is selectable, so nothing is lost */
    }
  }

  return (
    <div className={styles.command}>
      <code className={`${styles.commandText} selectable`}>{command}</code>
      <div className={styles.actions}>
        {copied ? <span className={styles.copied}>{t('codexStatus.notAuthenticated.copied')}</span> : null}
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {t('codexStatus.notAuthenticated.copy')}
        </Button>
      </div>
    </div>
  )
}
