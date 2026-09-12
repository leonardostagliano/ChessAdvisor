import { useTranslation } from 'react-i18next'
import { EmptyState } from '../../components/EmptyState'
import styles from '../Screen.module.css'

export function ProgressScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <p className="eyebrow">{t('rail.progress')}</p>
        <h1 className={styles.title}>{t('empty.progress.title')}</h1>
      </header>
      <EmptyState
        title={t('empty.progress.title')}
        body={t('empty.progress.body')}
        action={t('empty.progress.action')}
        disabled
        note={t('empty.note')}
      />
    </div>
  )
}
