/**
 * The fixed taxonomy of spec §6.2.
 *
 * It is the only vocabulary the app uses for a theme: the labelling call (spec §6.3), the theme
 * counters of the profile, the thematic sets and the study plan of M5 all speak it. Whatever the
 * model answers is squeezed back into it by {@link normalizeTheme} — a theme outside the taxonomy
 * becomes `missed_tactic`, never a new key.
 */
export const THEMES = [
  'fork',
  'pin',
  'skewer',
  'hanging_piece',
  'back_rank',
  'discovered_attack',
  'overloaded_piece',
  'king_safety',
  'pawn_structure',
  'opening_principles',
  'development',
  'center_control',
  'endgame_technique',
  'piece_activity',
  'trade_evaluation',
  'time_pressure',
  'calculation_error',
  'missed_tactic'
] as const

export type Theme = (typeof THEMES)[number]

/** Where everything unknown lands (spec §6.3). */
export const FALLBACK_THEME: Theme = 'missed_tactic'

const KNOWN = new Set<string>(THEMES)

/**
 * Spellings seen in the wild that mean one of our themes: the lichess puzzle vocabulary (reused
 * by M5's dataset) and the plain-English wording a model falls into when it forgets the enum.
 */
const ALIASES: Record<string, Theme> = {
  hangingpiece: 'hanging_piece',
  hanging: 'hanging_piece',
  backrank: 'back_rank',
  backrankmate: 'back_rank',
  discoveredattack: 'discovered_attack',
  discovery: 'discovered_attack',
  doubleattack: 'fork',
  overloading: 'overloaded_piece',
  overloadedpiece: 'overloaded_piece',
  deflection: 'overloaded_piece',
  kingsafety: 'king_safety',
  exposedking: 'king_safety',
  pawnstructure: 'pawn_structure',
  openingprinciples: 'opening_principles',
  opening: 'opening_principles',
  centercontrol: 'center_control',
  centrecontrol: 'center_control',
  endgame: 'endgame_technique',
  endgametechnique: 'endgame_technique',
  pieceactivity: 'piece_activity',
  activity: 'piece_activity',
  tradeevaluation: 'trade_evaluation',
  exchange: 'trade_evaluation',
  timepressure: 'time_pressure',
  timetrouble: 'time_pressure',
  calculationerror: 'calculation_error',
  calculation: 'calculation_error',
  blunder: 'calculation_error',
  missedtactic: 'missed_tactic',
  tactics: 'missed_tactic'
}

/**
 * The taxonomy key for whatever the model answered: the key itself, a known spelling of it, or
 * {@link FALLBACK_THEME}. Case, spaces, dashes and camelCase are all accepted on the way in.
 */
export function normalizeTheme(raw: unknown): Theme {
  if (typeof raw !== 'string') return FALLBACK_THEME
  const trimmed = raw.trim().toLowerCase()
  if (trimmed.length === 0) return FALLBACK_THEME

  const snake = trimmed.replace(/[\s-]+/g, '_').replace(/[^a-z_]/g, '')
  if (KNOWN.has(snake)) return snake as Theme

  const squashed = snake.replace(/_/g, '')
  const alias = ALIASES[squashed]
  if (alias) return alias
  return FALLBACK_THEME
}
