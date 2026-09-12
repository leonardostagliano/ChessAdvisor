export type Language = 'it' | 'en'
export type ThemeChoice = 'night' | 'editorial' | 'system'

export interface Settings {
  language: Language
  theme: ThemeChoice
  defaultModel: string | null
  defaultEffort: string | null
  separateCoach: boolean
  coachModel: string | null
  coachEffort: string | null
  turnTimeoutSec: number
  showReasoning: boolean
  pieceSet: 'cburnett'
  engineBinary: 'avx2' | 'popcnt' | 'none' | null
  updates: { autoCheck: boolean }
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'it',
  theme: 'system',
  defaultModel: null,
  defaultEffort: null,
  separateCoach: false,
  coachModel: null,
  coachEffort: null,
  turnTimeoutSec: 180,
  showReasoning: false,
  pieceSet: 'cburnett',
  engineBinary: null,
  updates: { autoCheck: true }
}
