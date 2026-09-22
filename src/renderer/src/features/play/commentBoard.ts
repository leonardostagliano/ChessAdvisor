import { Chess, type Square } from 'chess.js'
import type { CoachAnnotation, CoachEvidenceLine, CoachExplanation, Move } from '@shared/types/game'

const SQUARE = /^[a-h][1-8]$/

/** Old archive comments remain useful without inventing tactical roles from prose. */
export function commentAnnotations(move: Move, fallbackLabel: string): CoachAnnotation[] {
  return positionAnnotations(move.fenAfter, move.coachExplanation, move.coachComment, fallbackLabel)
}

export function positionAnnotations(
  fen: string,
  explanation: CoachExplanation | undefined,
  text: string | undefined,
  fallbackLabel: string
): CoachAnnotation[] {
  try {
    const board = new Chess(fen)
    const seen = new Set<string>()
    const annotations: CoachAnnotation[] = []
    const candidates: CoachAnnotation[] = explanation
      ? explanation.annotations
      : [...(text ?? '').matchAll(/\b(?:[KQRBNTPADCF]x?)?([a-h][1-8])(?:[+#?!])?\b/g)].map(
          (match) => ({ square: match[1]!, label: fallbackLabel, kind: 'focus' as const })
        )
    for (const candidate of candidates) {
      if (
        !SQUARE.test(candidate.square) ||
        !board.get(candidate.square as Square) ||
        seen.has(candidate.square)
      )
        continue
      if (!candidate.label?.trim()) continue
      const from = candidate.from
      if (from && (!SQUARE.test(from) || !board.get(from as Square))) continue
      if (candidate.kind === 'threat' && from) {
        const attacker = board.get(from as Square)!
        if (!board.attackers(candidate.square as Square, attacker.color).includes(from as Square))
          continue
      }
      seen.add(candidate.square)
      annotations.push({ ...candidate, label: candidate.label.slice(0, 140) })
      if (annotations.length === 4) break
    }
    return annotations
  } catch {
    return []
  }
}

/** Replay persisted evidence defensively; preview never forwards a move to the live session. */
export function commentLinePosition(
  line: CoachEvidenceLine,
  expectedStart: string,
  step: number
): { fen: string; lastMove: [string, string] | null; san: string | null } | null {
  try {
    if (!Number.isInteger(step) || step < -1 || step >= line.moves.length) return null
    const board = new Chess(expectedStart)
    if (new Chess(line.startFen).fen() !== board.fen()) return null
    let lastMove: [string, string] | null = null
    let san: string | null = null
    for (let index = 0; index <= step; index += 1) {
      const uci = line.moves[index]!.uci
      if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null
      const played = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] })
      if (!played) return null
      lastMove = [played.from, played.to]
      san = played.san
    }
    return { fen: board.fen(), lastMove, san }
  } catch {
    return null
  }
}
