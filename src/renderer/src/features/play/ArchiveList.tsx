import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { parseIpcError } from '@shared/ipcError'
import type { GameSummary } from '@shared/types/game'
import type { SessionState } from '@shared/types/session'
import { Button } from '../../components/ui/Button'
import { EmptyState } from '../../components/EmptyState'
import { Modal } from '../../components/ui/Modal'
import { Select, type SelectOption } from '../../components/ui/Select'
import { cx } from '../../components/ui/cx'
import { defaultModel, useCodexStore } from '../../stores/codexStore'
import { useGameStore } from '../../stores/gameStore'
import styles from './PlayScreen.module.css'

/**
 * The archive inside Gioca (spec §4.3, §4.4): filter the saved games, resume an interrupted one,
 * open the review of a finished one, or delete one.
 *
 * Resuming goes straight through the bridge instead of the store action because the failure the
 * screen has to react to is a *code*: `MODEL_UNAVAILABLE` carries, in the structured payload of
 * the rejection, the model the main process suggests — that is what prefills the substitution
 * dialog, so no string is ever scraped for a decision.
 */

export interface ArchiveListProps {
  /** Called once a game has been resumed, so the caller can switch back to the board. */
  onResumed?(state: SessionState): void
  /** Opens the post-game review of a finished game (spec §4.4). */
  onReview?(gameId: string): void
  /** Primary action of the empty archive: opens the new-game dialog of the play area. */
  onNewGame?(): void
}

export type ResultFilter = 'all' | 'win' | 'loss' | 'draw' | 'unfinished'
export type ColorFilter = 'all' | 'w' | 'b'
export type KindFilter = 'all' | 'match' | 'endgame_drill'
export type DateFilter = 'all' | 'week' | 'month' | 'year'

/** The five filters of spec §4.4: result, colour, effective model, kind, date. */
export interface ArchiveFilters {
  result: ResultFilter
  color: ColorFilter
  /** `all`, or the model that actually played the game. */
  model: string
  kind: KindFilter
  date: DateFilter
}

export const NO_FILTERS: ArchiveFilters = {
  result: 'all',
  color: 'all',
  model: 'all',
  kind: 'all',
  date: 'all'
}

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOWS: Record<Exclude<DateFilter, 'all'>, number> = {
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  year: 365 * DAY_MS
}

/** Outcome of a finished game from the user's point of view. */
function outcomeOf(game: GameSummary): Exclude<ResultFilter, 'all' | 'unfinished'> | null {
  if (!game.result) return null
  if (game.result.outcome === '1/2-1/2') return 'draw'
  return (game.result.outcome === '1-0' ? 'w' : 'b') === game.userColor ? 'win' : 'loss'
}

/** Rows kept by the filters, in the order the main process listed them (newest first). */
export function filterGames(
  games: GameSummary[],
  filters: ArchiveFilters,
  now = Date.now()
): GameSummary[] {
  return games.filter((game) => {
    if (
      filters.result === 'unfinished'
        ? !!game.result
        : filters.result !== 'all' && outcomeOf(game) !== filters.result
    )
      return false
    if (filters.color !== 'all' && game.userColor !== filters.color) return false
    if (filters.model !== 'all' && game.opponent.model !== filters.model) return false
    if (filters.kind !== 'all' && game.kind !== filters.kind) return false
    if (filters.date !== 'all') {
      const at = Date.parse(game.updatedAt)
      if (!Number.isFinite(at) || now - at > WINDOWS[filters.date]) return false
    }
    return true
  })
}

interface Substitution {
  gameId: string
  missing: string
  chosen: string
}

function bridge(): Window['api'] | undefined {
  return typeof window === 'undefined' ? undefined : window.api
}

