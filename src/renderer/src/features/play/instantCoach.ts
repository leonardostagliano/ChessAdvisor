import { Chess, type Square } from 'chess.js'
import type { CoachAnnotation, CoachExplanation, Move } from '@shared/types/game'

type Language = 'it' | 'en'
type Color = 'w' | 'b'
type Piece = 'p' | 'n' | 'b' | 'r' | 'q' | 'k'

const PIECE_NAME: Record<Language, Record<Piece, string>> = {
  it: { p: 'pedone', n: 'cavallo', b: 'alfiere', r: 'torre', q: 'donna', k: 're' },
  en: { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }
}

const other = (color: Color): Color => (color === 'w' ? 'b' : 'w')
const pieceName = (piece: Piece, language: Language): string => PIECE_NAME[language][piece]
const definite = (piece: Piece, language: Language): string =>
  language === 'en'
    ? `the ${pieceName(piece, language)}`
    : { p: 'il pedone', n: 'il cavallo', b: 'l’alfiere', r: 'la torre', q: 'la donna', k: 'il re' }[
        piece
      ]
const indefinite = (piece: Piece, language: Language): string =>
  language === 'en'
    ? `a ${pieceName(piece, language)}`
    : {
        p: 'un pedone',
        n: 'un cavallo',
        b: 'un alfiere',
        r: 'una torre',
        q: 'una donna',
        k: 'un re'
      }[piece]
const focus = (square: string, label: string): CoachAnnotation => ({ square, label, kind: 'focus' })

const ALL_SQUARES: Square[] = Array.from(
  { length: 64 },
  (_, index) => `${'abcdefgh'[index % 8]}${Math.floor(index / 8) + 1}` as Square
)
const CENTER: Square[] = ['d4', 'e4', 'd5', 'e5']

function attackedSquares(board: Chess, from: Square, color: Color): Square[] {
  return ALL_SQUARES.filter((square) => board.attackers(square, color).includes(from))
}

function squareList(squares: Square[], language: Language): string {
  if (squares.length === 1) return squares[0]!
  return `${squares.slice(0, -1).join(', ')}${language === 'it' ? ' e ' : ' and '}${squares.at(-1)}`
}

function kingSquare(board: Chess, color: Color): Square | null {
  for (const row of board.board())
    for (const square of row)
      if (square?.type === 'k' && square.color === color) return square.square
  return null
}

function card(
  headline: string,
  explanation: string,
  priority: string,
  annotations: CoachAnnotation[]
): CoachExplanation {
  return { version: 1, headline, explanation, priority, hints: [], annotations }
}

/** A capture in the side-to-move's legal replies, including en passant. */
function legalCaptureOn(board: Chess, target: Square): boolean {
  return board.moves({ verbose: true }).some((reply) => {
    if (!reply.captured) return false
    const capturedSquare = reply.flags.includes('e') ? `${reply.to[0]}${reply.from[1]}` : reply.to
    return capturedSquare === target
  })
}

/** A valuable piece that the moved piece could legally capture if it had the next turn. */
function valuableTarget(
  board: Chess,
  from: Square,
  mover: Color
): { square: Square; piece: Piece } | null {
  const fields = board.fen().split(' ')
  fields[1] = mover
  fields[3] = '-'
  let probe: Chess
  try {
    probe = new Chess(fields.join(' '))
  } catch {
    return null
  }
  const rank: Partial<Record<Piece, number>> = { q: 4, r: 3, b: 2, n: 2 }
  const candidates = probe
    .moves({ verbose: true })
    .filter((reply) => reply.from === from && reply.captured && rank[reply.captured as Piece])
    .sort((a, b) => (rank[b.captured as Piece] ?? 0) - (rank[a.captured as Piece] ?? 0))
  const target = candidates[0]
  return target ? { square: target.to, piece: target.captured as Piece } : null
}

/**
 * Immediate board facts for the move being commented. It never grades the move or invents an
 * engine line. A stale or inconsistent position returns null rather than a misleading card.
 */
