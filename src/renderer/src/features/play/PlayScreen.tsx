import { useTranslation } from 'react-i18next'
import { EmptyState } from '../../components/EmptyState'
import styles from '../Screen.module.css'

/** Placeholder until Task 10 brings the board, the opponent card and the eval bar. */
export function PlayScreen(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <p className="eyebrow">{t('rail.play')}</p>
        <h1 className={styles.title}>{t('play.title')}</h1>
      </header>
      <EmptyState title={t('play.title')} body={t('play.body')} />
    </div>
  )
}
