import type { LegalMove } from '@shared/chess/notation'
import {
  DIFFICULTY_LEVELS,
  nearestLevel,
  type DifficultyLevel,
  type OpponentDifficulty
} from '@shared/types/session'

/**
 * The opponent's prompts (spec §4.1).
 *
 * The model receives the position, the game so far and the complete list of legal moves, and
 * nothing else: no engine score, no analysis, no tools. The difficulty is a persona, never a
 * change of model or effort, so the same model can play a plausible 600 or a plausible 1800.
 */

interface Persona {
  /** Name of the level as the user sees it, used to open the persona paragraph. */
  name: string
  /** What that rating plays like, straight from the spec table. */
  description: string
}

const PERSONAS: Record<'it' | 'en', Record<DifficultyLevel, Persona>> = {
  it: {
    1: {
      name: 'Principiante',
      description:
        'conosci le regole e giochi mosse naturali, senza piani; lasci spesso pezzi in presa'
    },
    2: {
      name: 'Facile',
      description:
        'conosci i principi di base dell’apertura e vedi le catture in una mossa, ma ti sfuggono spesso le tattiche in due'
    },
    3: {
      name: 'Medio',
      description:
        'apertura solida e tattiche semplici, con occasionali errori posizionali; ti sfuggono le combinazioni profonde'
    },
    4: {
      name: 'Impegnativo',
      description:
        'giocatore di circolo: tattica a due o tre mosse, piani coerenti, imprecisioni occasionali'
    },
    5: {
      name: 'Forte',
      description: 'tattica precisa, buona tecnica di finale, errori rari'
    },
    6: {
      name: 'Massimo',
      description: 'gioca il meglio che riesci a trovare in ogni posizione, senza limitarti'
    }
  },
  en: {
    1: {
      name: 'Beginner',
      description:
        'you know the rules and play natural moves without plans; you often leave pieces hanging'
    },
    2: {
      name: 'Easy',
      description:
        'you know basic opening principles and see one-move captures, but you often miss two-move tactics'
    },
    3: {
      name: 'Medium',
      description:
        'solid openings and simple tactics with occasional positional mistakes; you miss deep combinations'
    },
    4: {
      name: 'Challenging',
      description: 'club player: two or three move tactics, coherent plans, occasional inaccuracies'
    },
    5: {
      name: 'Strong',
      description: 'accurate tactics, good endgame technique, rare mistakes'
    },
    6: {
      name: 'Maximum',
      description: 'play the best move you can find in every position, with no self-imposed limit'
    }
  }
}

const COLOR_NAME: Record<'it' | 'en', { w: string; b: string }> = {
  it: { w: 'il Bianco', b: 'il Nero' },
  en: { w: 'White', b: 'Black' }
}

/**
 * Concrete playing discipline for each tier.
 *
 * A numeric search-depth limit is a poor proxy for human strength: at level 3 it used to tell the
 * model to stop after only three plies, which can suppress even the check of the opponent's most
 * immediate reply. These rules instead say which tactical duties the tier must reliably perform.
 * From Medium upwards the duties only grow; weaker play comes from narrower planning and
 * evaluation, never from knowingly hanging material or ignoring an immediate tactic.
 */
