import { Chess } from 'chess.js'

export interface LegalMove {
  /** Standard Algebraic Notation exactly as chess.js renders it, check/mate marks included. */
  san: string
  /** Long algebraic (UCI): from + to + lowercase promotion letter. */
  uci: string
}

export type GameStatusReason = 'checkmate' | 'stalemate' | 'repetition' | 'fifty' | 'insufficient'

export interface GameStatus {
  over: boolean
  reason?: GameStatusReason
  check: boolean
}

/** chess.js throws on anything it cannot parse; every helper here answers with a neutral value instead. */
function position(fen: string): Chess | null {
  try {
    return new Chess(fen)
  } catch {
    return null
  }
}

/** Drops the decorations a SAN may carry so two spellings of the same move compare equal. */
function canonical(san: string): string {
  return san.replace(/[+#!?=]/g, '')
}

const CASTLING = /^[0oO]-?[0oO](-?[0oO])?$/
const UCI = /^([a-h][1-8])([a-h][1-8])([qrbnQRBN])?$/

/** Strips the quoting, spacing and move numbering a model tends to add around a move. */
function clean(input: string): string {
  let text = String(input ?? '').trim()
  text = text.replace(/^["'`“”‘’]+/, '').replace(/["'`“”‘’]+$/, '')
  text = text.trim()
  // "12." / "12..." in front of the move: common when the model echoes the PGN.
  text = text.replace(/^\d+\.+\s*/, '').trim()
  text = text.replace(/[.,;:]+$/, '').trim()
  if (CASTLING.test(text)) {
    const longCastle = (text.match(/[0oO]/g) ?? []).length === 3
    return longCastle ? 'O-O-O' : 'O-O'
  }
  return text
}

/** Every legal move of `fen`, sorted by SAN so prompts and tests are deterministic. */
export function legalMoves(fen: string): LegalMove[] {
  const chess = position(fen)
  if (!chess) return []
  return chess
    .moves({ verbose: true })
    .map((move) => ({ san: move.san, uci: move.lan }))
    .sort((a, b) => (a.san < b.san ? -1 : a.san > b.san ? 1 : 0))
}

/**
 * Resolves whatever a model (or the UI) wrote into the one legal move it means.
 * Accepts strict SAN, SAN with zeros for castling, UCI of 4–5 characters, a promotion
 * written without `=`, optional `+`/`#` and surrounding whitespace or quotes.
 * Returns `null` when the move is not legal in `fen`.
 */
export function normalizeMove(fen: string, input: string): LegalMove | null {
  const text = clean(input)
  if (!text) return null
  const moves = legalMoves(fen)
  if (moves.length === 0) return null

  const uciMatch = UCI.exec(text)
  if (uciMatch) {
    const uci = `${uciMatch[1]}${uciMatch[2]}${(uciMatch[3] ?? '').toLowerCase()}`
    const byUci = moves.find((move) => move.uci === uci)
    if (byUci) return byUci
    // A bare "e2e4" for a promotion is not a move; keep falling through to the SAN matching,
    // because "b4c5" style text can never be a SAN anyway.
  }

  const wanted = canonical(text)
  const exact = moves.filter((move) => canonical(move.san) === wanted)
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null

  // Last resort: the model dropped the capitalisation ("nf3", "e8q"). Only accept it when
  // exactly one legal move matches, so "Bxc6" and "bxc6" can never be swapped silently.
  const lower = wanted.toLowerCase()
  const loose = moves.filter((move) => canonical(move.san).toLowerCase() === lower)
  return loose.length === 1 ? loose[0] : null
}

/** First four FEN fields: placement, side to move, castling rights, en-passant square. */
export function epdOf(fen: string): string {
  return String(fen ?? '').trim().split(/\s+/).slice(0, 4).join(' ')
}

/** Plays `move` (UCI, SAN or any spelling {@link normalizeMove} accepts) and returns the new position. */
export function applyMove(fen: string, uci: string): { fen: string; san: string } | null {
  const normalized = normalizeMove(fen, uci)
  if (!normalized) return null
  const chess = position(fen)
  if (!chess) return null
  try {
    const played = chess.move(normalized.san)
    return { fen: chess.fen(), san: played.san }
  } catch {
    return null
  }
}

/**
 * Terminal-state check for `fen`. Repetition cannot be seen in a single FEN, so pass the
 * positions reached earlier in the game through `history` (either every position before
 * `fen`, or every position including it — both are accepted).
 */
export function gameStatus(fen: string, history?: string[]): GameStatus {
  const chess = position(fen)
  if (!chess) return { over: false, check: false }
  const check = chess.isCheck()
  if (chess.isCheckmate()) return { over: true, reason: 'checkmate', check: true }
  if (chess.isStalemate()) return { over: true, reason: 'stalemate', check }
  if (chess.isInsufficientMaterial()) return { over: true, reason: 'insufficient', check }

  const epd = epdOf(fen)
  if (history && history.length > 0) {
    // The position before the current one always has the other side to move, so an EPD match
    // on the last entry can only mean the caller already included `fen` in the history.
    const inclusive = epdOf(history[history.length - 1]) === epd
    const positions = inclusive ? history : [...history, fen]
    const occurrences = positions.filter((entry) => epdOf(entry) === epd).length
    if (occurrences >= 3) return { over: true, reason: 'repetition', check }
  }

  const halfmove = Number(fen.trim().split(/\s+/)[4])
  if (Number.isFinite(halfmove) && halfmove >= 100) return { over: true, reason: 'fifty', check }

  return { over: false, check }
}
