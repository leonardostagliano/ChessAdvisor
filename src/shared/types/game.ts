import type { Language } from './settings'
import type { OpponentDifficulty } from './session'

/** Engine score of a position. Exactly one of the two is set; `mate` is in plies-to-mate, signed. */
export interface Eval {
  cp?: number
  mate?: number
}

export type MoveClassification =
  'book' | 'best' | 'excellent' | 'good' | 'inaccuracy' | 'mistake' | 'blunder'

/**
 * Quality of one played move, filled by the post-game analysis pipeline (M3). Moves are UCI.
 *
 * PERSPECTIVE: `before` and `after` are from the point of view of the player who made the move —
 * positive always means "the mover stood well" — so a reader that needs White's perspective (the
 * evaluation graph of the review, for instance) flips the sign on Black's plies. `cpLoss` is in
 * internal centipawns (a mate counts as `sign × (10000 − |mate|)`) and `winPercentLoss` in points
 * of winning chance, both of them the mover's own loss and never negative.
 */
export interface MoveEval {
  before: Eval
  after: Eval
  cpLoss: number
  winPercentLoss: number
  classification: MoveClassification
  bestMove: string
  bestLine: string[]
}

/** A coach card for the position immediately after its Move. Older saves retain coachComment. */
export interface CoachAnnotation {
  square: string
  label: string
  kind: 'focus' | 'threat'
  from?: string
}

export interface CoachEvidenceLine {
  kind: 'best' | 'reply'
  startFen: string
  moves: { san: string; uci: string; fenAfter: string }[]
  evaluation?: Eval
}

export interface CoachEvidence {
  source: 'live' | 'review' | 'engine'
  /** Scores in this record are always from White's point of view. */
  perspective: 'white'
  evalBefore?: Eval
  evalAfter?: Eval
  lines: CoachEvidenceLine[]
}

export interface CoachExplanation {
  version: 1
  headline: string
  explanation: string
  priority?: string
  question?: string
  hints: string[]
  takeaway?: string
  /** Suggestions checked against Move.fenAfter before they are persisted. */
  annotations: CoachAnnotation[]
  /** Engine material is attached by the app, never accepted from model output. */
  evidence?: CoachEvidence
}

export interface Move {
  ply: number
  san: string
  uci: string
  fenAfter: string
  /** First four FEN fields of `fenAfter`: the repetition/opening key. */
  epdAfter: string
  by: 'user' | 'ai'
  /** Remaining time of both sides once the move was committed and the increment credited, in ms. */
  clockAfter?: { w: number; b: number }
  /** Wall time of the accepted attempt, in ms. */
  thinkingMs?: number
  /** Wall time burned by the attempts that had to be retried, in ms. */
  thinkingOverheadMs?: number
  /** Model that actually answered, when the app-server rerouted the request. */
  effectiveModel?: string
  /** Set when the move did not come from the model at all. */
  fallback?: 'engine' | 'random'
  /** Whether calculated continuations grounded and checked the opponent's choice. */
  engineAssisted?: boolean
  engineVerified?: boolean
  aiShortComment?: string
  eval?: MoveEval
  /** Fast local estimate; the deeper post-game review remains authoritative. */
  liveEval?: MoveEval & { depth: number; assessedAt: string }
  liveEvalStatus?: 'pending' | 'unavailable'
  /** Key from the fixed taxonomy (spec §6.2). */
  theme?: string
  coachComment?: string
  coachExplanation?: CoachExplanation
  coachCommentLanguage?: Language
}

export type CoachLogKind = 'question' | 'answer' | 'hint' | 'comment'

export interface CoachLogEntry {
  id: string
  ply: number
  kind: CoachLogKind
  text: string
  /** Board position at the time of an answer or hint. */
  fen?: string
  coachExplanation?: CoachExplanation
  move?: string
  language: Language
  createdAt: string
}

export type GameOutcome = '1-0' | '0-1' | '1/2-1/2'
export type GameEndReason =
  | 'checkmate'
  | 'stalemate'
  | 'resign'
  | 'draw_agreed'
  | 'repetition'
  | 'fifty'
  | 'insufficient'
  | 'timeout'

export interface GameResult {
  outcome: GameOutcome
  reason: GameEndReason
}

export interface GameAnalysis {
  /** Percentage per colour, one decimal (spec §3.1, rule 6). */
  accuracy: { w: number; b: number }
  /** Average centipawn loss per colour, rounded (rule 7). */
  acpl: { w: number; b: number }
  /** Plies worth reviewing: the user's own mistakes and blunders, 1-based as `Move.ply`. */
  keyMoments: number[]
  lesson?: { takeaways: string[]; summary: string; language: Language }
  analyzedAt: string
}

export interface GameOpening {
  eco: string
  name: string
  lastBookPly: number
}

/**
 * Clocks of a game as they are persisted (spec §4.3). `remainingMs` is the last settled value the
 * main process wrote: the live one travels in `SessionState.clock`.
 */
export interface GameClock {
  initialMs: number
  incrementMs: number
  /** False in "Solo il mio tempo": the opponent has no clock at all. */
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
  /** `null` when the game is played with no clock (the default). Times are milliseconds. */
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
export type GameSummary = Pick<
  Game,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'kind'
  | 'status'
  | 'userColor'
  | 'opponent'
  | 'result'
  | 'opening'
> & {
  plies: number
  accuracy?: { w: number; b: number }
}

export interface GameFilter {
  status?: Game['status']
  kind?: Game['kind']
}