const PLAYING_RULES: Record<'it' | 'en', Record<DifficultyLevel, string[]>> = {
  it: {
    1: [
      'Gioca in modo semplice e diretto; puoi non accorgerti di pezzi in presa o minacce immediate.',
      'Non scegliere a caso: anche un errore deve sembrare una mossa umana plausibile.'
    ],
    2: [
      'Prima di muovere osserva gli scacchi e le catture immediate più evidenti per entrambi i colori.',
      'Puoi trascurare minacce meno evidenti e combinazioni che richiedono più passaggi.'
    ],
    3: [
      'Prima di scegliere esamina scacchi, catture e minacce immediate per entrambi i colori.',
      'Controlla la risposta immediata più forte dell’avversario: non lasciare pezzi in presa e non ignorare matti in una o tattiche semplici.',
      'Non commettere volontariamente un errore tattico che hai già riconosciuto; le tue imprecisioni devono essere posizionali o dipendere da combinazioni più profonde.'
    ],
    4: [
      'Rispetta sempre i controlli tattici del livello Medio: scacchi, catture, minacce e risposta immediata più forte dell’avversario.',
      'Confronta più mosse candidate e calcola le varianti forzanti finché la posizione non è tatticamente stabile.',
      'Valuta anche sicurezza del re, attività dei pezzi e struttura pedonale prima di decidere.'
    ],
    5: [
      'Rispetta sempre i controlli tattici dei livelli precedenti: scacchi, catture, minacce e risposta immediata più forte dell’avversario.',
      'Confronta più mosse candidate, cerca risorse difensive per entrambi i colori e calcola ogni variante forzante finché la posizione non è tatticamente stabile.',
      'Scegli la mossa più solida dopo aver valutato tattica, piano, sicurezza del re e finale risultante.'
    ],
    6: [
      'Rispetta sempre i controlli tattici dei livelli precedenti: scacchi, catture, minacce e risposta immediata più forte dell’avversario.',
      'Confronta tutte le mosse candidate serie, cerca ogni risorsa difensiva e calcola ogni variante forzante finché la posizione non è tatticamente stabile.',
      'Valuta tattica, piano, sicurezza del re, attività dei pezzi, struttura pedonale e finale risultante prima di decidere.'
    ]
  },
  en: {
    1: [
      'Play simply and directly; you may overlook hanging pieces or immediate threats.',
      'Do not choose at random: even a mistake must look like a plausible human move.'
    ],
    2: [
      'Before moving, notice the most obvious immediate checks and captures for both sides.',
      'You may overlook less obvious threats and combinations that take several steps.'
    ],
    3: [
      'Before choosing, examine immediate checks, captures and threats for both sides.',
      "Check the opponent's strongest immediate reply: do not leave pieces hanging or ignore mate in one or simple tactics.",
      'Do not deliberately make a tactical error you have already recognised; your inaccuracies should be positional or depend on deeper combinations.'
    ],
    4: [
      "Always perform the Medium tier's tactical checks: checks, captures, threats and the opponent's strongest immediate reply.",
      'Compare several candidate moves and calculate forcing lines until the position is tactically stable.',
      'Also evaluate king safety, piece activity and pawn structure before deciding.'
    ],
    5: [
      "Always perform the previous tiers' tactical checks: checks, captures, threats and the opponent's strongest immediate reply.",
      'Compare several candidate moves, look for defensive resources for both sides and calculate every forcing line until the position is tactically stable.',
      'Choose the soundest move after evaluating tactics, plans, king safety and the resulting endgame.'
    ],
    6: [
      "Always perform the previous tiers' tactical checks: checks, captures, threats and the opponent's strongest immediate reply.",
      'Compare every serious candidate move, find every defensive resource and calculate every forcing line until the position is tactically stable.',
      'Evaluate tactics, plans, king safety, piece activity, pawn structure and the resulting endgame before deciding.'
    ]
  }
}

/**
 * `baseInstructions` of the opponent thread: the whole system prompt, difficulty included.
 * Recreated for every game (and on resume), never mid-game.
 */
export function opponentBaseInstructions(p: {
  color: 'w' | 'b'
  difficulty: OpponentDifficulty
  language: 'it' | 'en'
}): string {
  const { language, difficulty } = p
  // Adaptive plays the persona of the closest rated level with its own exact target Elo.
  const level: DifficultyLevel =
    difficulty.mode === 'adaptive' ? nearestLevel(difficulty.targetElo ?? 1200) : difficulty.level
  const targetElo =
    difficulty.mode === 'adaptive' ? (difficulty.targetElo ?? 1200) : DIFFICULTY_LEVELS[level].elo
  const persona = PERSONAS[language][level]
  const lines: string[] = []

  if (language === 'it') {
    lines.push(
      `Sei l’avversario di una partita a scacchi contro una persona. Giochi con ${COLOR_NAME.it[p.color]}.`,
      'A ogni turno ricevi la posizione in FEN, il PGN della partita e l’elenco completo delle mosse legali (SAN e UCI affiancate).',
      'Non hai alcun aiuto esterno e non usi strumenti: scegli la mossa ragionando soltanto sulla posizione che ti viene data.',
      'Rispondi sempre e soltanto con l’oggetto JSON richiesto: "move" è una delle mosse legali elencate, copiata esattamente in SAN; "shortComment" è una frase molto breve rivolta alla persona con cui giochi, oppure null.',
      '',
      `Livello di gioco: ${persona.name} — ${persona.description}.`,
      ...PLAYING_RULES.it[level]
    )
    if (targetElo === null) {
      lines.push(
        'Gioca la mossa migliore che riesci a trovare: non limitare volontariamente la tua forza.'
      )
    } else {
      lines.push(
        `Elo obiettivo: circa ${targetElo}.`,
        `Scegli la mossa che un giocatore di circa ${targetElo} Elo giocherebbe plausibilmente.`,
        'Quando più mosse sono ragionevoli, preferisci la mossa naturale che giocherebbe una persona a quella teoricamente perfetta.'
      )
    }
  } else {
    lines.push(
      `You are the opponent in a chess game against a person. You play ${COLOR_NAME.en[p.color]}.`,
      'Every turn you receive the position in FEN, the PGN of the game and the complete list of legal moves (SAN and UCI side by side).',
      'You have no external help and you use no tools: choose the move by reasoning on the given position alone.',
      'Always answer with the requested JSON object and nothing else: "move" is one of the listed legal moves copied exactly in SAN; "shortComment" is a very short line addressed to the person you are playing, or null.',
      '',
      `Playing level: ${persona.name} — ${persona.description}.`,
      ...PLAYING_RULES.en[level]
    )
    if (targetElo === null) {
      lines.push('Play the best move you can find: do not hold back on purpose.')
    } else {
      lines.push(
        `Target rating: about ${targetElo} Elo.`,
        `Choose the move a player rated about ${targetElo} would plausibly play.`,
        'When several moves are reasonable, prefer the natural human move over the theoretically perfect one.'
      )
    }
  }
  return lines.join('\n')
}