export function instantMoveExplanation(
  move: Move,
  fenBefore: string,
  userColor: Color,
  language: Language
): CoachExplanation | null {
  try {
    if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move.uci)) return null
    const board = new Chess(fenBefore)
    const from = move.uci.slice(0, 2) as Square
    const to = move.uci.slice(2, 4) as Square
    const beforeAttacks = attackedSquares(board, from, board.turn())
    const played = board.move({ from, to, ...(move.uci[4] ? { promotion: move.uci[4] } : {}) })
    if (!played || board.fen() !== new Chess(move.fenAfter).fen()) return null

    const it = language === 'it'
    const piece = pieceName(played.piece, language)
    const occupantType = board.get(played.to)!.type
    const occupant = pieceName(occupantType, language)
    const actor = definite(played.piece, language)
    const present = definite(occupantType, language)
    const mover = played.color
    const annotations: CoachAnnotation[] = [
      focus(played.to, it ? `${occupant} su ${played.to}` : `${occupant} on ${played.to}`)
    ]
    const canTakeMovedPiece = played.piece !== 'k' && legalCaptureOn(board, played.to)
    const safety = canTakeMovedPiece
      ? it
        ? ` Una risposta legale può catturare ${present} su ${played.to}.`
        : ` A legal reply can capture ${present} on ${played.to}.`
      : ''
    const safetyPriority = canTakeMovedPiece
      ? it
        ? `Verifica la cattura su ${played.to}.`
        : `Check the capture on ${played.to}.`
      : ''
    const target = valuableTarget(board, played.to, mover)
    const targetPriority = target
      ? other(mover) === userColor
        ? it
          ? `${target.piece === 'q' || target.piece === 'r' ? 'La tua' : 'Il tuo'} ${pieceName(target.piece, language)} su ${target.square} è sotto attacco: cerca una difesa.`
          : `Your ${pieceName(target.piece, language)} on ${target.square} is attacked: look for a defense.`
        : it
          ? `Osserva come può rispondere ${definite(target.piece, language)} su ${target.square}.`
          : `Watch how ${definite(target.piece, language)} on ${target.square} can respond.`
      : ''
    const priority = targetPriority || safetyPriority
    const attacks = attackedSquares(board, played.to, mover)
    const centerAttacks = CENTER.filter((square) => attacks.includes(square))
    const newAttacks = attacks.filter((square) => !beforeAttacks.includes(square))

    if (board.isCheckmate()) {
      const king = kingSquare(board, other(mover))
      if (king) annotations.push(focus(king, it ? 'Re sotto scacco matto' : 'Checkmated king'))
      return card(
        it ? 'Scacco matto' : 'Checkmate',
        it
          ? 'La mossa dà scacco matto: il re avversario non ha risposte legali.'
          : 'The move gives checkmate: the opposing king has no legal reply.',
        '',
        annotations
      )
    }
    if (board.isCheck()) {
      const king = kingSquare(board, other(mover))
      if (king) annotations.push(focus(king, it ? 'Re sotto scacco' : 'King in check'))
      return card(
        it ? 'Il re è sotto scacco' : 'The king is in check',
        it
          ? 'La mossa dà scacco. Lo scacco deve essere parato con una mossa legale.'
          : 'The move gives check. It must be answered with a legal move.',
        other(mover) === userColor
          ? it
            ? 'Trova una risposta legale allo scacco.'
            : 'Find a legal reply to the check.'
          : it
            ? 'Osserva come viene risolto lo scacco.'
            : 'Watch how the check is resolved.',
        annotations
      )
    }

    if (played.captured) {
      const captured = indefinite(played.captured, language)
      const capturedSquare = played.flags.includes('e')
        ? `${played.to[0]}${played.from[1]}`
        : played.to
      const promoted = played.promotion
        ? it
          ? ` Il pedone è stato promosso a ${indefinite(occupantType, language)}.`
          : ` The pawn promoted to ${indefinite(occupantType, language)}.`
        : ''
      const attack = target
        ? it
          ? ` Attacca anche ${definite(target.piece, language)} su ${target.square}.`
          : ` It also attacks ${definite(target.piece, language)} on ${target.square}.`
        : ''
      if (target)
        annotations.push({
          square: target.square,
          from: played.to,
          kind: 'threat',
          label: it
            ? `${pieceName(target.piece, language)} sotto attacco`
            : `Attacked ${pieceName(target.piece, language)}`
        })
      return card(
        it ? `Cattura su ${capturedSquare}` : `Capture on ${capturedSquare}`,
        it
          ? `${actor[0]!.toUpperCase()}${actor.slice(1)} da ${played.from} ha catturato ${captured} su ${capturedSquare}.${promoted}${attack}${safety}`
          : `${actor[0]!.toUpperCase()}${actor.slice(1)} from ${played.from} captured ${captured} on ${capturedSquare}.${promoted}${attack}${safety}`,
        priority,
        annotations
      )
    }
    if (played.promotion)
      return card(
        it ? 'Promozione del pedone' : 'Pawn promotion',
        it
          ? `Il pedone arrivato su ${played.to} è stato promosso a ${indefinite(occupantType, language)}.${safety}`
          : `The pawn on ${played.to} promoted to ${indefinite(occupantType, language)}.${safety}`,
        priority,
        annotations
      )
    if (played.flags.includes('k') || played.flags.includes('q')) {
      const side = played.flags.includes('k')
      return card(
        it ? 'Arrocco completato' : 'Castling completed',
        it
          ? `Il re ha arroccato ${side ? 'sul lato di re' : 'sul lato di donna'} e ora si trova su ${played.to}.`
          : `The king castled ${side ? 'kingside' : 'queenside'} and now stands on ${played.to}.`,
        it
          ? `Controlla le linee aperte attorno al re su ${played.to}.`
          : `Check the open lines around the king on ${played.to}.`,
        annotations
      )
    }

    if (target) {
      const victim = pieceName(target.piece, language)
      annotations.push({
        square: target.square,
        from: played.to,
        kind: 'threat',
        label: it ? `${victim} sotto attacco` : `Attacked ${victim}`
      })
      return card(
        it ? `${victim} sotto attacco` : `${victim} under attack`,
        it
          ? `${actor[0]!.toUpperCase()}${actor.slice(1)} su ${played.to} attacca ${definite(target.piece, language)} su ${target.square}.${safety}`
          : `${actor[0]!.toUpperCase()}${actor.slice(1)} on ${played.to} attacks ${definite(target.piece, language)} on ${target.square}.${safety}`,
        priority,
        annotations
      )
    }
    if (played.piece === 'k')
      return card(
        it ? `Re su ${played.to}` : `King on ${played.to}`,
        it
          ? `Il re si è spostato da ${played.from} a ${played.to}. La prossima mossa spetta all'avversario.`
          : `The king moved from ${played.from} to ${played.to}. The opponent moves next.`,
        safetyPriority,
        annotations
      )
    if (played.piece === 'p' && ['d4', 'e4', 'd5', 'e5'].includes(played.to)) {
      const controlled = attacks.length ? squareList(attacks, language) : ''
      annotations[0]!.label = controlled
        ? it
          ? `Controlla ${controlled}`
          : `Controls ${controlled}`
        : annotations[0]!.label
      return card(
        it ? 'Pedone al centro' : 'Pawn in the center',
        it
          ? `Il pedone è avanzato da ${played.from} a ${played.to} e controlla ${controlled}.${safety}`
          : `The pawn advanced from ${played.from} to ${played.to} and controls ${controlled}.${safety}`,
        safetyPriority ||
          (it
            ? `Osserva come viene conteso il pedone su ${played.to}.`
            : `Watch how the pawn on ${played.to} is challenged.`),
        annotations
      )
    }
    const homeRank = mover === 'w' ? '1' : '8'
    if ((played.piece === 'n' || played.piece === 'b') && played.from[1] === homeRank) {
      const control = centerAttacks.length ? squareList(centerAttacks, language) : ''
      if (control) annotations[0]!.label = it ? `Controlla ${control}` : `Controls ${control}`
      return card(
        it ? `${piece} sviluppato` : `${piece} developed`,
        it
          ? `${actor[0]!.toUpperCase()}${actor.slice(1)} è arrivato su ${played.to}${control ? ` e controlla ${control}` : ''}.${safety}`
          : `${actor[0]!.toUpperCase()}${actor.slice(1)} reached ${played.to}${control ? ` and controls ${control}` : ''}.${safety}`,
        safetyPriority ||
          (it
            ? `Considera le nuove case raggiungibili da ${played.to}.`
            : `Consider the new squares reachable from ${played.to}.`),
        annotations
      )
    }
    const gained = newAttacks.slice(0, 2)
    const control = gained.length ? squareList(gained, language) : ''
    if (control) annotations[0]!.label = it ? `Controlla ${control}` : `Controls ${control}`
    return card(
      it ? `${piece} su ${played.to}` : `${piece} on ${played.to}`,
      it
        ? `${actor[0]!.toUpperCase()}${actor.slice(1)} si è spostato da ${played.from} a ${played.to}${control ? ` e ora controlla ${control}` : ''}.${safety}`
        : `${actor[0]!.toUpperCase()}${actor.slice(1)} moved from ${played.from} to ${played.to}${control ? ` and now controls ${control}` : ''}.${safety}`,
      safetyPriority ||
        (it
          ? `Guarda le nuove case raggiungibili da ${played.to}.`
          : `Look at the new squares reachable from ${played.to}.`),
      annotations
    )
  } catch {
    return null
  }
}

