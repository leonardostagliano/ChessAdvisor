import { Chess } from 'chess.js'
import type { Game, Move } from '@shared/types/game'
import { describe, expect, it } from 'vitest'
import type { EngineContext } from '../game/coachPrompts'
import { commentMoveText, keyMomentsCommentText, lessonText, LESSON_SCHEMA } from './reviewPrompts'

const FEN_BEFORE = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const FEN_AFTER = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'

const move = (patch: Partial<Move> = {}): Move => ({
  ply: 7,
  san: 'Qh5',
  uci: 'd1h5',
  fenAfter: FEN_AFTER,
  epdAfter: 'x',
  by: 'user',
  ...patch
})

const engine = (): EngineContext => ({
  evalBefore: { cp: 30 },
  evalAfter: { cp: -180 },
  classification: 'blunder',
  bestLines: [{ san: 'Nf3', pv: ['Nf3', 'Nc6'], eval: { cp: 30 } }]
})

const context = (
  patch: Partial<Parameters<typeof commentMoveText>[0]> = {}
): Parameters<typeof commentMoveText>[0] => ({
  move: move(),
  fenBefore: FEN_BEFORE,
  fenAfter: FEN_AFTER,
  pgn: '1. e4 e5 2. Nf3 Nc6 3. Bb5 a6 4. Qh5 *',
  engine: engine(),
  language: 'it',
  userColor: 'w',
  ...patch
})

describe('commentMoveText', () => {
  it('carries the ply, the position, the movetext and the engine verdict', () => {
    const text = commentMoveText(context())
    expect(text).toContain('Rivedi la mossa 7')
    expect(text).toContain('7. Qh5 (d1h5)')
    expect(text).toContain(`FEN: ${FEN_BEFORE}`)
    expect(text).toContain('1. e4 e5')
    expect(text).toContain('Valutazione prima: +0.30')
    expect(text).toContain('Valutazione dopo: -1.80')
    expect(text).toContain('Classificazione: errore grave')
    expect(text).toContain('1. Nf3')
    expect(text).toContain('Niente elenchi e niente JSON')
  })

  it('says who played the move without ever naming the opponent’s plan', () => {
    expect(commentMoveText(context())).toContain('dalla persona che alleni')
    expect(commentMoveText(context({ move: move({ by: 'ai' }) }))).toContain('dal suo avversario')
  })

  it('falls back to the oracle-less mode when there is no engine', () => {
    const text = commentMoveText(context({ engine: null }))
    expect(text).toContain('senza oracolo')
    expect(text).not.toContain('Valutazione prima')
  })

  it('speaks English when the UI does', () => {
    const text = commentMoveText(context({ language: 'en' }))
    expect(text).toContain('Review move 7')
    expect(text).toContain('Evaluation before')
    expect(text).not.toContain('Rivedi')
  })
})

describe('keyMomentsCommentText', () => {
  it('numbers the moment inside the series', () => {
    const text = keyMomentsCommentText({ ...context(), index: 2, count: 5 })
    expect(text).toContain('Rivedi la mossa 7')
    expect(text).toContain('momento chiave 2 di 5')
    expect(keyMomentsCommentText({ ...context(), language: 'en', index: 1, count: 3 })).toContain(
      'key moment 1 of 3'
    )
  })
})

describe('lessonText', () => {
  const game = (patch: Partial<Game> = {}): Game => ({
    id: 'g1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'match',
    status: 'finished',
    userColor: 'w',
    opponent: {
      model: 'gpt-6-astra',
      effort: 'medium',
      difficulty: { mode: 'fixed', level: 3, targetElo: 1200 }
    },
    coach: { model: 'gpt-6-astra', effort: 'medium' },
    clock: null,
    language: 'it',
    moves: [
      move({ ply: 1, san: 'e4', uci: 'e2e4' }),
      move({ ply: 2, san: 'e5', uci: 'e7e5', by: 'ai' })
    ],
    takebacks: 0,
    coachLog: [],
    result: { outcome: '0-1', reason: 'checkmate' },
    opening: { eco: 'C40', name: "King's Knight Opening", lastBookPly: 3 },
    analysis: {
      accuracy: { w: 71.2, b: 88.4 },
      acpl: { w: 96, b: 22 },
      keyMoments: [1],
      analyzedAt: '2026-01-02T00:00:00.000Z'
    },
    ...patch
  })

  it('summarises result, opening, accuracy and key moments, and asks for the JSON', () => {
    const text = lessonText({ game: game(), language: 'it', pgn: '1. e4 e5 *' })
    expect(text).toContain('Risultato: 0-1')
    expect(text).toContain('scacco matto')
    expect(text).toContain("Apertura: C40 King's Knight Opening")
    expect(text).toContain('Accuratezza: Bianco 71.2%, Nero 88.4%')
    expect(text).toContain('ACPL: Bianco 96, Nero 22')
    expect(text).toContain('Momenti chiave')
    expect(text).toContain('1. e4')
    expect(text).toContain('esattamente tre')
  })

  it('grounds lessons in legal variations and keeps Black scores and terminal wins correct', () => {
    const chess = new Chess(FEN_AFTER)
    chess.move('e5')
    const evalData = {
      before: { cp: 0 },
      after: { cp: -200 },
      cpLoss: 200,
      winPercentLoss: 15,
      classification: 'mistake' as const,
      bestMove: 'c7c5',
      bestLine: ['c7c5', 'g1f3']
    }
    const position = game({
      userColor: 'b',
      startFen: FEN_AFTER,
      moves: [
        move({
          ply: 1,
          san: 'e5',
          uci: 'e7e5',
          fenAfter: chess.fen(),
          eval: evalData
        })
      ]
    })
    const text = lessonText({ game: position, language: 'en', pgn: '1... e5' })
    expect(text).toContain('after, White perspective +2.00')
    expect(text).toContain('Calculated continuation: c5 Nf3')
    expect(text).toContain('FEN: ' + FEN_AFTER)
    const mateFen = '8/8/8/8/8/6k1/5q2/7K b - - 0 1'
    const mate = new Chess(mateFen)
    mate.move('Qg2#')
    position.startFen = mateFen
    position.moves = [
      move({
        ply: 1,
        san: 'Qg2#',
        uci: 'f2g2',
        fenAfter: mate.fen(),
        eval: { ...evalData, after: { mate: 0 }, bestMove: 'f2g2', bestLine: ['f2g2'] }
      })
    ]
    expect(lessonText({ game: position, language: 'en', pgn: '1... Qg2#' })).toContain(
      'mate in 0 for Black'
    )
  })

  it('tells the model it has no engine numbers when the game was never analysed', () => {
    const text = lessonText({
      game: game({ analysis: undefined }),
      language: 'en',
      pgn: '1. e4 e5 *'
    })
    expect(text).toContain('was not analysed by the engine')
    expect(text).toContain('exactly three')
  })
})

describe('LESSON_SCHEMA', () => {
  it('follows the strict-mode rules of the spec', () => {
    expect(LESSON_SCHEMA.required).toEqual(['takeaways', 'summary'])
    expect(LESSON_SCHEMA.additionalProperties).toBe(false)
    expect(Object.keys(LESSON_SCHEMA.properties)).toEqual(['takeaways', 'summary'])
    expect(JSON.stringify(LESSON_SCHEMA)).not.toMatch(/minItems|maxItems|pattern/)
  })
})