export function ArchiveList({
  onResumed,
  onReview,
  onNewGame
}: ArchiveListProps): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const models = useCodexStore((state) => state.models)
  const [games, setGames] = useState<GameSummary[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<GameSummary | null>(null)
  const [substitution, setSubstitution] = useState<Substitution | null>(null)
  const [filters, setFilters] = useState<ArchiveFilters>(NO_FILTERS)

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
          const suggested =
            typeof data.suggested === 'string' ? data.suggested : (defaultModel(models)?.id ?? '')
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
        useGameStore.getState().discardDeletedGame(id)
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

  // The model filter offers exactly the models the archive contains: a catalogue entry nobody
  // ever played against would only produce an empty list.
  const playedModels = useMemo(
    () => [...new Set((games ?? []).map((game) => game.opponent.model))].sort(),
    [games]
  )
  const visible = useMemo(() => filterGames(games ?? [], filters), [games, filters])
  const filtered = (games ?? []).length > 0 && visible.length === 0

  const option = (value: string, label: string): SelectOption => ({ value, label })
  const filterSelects: { key: keyof ArchiveFilters; label: string; options: SelectOption[] }[] = [
    {
      key: 'result',
      label: t('archive.filterResult'),
      options: [
        option('all', t('archive.all')),
        option('win', t('archive.resultWin')),
        option('loss', t('archive.resultLoss')),
        option('draw', t('archive.resultDraw')),
        option('unfinished', t('archive.resultUnfinished'))
      ]
    },
    {
      key: 'color',
      label: t('archive.filterColor'),
      options: [
        option('all', t('archive.all')),
        option('w', t('newGame.white')),
        option('b', t('newGame.black'))
      ]
    },
    {
      key: 'model',
      label: t('archive.filterModel'),
      options: [
        option('all', t('archive.all')),
        ...playedModels.map((model) => option(model, model))
      ]
    },
    {
      key: 'kind',
      label: t('archive.filterKind'),
      options: [
        option('all', t('archive.all')),
        option('match', t('archive.kindMatch')),
        option('endgame_drill', t('archive.kindDrill'))
      ]
    },
    {
      key: 'date',
      label: t('archive.filterDate'),
      options: [
        option('all', t('archive.all')),
        option('week', t('archive.dateWeek')),
        option('month', t('archive.dateMonth')),
        option('year', t('archive.dateYear'))
      ]
    }
  ]

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

      {games !== null && games.length > 0 ? (
        <div className={styles.archiveFilters} role="group" aria-label={t('archive.filters')}>
          {filterSelects.map((entry) => (
            <div key={entry.key} className={styles.archiveFilter}>
              <span className={styles.archiveFilterLabel}>{entry.label}</span>
              <Select
                value={filters[entry.key]}
                options={entry.options}
                label={entry.label}
                onChange={(value) => setFilters((current) => ({ ...current, [entry.key]: value }))}
              />
            </div>
          ))}
        </div>
      ) : null}

      {games === null ? <p className={styles.panelEmpty}>{t('archive.loading')}</p> : null}
      {games !== null && games.length === 0 ? (
        <EmptyState
          eyebrow={t('archive.title')}
          title={t('archive.emptyTitle')}
          body={t('archive.emptyBody')}
          {...(onNewGame ? { action: t('controls.newGame'), onAction: onNewGame } : {})}
        />
      ) : null}
      {filtered ? (
        <EmptyState
          eyebrow={t('archive.filters')}
          title={t('archive.noMatchTitle')}
          body={t('archive.noMatchBody')}
          action={t('archive.clearFilters')}
          onAction={() => setFilters(NO_FILTERS)}
        />
      ) : null}

      <ul className={styles.archiveRows}>
        {visible.map((game) => {
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
                  <span>
                    {game.userColor === 'w' ? t('archive.asWhite') : t('archive.asBlack')}
                  </span>
                  <span>{t('archive.plies', { count: game.plies })}</span>
                  {game.result ? <span className="mono">{game.result.outcome}</span> : null}
                  {game.accuracy ? (
                    <span className="mono">
                      {t('archive.accuracy', {
                        value: (game.userColor === 'w' ? game.accuracy.w : game.accuracy.b).toFixed(
                          1
                        )
                      })}
                    </span>
                  ) : null}
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
                ) : onReview ? (
                  <Button variant="primary" size="sm" onClick={() => onReview(game.id)}>
                    {t('archive.review')}
                  </Button>
                ) : null}
                <Button
                  variant="danger"
                  size="sm"
                  disabled={busyId === game.id}
                  onClick={() => setConfirmDelete(game)}
                >
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
        <p className={styles.modalBody}>
          {t('archive.substituteBody', { model: substitution?.missing ?? '' })}
        </p>
        <Select
          value={substitution?.chosen ?? ''}
          options={modelOptions}
          onChange={(value) =>
            setSubstitution((current) => (current ? { ...current, chosen: value } : current))
          }
          label={t('archive.substituteModel')}
          disabled={modelOptions.length === 0}
        />
      </Modal>
    </section>
  )
}
