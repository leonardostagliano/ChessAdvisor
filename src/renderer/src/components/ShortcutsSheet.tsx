import { useTranslation } from 'react-i18next'
import { Button } from './ui/Button'
import { Modal } from './ui/Modal'
import styles from './ShortcutsSheet.module.css'

/**
 * The shortcuts sheet (task T22 item 4), opened with `?` from anywhere and closed like every
 * other dialog, with Esc or the close button.
 *
 * Each row names the keys and what they do; the keys themselves are not translated, only what
 * they do is.
 */

/** One row of the sheet: the keys, then the action they perform. */
export const SHORTCUTS: { keys: string[]; key: string }[] = [
  { keys: ['←', '→'], key: 'shortcuts.moves' },
  { keys: ['Home', 'End'], key: 'shortcuts.ends' },
  { keys: ['1', '2', '3', '4'], key: 'shortcuts.promotion' },
  { keys: ['Esc'], key: 'shortcuts.escape' },
  { keys: ['Tab'], key: 'shortcuts.tab' },
  { keys: ['?'], key: 'shortcuts.sheet' }
]

export interface ShortcutsSheetProps {
  open: boolean
  onClose(): void
}

export function ShortcutsSheet({ open, onClose }: ShortcutsSheetProps): React.JSX.Element {
  const { t } = useTranslation()

  return (
    <Modal
      open={open}
      size="sm"
      title={t('shortcuts.title')}
      onClose={onClose}
      footer={
        <div className={styles.footer}>
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <p className={styles.intro}>{t('shortcuts.intro')}</p>
      <dl className={styles.list}>
        {SHORTCUTS.map((entry) => (
          <div key={entry.key} className={styles.row}>
            <dt className={styles.keys}>
              {entry.keys.map((key) => (
                <kbd key={key} className={styles.key}>
                  {key}
                </kbd>
              ))}
            </dt>
            <dd className={styles.action}>{t(entry.key)}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  )
}
