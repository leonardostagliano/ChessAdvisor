import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { OpeningStat } from '@shared/types/profile'
import { cx } from '../../components/ui/cx'
import styles from './Progress.module.css'

/**
 * One row per opening the user has played (spec §6.6, §6.9): code, name, games, the W/D/L record
 * and the accuracy of the first ten plies, which is the number that says whether the opening is
 * actually understood or only reached.
 *
 * Sorting is client-side and announced with `aria-sort` on the header cell; the arrow beside the
 * label repeats it for anyone who sees the table rather than hears it.
 */

export type OpeningSortKey = 'eco' | 'name' | 'games' | 'record' | 'accuracy'
export type SortDirection = 'asc' | 'desc'

/** Points of the record, so "won more" beats "played more" when the two are compared. */
const score = (row: OpeningStat): number => row.wins + row.draws * 0.5

const text = (value: string): string => value.toLocaleLowerCase()

export function sortOpenings(
  rows: readonly OpeningStat[],
  key: OpeningSortKey,
  direction: SortDirection
): OpeningStat[] {
  const sign = direction === 'asc' ? 1 : -1
  const compare = (a: OpeningStat, b: OpeningStat): number => {
    switch (key) {
      case 'eco':
        return text(a.eco).localeCompare(text(b.eco))
      case 'name':
        return text(a.name).localeCompare(text(b.name))
      case 'games':
        return a.games - b.games
      case 'record':
        return score(a) - score(b)
      case 'accuracy':
        return a.avgAccuracyFirst10 - b.avgAccuracyFirst10
    }
  }
  // A stable tie-break keeps the table from reshuffling between renders.
  return [...rows].sort((a, b) => sign * compare(a, b) || text(a.eco).localeCompare(text(b.eco)))
}

const COLUMNS: { key: OpeningSortKey; label: string; numeric: boolean; initial: SortDirection }[] =
  [
    { key: 'eco', label: 'progress.columnEco', numeric: false, initial: 'asc' },
    { key: 'name', label: 'progress.columnName', numeric: false, initial: 'asc' },
    { key: 'games', label: 'progress.columnGames', numeric: true, initial: 'desc' },
    { key: 'record', label: 'progress.columnRecord', numeric: true, initial: 'desc' },
    { key: 'accuracy', label: 'progress.columnAccuracy', numeric: true, initial: 'desc' }
  ]

export interface OpeningsTableProps {
  openings: Record<string, OpeningStat> | undefined
  className?: string
}

export function OpeningsTable({ openings, className }: OpeningsTableProps): React.JSX.Element {
  const { t } = useTranslation()
  const [sort, setSort] = useState<{ key: OpeningSortKey; direction: SortDirection }>({
    key: 'games',
    direction: 'desc'
  })
  const rows = sortOpenings(Object.values(openings ?? {}), sort.key, sort.direction)

  const toggle = (key: OpeningSortKey, initial: SortDirection): void =>
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: initial }
    )

  return (
    <section className={cx(styles.card, className)} aria-label={t('progress.openings')}>
      <header className={styles.cardHead}>
        <h3 className={styles.cardTitle}>{t('progress.openings')}</h3>
        <span className={styles.note}>{t('progress.openingsHint')}</span>
      </header>

      {rows.length === 0 ? (
        <p className={styles.note}>{t('progress.openingsEmpty')}</p>
      ) : (
        <div className={styles.tableScroll}>
          <table className={styles.table} data-testid="openings-table">
            <thead>
              <tr>
                {COLUMNS.map((column) => {
                  const active = sort.key === column.key
                  const label = t(column.label)
                  return (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={
                        active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'
                      }
                    >
                      <button
                        type="button"
                        className={cx(styles.sort, active && styles.sortActive)}
                        onClick={() => toggle(column.key, column.initial)}
                        title={t('progress.sortBy', { column: label })}
                      >
                        {label}
                        <span className={styles.sortArrow} aria-hidden="true">
                          {active ? (sort.direction === 'asc' ? '▲' : '▼') : '·'}
                        </span>
                      </button>
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={`${row.eco}-${row.name}`} data-eco={row.eco}>
                  <td className="mono">{row.eco}</td>
                  <td className={styles.openingName}>{row.name}</td>
                  <td className={styles.numeric}>{row.games}</td>
                  <td className={styles.numeric}>
                    <span
                      title={t('progress.recordAria', {
                        wins: row.wins,
                        draws: row.draws,
                        losses: row.losses
                      })}
                    >
                      {t('progress.recordValue', {
                        wins: row.wins,
                        draws: row.draws,
                        losses: row.losses
                      })}
                    </span>
                  </td>
                  <td className={styles.numeric}>
                    {t('progress.percentValue', { value: row.avgAccuracyFirst10.toFixed(1) })}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