/**
 * Movetext only, on one line: chess.js always writes the seven-tag roster and a `*` terminator,
 * and neither tells the model anything the FEN line does not already say.
 * Exported because the coach prompts (spec §4.2) write the same PGN line.
 */
export function movetext(pgn: string): string {
  return String(pgn ?? '')
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('['))
    .join(' ')
    .replace(/\s+/g, ' ')
    .replace(/\s*\*\s*$/, '')
    .trim()
}

/** `Mosse legali (SAN = UCI): e4 = e2e4, d4 = d2d4, …` */
function legalList(legal: LegalMove[]): string {
  return legal.map((move) => `${move.san} = ${move.uci}`).join(', ')
}

/**
 * Text of one opponent turn. The FEN line is the authoritative position: the PGN is context and
 * the legal list is the only vocabulary the model is allowed to answer with.
 */
export function opponentTurnText(p: {
  lastUserMove: string | null
  fen: string
  pgn: string
  legal: LegalMove[]
  /** Number of plies just taken back, or `null` when nothing was taken back. */
  takebackNotice: number | null
  language: 'it' | 'en'
}): string {
  const it = p.language === 'it'
  const lines: string[] = []

  if (p.lastUserMove) {
    lines.push(
      it
        ? `Ultima mossa dell’avversario: ${p.lastUserMove}`
        : `Your opponent's last move: ${p.lastUserMove}`
    )
  } else {
    lines.push(
      it ? 'Tocca a te muovere in questa posizione.' : 'It is your turn to move in this position.'
    )
  }
  if (p.takebackNotice !== null && p.takebackNotice > 0) {
    lines.push(
      it
        ? `Attenzione: le ultime ${p.takebackNotice} semimosse sono state annullate; la posizione corrente è quella qui sotto.`
        : `Note: the last ${p.takebackNotice} plies were taken back; the current position is the one below.`
    )
  }
  const pgn = movetext(p.pgn)
  lines.push(
    `FEN: ${p.fen}`,
    `PGN: ${pgn.length > 0 ? pgn : it ? '(partita appena iniziata)' : '(game just started)'}`,
    `${it ? 'Mosse legali (SAN = UCI)' : 'Legal moves (SAN = UCI)'}: ${legalList(p.legal)}`,
    it
      ? 'Scegli una mossa presa esattamente da questa lista e rispondi soltanto con il JSON richiesto.'
      : 'Choose a move taken exactly from this list and answer with the requested JSON only.'
  )
  return lines.join('\n')
}

/**
 * Structured output of an opponent turn. Strict-mode rules of spec §3.1: every property is
 * required, optionality is a `null` union, no `additionalProperties`, no format keywords.
 */
export const OPPONENT_MOVE_SCHEMA = {
  type: 'object',
  required: ['move', 'shortComment'],
  additionalProperties: false,
  properties: {
    move: {
      type: 'string',
      description: 'una mossa presa esattamente dalla lista fornita, in SAN'
    },
    shortComment: { type: ['string', 'null'] }
  }
} as const

/** Structured output of the draw offer (spec §4.3, "Proponi patta"). */
export const DRAW_OFFER_SCHEMA = {
  type: 'object',
  required: ['accept', 'reason'],
  additionalProperties: false,
  properties: {
    accept: { type: 'boolean' },
    reason: { type: 'string' }
  }
} as const

/** Text of the draw offer turn; the position is given so the answer is not a coin toss. */
export function drawOfferText(p: { fen: string; pgn: string; language: 'it' | 'en' }): string {
  const it = p.language === 'it'
  const pgn = movetext(p.pgn)
  return [
    it
      ? 'Il tuo avversario propone la patta. Valuta la posizione e decidi se accettare.'
      : 'Your opponent offers a draw. Judge the position and decide whether to accept.',
    `FEN: ${p.fen}`,
    `PGN: ${pgn.length > 0 ? pgn : it ? '(partita appena iniziata)' : '(game just started)'}`,
    it
      ? 'Rispondi soltanto con il JSON richiesto: "accept" true o false e "reason" con una frase breve.'
      : 'Answer with the requested JSON only: "accept" true or false and "reason" as one short sentence.'
  ].join('\n')
}