/** A brief, explicitly ungraded reading of the current legal position while a coach answer loads. */
export function instantPositionExplanation(
  fen: string,
  userColor: Color,
  language: Language
): CoachExplanation | null {
  try {
    const board = new Chess(fen)
    const it = language === 'it'
    const turn = board.turn()
    const king = kingSquare(board, turn)
    if (!king) return null
    const kingFocus = [focus(king, it ? 'Re al tratto' : 'King to move')]
    if (board.isCheckmate())
      return card(
        it ? 'Scacco matto' : 'Checkmate',
        it
          ? `Il re su ${king} è sotto scacco e non ha risposte legali.`
          : `The king on ${king} is in check and has no legal reply.`,
        '',
        kingFocus
      )
    if (board.isCheck())
      return card(
        it ? 'Rispondere allo scacco' : 'Answer the check',
        it
          ? `Il re su ${king} è sotto scacco. La prossima mossa deve eliminarlo.`
          : `The king on ${king} is in check. The next move must resolve it.`,
        turn === userColor
          ? it
            ? 'Esamina le risposte legali allo scacco.'
            : 'Examine the legal replies to the check.'
          : it
            ? 'L’avversario deve rispondere allo scacco.'
            : 'The opponent must answer the check.',
        kingFocus
      )

    const legal = board.moves({ verbose: true })
    if (!legal.length) return null
    const side =
      turn === userColor ? (it ? 'Puoi' : 'You can') : it ? 'L’avversario può' : 'The opponent can'
    const rank: Record<Piece, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 }
    const capture = legal
      .filter((move) => move.captured)
      .sort((a, b) => rank[b.captured as Piece] - rank[a.captured as Piece])[0]
    if (capture) {
      const target = capture.flags.includes('e')
        ? (`${capture.to[0]}${capture.from[1]}` as Square)
        : capture.to
      const victim = pieceName(capture.captured as Piece, language)
      return card(
        it ? 'Cattura disponibile' : 'Capture available',
        it
          ? `${side} catturare ${definite(capture.captured as Piece, language)} su ${target} con una mossa legale. Questo non dice ancora se la cattura conviene.`
          : `${side} capture ${definite(capture.captured as Piece, language)} on ${target} with a legal move. This alone does not say whether the capture is sound.`,
        it ? 'Confronta la risposta dopo la cattura.' : 'Compare the reply after the capture.',
        [focus(target, it ? `${victim} catturabile` : `Capturable ${victim}`)]
      )
    }
    const checking = legal.find((move) => {
      board.move(move.san)
      const check = board.isCheck()
      board.undo()
      return check
    })
    if (checking)
      return card(
        it ? 'Scacco disponibile' : 'Check available',
        it
          ? `${side} dare scacco con il pezzo su ${checking.from}. Questo non basta a valutarlo come buona mossa.`
          : `${side} give check with the piece on ${checking.from}. That alone does not make it a good move.`,
        it ? 'Esamina le risposte legali allo scacco.' : 'Examine the legal replies to the check.',
        [focus(checking.from, it ? 'Pezzo che può dare scacco' : 'Piece that can give check')]
      )
    const castle = legal.find((move) => move.flags.includes('k') || move.flags.includes('q'))
    if (castle)
      return card(
        it ? 'Arrocco disponibile' : 'Castling available',
        it
          ? `Il re su ${king} può arroccare legalmente in questa posizione.`
          : `The king on ${king} can legally castle in this position.`,
        it
          ? 'Controlla la sicurezza delle case di arrivo.'
          : 'Check the safety of the destination squares.',
        kingFocus
      )
    for (const square of ['d4', 'e4', 'd5', 'e5'] as Square[]) {
      const occupant = board.get(square)
      if (occupant?.type !== 'p') continue
      const color =
        occupant.color === userColor ? (it ? 'tuo' : 'your') : it ? 'avversario' : 'opponent’s'
      return card(
        it ? 'Pedone centrale' : 'Central pawn',
        it
          ? `Un pedone ${color} occupa ${square}. Osserva quali mosse legali lo sostengono o lo attaccano.`
          : `${color[0]!.toUpperCase()}${color.slice(1)} pawn occupies ${square}. Examine legal moves that support or challenge it.`,
        '',
        [focus(square, it ? 'Pedone centrale' : 'Central pawn')]
      )
    }
    return card(
      it ? 'Le mosse disponibili' : 'Available moves',
      it
        ? `Non ci sono catture né scacchi legali immediati per il giocatore al tratto. Sono disponibili ${legal.length} mosse legali.`
        : `The side to move has no immediate legal capture or check. There are ${legal.length} legal moves.`,
      it
        ? 'Confronta lo sviluppo dei pezzi e la sicurezza del re.'
        : 'Compare piece development and king safety.',
      kingFocus
    )
  } catch {
    return null
  }
}
