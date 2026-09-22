import { Chess } from 'chess.js'

export type RapidPhase = 'opening' | 'middlegame' | 'endgame'

/** Material takes precedence over move number: a stripped board is an endgame even on move ten. */
export function phaseOf(fen: string): RapidPhase {
  const fields = fen.split(' ')
  if (fields.length < 6 || !/^[wb]$/.test(fields[1])) throw new Error('Invalid FEN')
  const placement = fields[0]
  let nonPawnMaterial = 0
  let queens = 0
  for (const piece of placement) {
    switch (piece.toLowerCase()) {
      case 'n':
      case 'b':
        nonPawnMaterial += 3
        break
      case 'r':
        nonPawnMaterial += 5
        break
      case 'q':
        nonPawnMaterial += 9
        queens++
        break
    }
  }
  if (nonPawnMaterial <= 16 || (queens === 0 && nonPawnMaterial <= 24)) return 'endgame'
  const ply = (Number(fields[5]) - 1) * 2 + (fields[1] === 'b' ? 1 : 0)
  return ply <= 20 ? 'opening' : 'middlegame'
}

export function positionContext(fen: string): {
  phase: RapidPhase
  inCheck: boolean
  hasCapture: boolean
  legalMoves: number
} {
  const board = new Chess(fen)
  const moves = board.moves({ verbose: true })
  return {
    phase: phaseOf(fen),
    inCheck: board.isCheck(),
    hasCapture: moves.some((move) => Boolean(move.captured)),
    legalMoves: moves.length
  }
}
