import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en.json'
import it from './it.json'

export type Language = 'it' | 'en'

export const LANGUAGES: Language[] = ['it', 'en']

export const resources = {
  it: { translation: it },
  en: { translation: en }
} as const

export function isLanguage(value: unknown): value is Language {
  return value === 'it' || value === 'en'
}

if (!i18n.isInitialized) {
  void i18n.use(initReactI18next).init({
    resources,
    lng: 'it',
    fallbackLng: 'it',
    supportedLngs: LANGUAGES,
    interpolation: { escapeValue: false },
    returnNull: false
  })
}

export default i18n
