import { useTranslation } from 'react-i18next'
import { Select, type SelectOption } from '../../components/ui/Select'
import { useUiStore, type Language, type ThemeChoice } from '../../stores/uiStore'
import styles from '../Screen.module.css'

/** Placeholder Settings: Task 10 adds models, Codex, engine and updates. */
export function SettingsScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const theme = useUiStore((state) => state.theme)
  const setTheme = useUiStore((state) => state.setTheme)
  const language = useUiStore((state) => state.language)
  const setLanguage = useUiStore((state) => state.setLanguage)

  const themeOptions: SelectOption<ThemeChoice>[] = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'night', label: t('settings.themeNight') },
    { value: 'editorial', label: t('settings.themeEditorial') }
  ]
  const languageOptions: SelectOption<Language>[] = [
    { value: 'it', label: t('settings.languageIt') },
    { value: 'en', label: t('settings.languageEn') }
  ]

  return (
    <div className={styles.screen}>
      <header className={styles.header}>
        <p className="eyebrow">{t('rail.settings')}</p>
        <h1 className={styles.title}>{t('settings.title')}</h1>
        <p className={styles.subtitle}>{t('settings.subtitle')}</p>
      </header>

      <section className={styles.card}>
        <h2 className={styles.cardTitle}>{t('settings.appearance')}</h2>

        <div className={styles.field}>
          <span className={styles.fieldTexts}>
            <span className={styles.fieldLabel}>{t('settings.theme')}</span>
            <span className={styles.fieldHint}>{t('settings.themeHint')}</span>
          </span>
          <Select<ThemeChoice>
            value={theme}
            options={themeOptions}
            onChange={setTheme}
            label={t('settings.theme')}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.fieldTexts}>
            <span className={styles.fieldLabel}>{t('settings.language')}</span>
            <span className={styles.fieldHint}>{t('settings.languageHint')}</span>
          </span>
          <Select<Language>
            value={language}
            options={languageOptions}
            onChange={setLanguage}
            label={t('settings.language')}
          />
        </div>
      </section>

      <p className={styles.note}>{t('settings.comingSoon')}</p>
    </div>
  )
}
