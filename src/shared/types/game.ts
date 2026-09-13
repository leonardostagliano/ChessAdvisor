import type { Language } from './settings'
import type { OpponentDifficulty } from './session'

/** Engine score of a position. Exactly one of the two is set; `mate` is in plies-to-mate, signed. */
export interface Eval {
  cp?: number
  mate?: number
}

export type MoveClassification = 'book' | 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'

/** Quality of one played move, filled by the post-game analysis pipeline (M3). Moves are UCI. */
export interface MoveEval {
  before: Eval
  after: Eval
  cpLoss: number
  winPercentLoss: number
  classification: MoveClassification
  bestMove: string
  bestLine: string[]
}

export interface Move {
  ply: number
  san: string
  uci: string
  fenAfter: string
  /** First four FEN fields of `fenAfter`: the repetition/opening key. */
  epdAfter: string
  by: 'user' | 'ai'
  /** Remaining time of both sides after the move, in ms (M2 clocks). */
  clockAfter?: { w: number; b: number }
  /** Wall time of the accepted attempt, in ms. */
  thinkingMs?: number
  /** Wall time burned by the attempts that had to be retried, in ms. */
  thinkingOverheadMs?: number
  /** Model that actually answered, when the app-server rerouted the request. */
  effectiveModel?: string
  /** Set when the move did not come from the model at all. */
  fallback?: 'engine' | 'random'
  aiShortComment?: string
  eval?: MoveEval
  /** Key from the fixed taxonomy (spec §6.2). */
  theme?: string
  coachComment?: string
  coachCommentLanguage?: Language
}

export type CoachLogKind = 'question' | 'answer' | 'hint' | 'comment'

export interface CoachLogEntry {
  id: string
  ply: number
  kind: CoachLogKind
  text: string
  move?: string
  language: Language
  createdAt: string
}

export type GameOutcome = '1-0' | '0-1' | '1/2-1/2'
export type GameEndReason = 'checkmate' | 'stalemate' | 'resign' | 'draw_agreed' | 'repetition' | 'fifty' | 'insufficient' | 'timeout'

export interface GameResult {
  outcome: GameOutcome
  reason: GameEndReason
}

export interface GameAnalysis {
  accuracy: { w: number; b: number }
  acpl: { w: number; b: number }
  /** Plies worth reviewing, as indices into `Game.moves`. */
  keyMoments: number[]
  lesson?: { takeaways: string[]; summary: string; language: Language }
  analyzedAt: string
}

export interface GameOpening {
  eco: string
  name: string
  lastBookPly: number
}

export interface GameClock {
  initialMs: number
  incrementMs: number
  aiClock: boolean
  remainingMs: { w: number; b: number }
}

export interface GameOpponent {
  model: string
  effort: string
  /** Resolved when the game starts; level 6 (Massimo) has `targetElo: null` (spec §4.1). */
  difficulty: OpponentDifficulty
  /** Model originally chosen, when the user accepted a substitution on resume. */
  substitutedFrom?: string
}

export interface Game {
  id: string
  createdAt: string
  updatedAt: string
  kind: 'match' | 'endgame_drill'
  status: 'in_progress' | 'finished'
  userColor: 'w' | 'b'
  opponent: GameOpponent
  coach: { model: string; effort: string }
  /** null until M2 adds clocks. Times are milliseconds. */
  clock: GameClock | null
  language: Language
  /** Set for endgame drills and study positions; absent means the standard start. */
  startFen?: string
  moves: Move[]
  takebacks: number
  coachLog: CoachLogEntry[]
  result?: GameResult
  analysis?: GameAnalysis
  opening?: GameOpening
}

/** Row of the archive list: everything the list needs without reading the whole game. */
export type GameSummary = Pick<Game, 'id' | 'createdAt' | 'updatedAt' | 'kind' | 'status' | 'userColor' | 'opponent' | 'result' | 'opening'> & {
  plies: number
  accuracy?: { w: number; b: number }
}

export interface GameFilter {
  status?: Game['status']
  kind?: Game['kind']
}
