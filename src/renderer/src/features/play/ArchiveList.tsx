import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseIpcError } from '@shared/ipcError'
import type { GameSummary } from '@shared/types/game'
import type { SessionState } from '@shared/types/session'
import { Button } from '../../components/ui/Button'
import { Modal } from '../../components/ui/Modal'
import { Select, type SelectOption } from '../../components/ui/Select'
import { cx } from '../../components/ui/cx'
import { defaultModel, useCodexStore } from '../../stores/codexStore'
import { useGameStore } from '../../stores/gameStore'
import styles from './PlayScreen.module.css'

/**
 * The archive inside Gioca (spec §4.3): resume an interrupted game, or delete one.
 *
 * Resuming goes straight through the bridge instead of the store action because the failure the
 * screen has to react to is a *code*: `MODEL_UNAVAILABLE` carries, in the structured payload of
 * the rejection, the model the main process suggests — that is what prefills the substitution
 * dialog, so no string is ever scraped for a decision.
 */

export interface ArchiveListProps {
  /** Called once a game has been resumed, so the caller can switch back to the board. */
  onResumed?(state: SessionState): void
}

interface Substitution {
  gameId: string
  missing: string
  chosen: string
}

function bridge(): Window['api'] | undefined {
  return typeof window === 'undefined' ? undefined : window.api
}

export function ArchiveList({ onResumed }: ArchiveListProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const models = useCodexStore((state) => state.models)
  const [games, setGames] = useState<GameSummary[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<GameSummary | null>(null)
  const [substitution, setSubstitution] = useState<Substitution | null>(null)

  const reload = useCallback(async (): Promise<void> => {
    const api = bridge()
    if (!api) {
      setGames([])
      return
    }
    try {
      setGames(await api.games.list())
    } catch (failure) {
      setGames([])
      setError(parseIpcError(failure).message)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const resume = useCallback(
    async (id: string, substituteModel?: string): Promise<void> => {
      const api = bridge()
      if (!api) return
      setBusyId(id)
      setError(null)
      try {
        const state = await api.game.resume(id, substituteModel ? { substituteModel } : undefined)
        useGameStore.getState().apply(state)
        setSubstitution(null)
        onResumed?.(state)
      } catch (failure) {
        const { code, message, data } = parseIpcError(failure)
        if (code === 'MODEL_UNAVAILABLE') {
          const suggested = typeof data.suggested === 'string' ? data.suggested : (defaultModel(models)?.id ?? '')
          const game = games?.find((entry) => entry.id === id)
          setSubstitution({ gameId: id, missing: game?.opponent.model ?? '', chosen: suggested })
          return
        }
        setError(message.length > 0 ? message : t('archive.failed'))
      } finally {
        setBusyId(null)
      }
    },
    [games, models, onResumed, t]
  )

  const remove = useCallback(
    async (id: string): Promise<void> => {
      const api = bridge()
      if (!api) return
      setBusyId(id)
      try {
        await api.games.delete(id)
        await reload()
      } catch (failure) {
        setError(parseIpcError(failure).message)
      } finally {
        setBusyId(null)
        setConfirmDelete(null)
      }
    },
    [reload]
  )

  const modelOptions: SelectOption[] = models.map((model) => ({
    value: model.id,
    label: model.displayName,
    hint: model.description
  }))

  return (
    <section className={styles.archive} aria-label={t('archive.title')}>
      <header className={styles.archiveHead}>
        <h2 className={styles.panelTitle}>{t('archive.title')}</h2>
        <p className={styles.archiveSubtitle}>{t('archive.subtitle')}</p>
      </header>

      {error ? (
        <p className={styles.archiveError} role="alert">
          {error}
        </p>
      ) : null}

      {games === null ? <p className={styles.panelEmpty}>{t('archive.loading')}</p> : null}
      {games !== null && games.length === 0 ? <p className={styles.panelEmpty}>{t('archive.empty')}</p> : null}

      <ul className={styles.archiveRows}>
        {(games ?? []).map((game) => {
          const inProgress = game.status === 'in_progress'
          return (
            <li key={game.id} className={styles.archiveRow}>
              <div className={styles.archiveTexts}>
                <span className={styles.archiveTitle}>
                  {t('archive.against', { model: game.opponent.model })}
                  {game.opponent.substitutedFrom ? (
                    <span className={styles.archiveMuted}>
                      {` ${t('archive.substitutedFrom', { model: game.opponent.substitutedFrom })}`}
                    </span>
                  ) : null}
                </span>
                <span className={styles.archiveMeta}>
                  <span className={cx(styles.chip, inProgress ? styles.chipAccent : undefined)}>
                    {inProgress ? t('archive.statusInProgress') : t('archive.statusFinished')}
                  </span>
                  <span>{game.userColor === 'w' ? t('archive.asWhite') : t('archive.asBlack')}</span>
                  <span>{t('archive.plies', { count: game.plies })}</span>
                  {game.result ? <span className="mono">{game.result.outcome}</span> : null}
                  <span>{new Date(game.updatedAt).toLocaleString(i18n.language)}</span>
                </span>
              </div>
              <div className={styles.archiveActions}>
                {inProgress ? (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={busyId === game.id}
                    onClick={() => void resume(game.id)}
                  >
                    {t('archive.resume')}
                  </Button>
                ) : null}
                <Button variant="danger" size="sm" disabled={busyId === game.id} onClick={() => setConfirmDelete(game)}>
                  {t('archive.delete')}
                </Button>
              </div>
            </li>
          )
        })}
      </ul>

      <Modal
        open={!!confirmDelete}
        size="sm"
        title={t('archive.deleteTitle')}
        onClose={() => setConfirmDelete(null)}
        footer={
          <div className={styles.modalActions}>
            <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" onClick={() => void remove(confirmDelete?.id ?? '')}>
              {t('archive.delete')}
            </Button>
          </div>
        }
      >
        <p>{t('archive.deleteBody')}</p>
      </Modal>

      <Modal
        open={!!substitution}
        size="sm"
        title={t('archive.substituteTitle')}
        onClose={() => setSubstitution(null)}
        footer={
          <div className={styles.modalActions}>
            <Button variant="ghost" onClick={() => setSubstitution(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={!substitution?.chosen}
              onClick={() => {
                if (substitution?.chosen) void resume(substitution.gameId, substitution.chosen)
              }}
            >
              {t('archive.substituteConfirm')}
            </Button>
          </div>
        }
      >
        <p className={styles.modalBody}>{t('archive.substituteBody', { model: substitution?.missing ?? '' })}</p>
        <Select
          value={substitution?.chosen ?? ''}
          options={modelOptions}
          onChange={(value) => setSubstitution((current) => (current ? { ...current, chosen: value } : current))}
          label={t('archive.substituteModel')}
          disabled={modelOptions.length === 0}
        />
      </Modal>
    </section>
  )
}
