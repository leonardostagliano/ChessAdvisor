import { useTranslation } from 'react-i18next'
import { EmptyState } from '../../components/EmptyState'
import styles from '../Screen.module.css'

export function TrainingScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <p className="eyebrow">{t('rail.training')}</p>
        <h1 className={styles.title}>{t('empty.training.title')}</h1>
      </header>
      <EmptyState
        title={t('empty.training.title')}
        body={t('empty.training.body')}
        action={t('empty.training.action')}
        disabled
        note={t('empty.note')}
      />
    </div>
  )
}
