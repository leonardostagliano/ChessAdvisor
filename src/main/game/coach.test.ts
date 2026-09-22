import { join } from 'node:path'
import { legalMoves } from '@shared/chess/notation'
import type { StreamEnvelope } from '@shared/types/api'
import type { ModelInfo, TurnRequest, TurnResult } from '@shared/types/codex'
import type { Analysis, EngineState } from '@shared/types/engine'
import type { Game } from '@shared/types/game'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTmpDir, removeTmpDir } from '../../../test/helpers/tmpDir'
import { SettingsStore } from '../store/settingsStore'
import { CoachSession, type CoachLogEntry } from './coach'
import type { SessionCodex, SessionEngine } from './gameSession'

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'
const BLACK_MATED = '8/8/8/8/8/6k1/6q1/7K w - - 0 1'
const AFTER_E4 = 'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1'

/** A game with one move played, the minimum a comment needs. */
function game(patch: Partial<Game> = {}): Game {
  return {
    id: 'g1',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    kind: 'match',
    status: 'in_progress',
    userColor: 'w',
    opponent: {
      model: 'gpt-6-astra',
      effort: 'medium',
      difficulty: { mode: 'fixed', level: 3, targetElo: 1200 }
    },
    coach: { model: 'gpt-6-astra', effort: 'medium' },
    clock: null,
    language: 'it',
    moves: [{ ply: 1, san: 'e4', uci: 'e2e4', fenAfter: AFTER_E4, epdAfter: 'x', by: 'user' }],
    takebacks: 0,
    coachLog: [],
    ...patch
  }
}

class FakeCodex implements SessionCodex {
  readonly started: { role: string; model: string; baseInstructions: string; gameId?: string }[] =
    []
  readonly requests: TurnRequest[] = []
  readonly interrupted: string[] = []
  readonly closed: string[] = []
  script: TurnResult[] = []
  /** Text deltas the fake pushes to `onDelta` before answering. */
  deltas: string[] = []
  private threads = 0

  async startThread(
    role: 'opponent' | 'coach' | 'training',
    opts: { model: string; baseInstructions: string; gameId?: string }
  ): Promise<string> {
    this.started.push({ role, ...opts })
    this.threads += 1
    return `thread-${this.threads}`
  }

  async runTurn(
    req: TurnRequest,
    onDelta?: (kind: 'text' | 'reasoning', delta: string) => void
  ): Promise<TurnResult> {
    this.requests.push(req)
    for (const delta of this.deltas) onDelta?.('text', delta)
    const scripted = this.script.shift()
    const text = JSON.stringify(req.outputSchema ?? {}).includes('answer')
      ? JSON.stringify({ answer: 'Risposta finta.', move: null })
      : 'Commento finto.'
    return (
      scripted ?? {
        ok: true,
        text,
        turnId: `t-${this.requests.length}`,
        effectiveModel: null,
        durationMs: 3
      }
    )
  }

  async interrupt(threadId: string): Promise<void> {
    this.interrupted.push(threadId)
  }

  async closeThread(threadId: string): Promise<void> {
    this.closed.push(threadId)
  }

  models(): ModelInfo[] {
    return []
  }
}

/** Engine whose best line is always the first legal move in SAN order. */
function fakeEngine(
  available = true
): SessionEngine & { calls: { fen: string; profile: string }[] } {
  const calls: { fen: string; profile: string }[] = []
  return {
    calls,
    state: (): EngineState => ({
      available,
      binary: available ? 'avx2' : 'none',
      version: 'fake 17',
      message: null
    }),
    analyze: async (fen: string, profile: string): Promise<Analysis> => {
      calls.push({ fen, profile })
      const moves = legalMoves(fen)
      return {
        bestMove: moves[0]?.uci ?? null,
        lines: moves.slice(0, 3).map((move, index) => ({
          move: move.uci,
          pv: [move.uci],
          scoreCp: 40 - index * 10,
          depth: 18
        })),
        depth: 18,
        fen
      }
    }
  } as SessionEngine & { calls: { fen: string; profile: string }[] }
}

describe('CoachSession', () => {
  let root: string
  let settings: SettingsStore
  let codex: FakeCodex
  let engine: ReturnType<typeof fakeEngine>
  let emitted: StreamEnvelope[]
  let coach: CoachSession

  const build = (over?: { engine?: SessionEngine }): CoachSession => {
    coach = new CoachSession({
      codex,
      engine: over?.engine ?? engine,
      settings,
      emit: (_channel, payload) => emitted.push(payload),
      now: () => 1_700_000_000_000
    })
    return coach
  }

  beforeEach(async () => {
    root = await makeTmpDir()
    settings = new SettingsStore(join(root, 'settings.json'))
    await settings.load()
    codex = new FakeCodex()
    engine = fakeEngine()
    emitted = []
    build()
  })

  afterEach(async () => {
    await removeTmpDir(root)
    vi.restoreAllMocks()
  })

  it('opens a coach thread with the tutor persona and the opponent model', async () => {
    await coach.start(game(), { language: 'it' })
    expect(codex.started).toHaveLength(1)
    expect(codex.started[0]).toMatchObject({ role: 'coach', model: 'gpt-6-astra', gameId: 'g1' })
    expect(codex.started[0]!.baseInstructions).toMatch(/allenatore/)
    expect(codex.started[0]!.baseInstructions).not.toMatch(/senza oracolo/)
  })

  it('uses the badge judgement that arrives during preparation and a concrete reply', async () => {
    const match = game()
    match.moves[0].liveEval = {
      before: { cp: 20 },
      after: { cp: -500 },
      cpLoss: 520,
      winPercentLoss: 38,
      classification: 'blunder',
      bestMove: 'd2d4',
      bestLine: ['d2d4'],
      depth: 16,
      assessedAt: '2026-09-22T00:00:00Z'
    }
    const grade = match.moves[0].liveEval
    delete match.moves[0].liveEval
    const analyze = engine.analyze
    engine.analyze = async (fen, profile, opts) => {
      const result = await analyze(fen, profile, opts)
      if (fen === AFTER_E4) match.moves[0].liveEval = grade
      return result
    }
    await coach.start(match, { language: 'it' })
    await coach.commentOn(match, 1, { fenBefore: START_FEN, fenAfter: AFTER_E4, pgn: '1. e4 *' })
    expect(codex.requests[0].text).toContain('Classificazione: errore grave')
    expect(codex.requests[0].text).toContain('Valutazione dopo: -5.00')
    expect(codex.requests[0].text).toContain('Risposta più forte dopo la mossa giocata:')
    expect(codex.requests[0].text).toContain('stessa mostrata nel badge')
  })

  it('keeps a terminal mate for Black when the engine reports mate zero', async () => {
    const terminal = fakeEngine()
    const normalAnalyze = terminal.analyze
    terminal.analyze = async (fen, profile) =>
      fen === BLACK_MATED
        ? {
            bestMove: null,
            lines: [{ move: '', pv: [], scoreMate: 0, depth: 20 }],
            depth: 20,
            fen
          }
        : normalAnalyze(fen, profile)
    build({ engine: terminal })
    const match = game({
      moves: [{ ply: 1, san: 'e4', uci: 'e2e4', fenAfter: BLACK_MATED, epdAfter: 'x', by: 'user' }]
    })
    await coach.start(match, { language: 'it' })

    await coach.commentOn(match, 1, { fenBefore: START_FEN, fenAfter: BLACK_MATED, pgn: '1. e4 *' })

    expect(codex.requests[0]!.text).toContain('matto in 0 per il Nero')
    expect(codex.requests[0]!.text).toContain('ha vinto il Nero')
  })

  it('uses the separate coach model and effort when Settings ask for it', async () => {
    await settings.save({ separateCoach: true, coachModel: 'gpt-5.5', coachEffort: 'low' })
    await coach.start(game(), { language: 'it' })
    expect(codex.started[0]!.model).toBe('gpt-5.5')

    await coach.ask(game(), 'perché?', { fen: AFTER_E4, pgn: '1. e4 *' })
    expect(codex.requests[0]).toMatchObject({ model: 'gpt-5.5', effort: 'low' })
  })

  it('writes the oracle-less persona and skips the engine entirely when Stockfish is missing', async () => {
    const missing = fakeEngine(false)
    build({ engine: missing })
    const match = game()
    match.moves[0].liveEval = {
      before: { cp: 20 },
      after: { cp: -500 },
      cpLoss: 520,
      winPercentLoss: 38,
      classification: 'blunder',
      bestMove: 'd2d4',
      bestLine: ['d2d4'],
      depth: 16,
      assessedAt: '2026-09-22T00:00:00Z'
    }
    await coach.start(match, { language: 'it' })
    expect(codex.started[0]!.baseInstructions).toMatch(/senza oracolo/)

    const comment = await coach.commentOn(match, 1, {
      fenBefore: START_FEN,
      fenAfter: AFTER_E4,
      pgn: '1. e4 *'
    })
    expect(comment).not.toBeNull()
    expect(missing.calls).toHaveLength(0)
    expect(codex.requests[0]!.text).toContain('Classificazione: errore grave')
    expect(codex.requests[0]!.text).toContain('Valutazione dopo: -5.00')
  })

  it('comments a move with the engine data and returns the text and the stream id', async () => {
    await coach.start(game(), { language: 'it' })
    codex.deltas = ['Commen', 'to.']
    const seen: { busy: boolean; streamId: string | null }[] = []
    coach.onActivity = (activity) => seen.push({ ...activity })

    const comment = await coach.commentOn(game(), 1, {
      fenBefore: START_FEN,
      fenAfter: AFTER_E4,
      pgn: '1. e4 *'
    })

    expect(comment).toMatchObject({ text: 'Commento finto.' })
    expect(comment!.streamId).toMatch(/[0-9a-f-]{36}/)
    // Automatic comments use their own bounded MultiPV analysis; the score after is cheap.
    expect(engine.calls).toEqual([
      { fen: START_FEN, profile: 'comment' },
      { fen: AFTER_E4, profile: 'live' }
    ])
    const text = codex.requests[0]!.text
    expect(text).toContain('Commenta')
    expect(text).toContain(`FEN: ${AFTER_E4}`)
    expect(text).toContain('1. e4 (e2e4)')
    expect(text).toContain('+0.40')
    expect(codex.requests[0]!.outputSchema).toMatchObject({
      required: [
        'version',
        'headline',
        'explanation',
        'priority',
        'question',
        'hints',
        'takeaway',
        'annotations'
      ]
    })

    // The stream id is published while the turn runs and withdrawn when it ends.
    expect(seen[0]).toEqual({ busy: true, streamId: comment!.streamId })
    expect(seen[seen.length - 1]).toEqual({ busy: false, streamId: null })
    expect(coach.busy).toBe(false)
    // The deltas already reached the renderer: no duplicate envelope is emitted.
    expect(emitted).toHaveLength(0)
  })

  it('passes only recent moves to the automatic comment prompt', async () => {
    const moves = Array.from({ length: 20 }, (_, index) => ({
      ...game().moves[0]!,
      ply: index + 1,
      san: `M${index + 1}`
    }))
    const longGame = game({
      moves,
      opponent: { ...game().opponent, model: 'gpt-6-luna', effort: 'xhigh' }
    })
    await coach.start(longGame, { language: 'it' })
    await coach.commentOn(longGame, 20, {
      fenBefore: START_FEN,
      fenAfter: AFTER_E4,
      pgn: '1. first 2. second *'
    })
    expect(codex.requests[0]!.text).toContain('PGN: 5. M9 M10')
    expect(codex.requests[0]!.text).not.toContain('M8')
    expect(codex.requests[0]!.model).toBe('gpt-6-luna')
    expect(codex.requests[0]!.effort).toBe('xhigh')
  })

  it('emits the whole answer once when the turn produced no deltas at all', async () => {
    await coach.start(game(), { language: 'it' })
    const comment = await coach.commentOn(game(), 1, {
      fenBefore: START_FEN,
      fenAfter: AFTER_E4,
      pgn: '1. e4 *'
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({
      streamId: comment!.streamId,
      kind: 'text',
      chunk: 'Commento finto.'
    })
  })

  it('keeps only valid occupied-square annotations and replays engine evidence', async () => {
    await coach.start(game(), { language: 'it' })
    codex.script = [
      {
        ok: true,
        text: JSON.stringify({
          version: 1,
          headline: 'Pedone al centro',
          explanation: 'Il pedone occupa e4 e libera una diagonale.',
          priority: 'Guarda la risposta.',
          question: 'Che cosa controlla il pedone?',
          hints: ['Cerca due case diagonali.'],
          takeaway: 'Controlla le nuove linee.',
          annotations: [
            { square: 'e4', label: 'Pedone avanzato', kind: 'focus', from: null },
            { square: 'e5', label: 'Casa vuota', kind: 'focus', from: null },
            { square: 'e7', label: 'Minaccia falsa', kind: 'threat', from: 'e4' }
          ]
        }),
        turnId: 'structured',
        effectiveModel: null,
        durationMs: 2
      }
    ]
    const result = await coach.commentOn(game(), 1, {
      fenBefore: START_FEN,
      fenAfter: AFTER_E4,
      pgn: '1. e4 *'
    })
    expect(result?.text).toBe('Pedone al centro Il pedone occupa e4 e libera una diagonale.')
    expect(result?.explanation?.annotations).toEqual([
      { square: 'e4', label: 'Pedone avanzato', kind: 'focus' }
    ])
    const evidence = result?.explanation?.evidence
    expect(evidence).toMatchObject({
      perspective: 'white',
      source: 'engine',
      evalBefore: { cp: 40 },
      evalAfter: { cp: -40 }
    })
    const best = evidence?.lines.find((line) => line.kind === 'best')
    const reply = evidence?.lines.find((line) => line.kind === 'reply')
    expect(best?.startFen).toBe(START_FEN)
    expect(best?.moves[0]).toMatchObject({ san: 'Na3', uci: 'b1a3' })
    expect(best?.moves[0]?.fenAfter).toContain('N7')
    expect(reply?.startFen).toBe(AFTER_E4)
    expect(reply?.moves[0]).toMatchObject({ san: 'Na6', uci: 'b8a6' })
  })

  it('drops malformed JSON and accepts legacy prose without saving a raw object', async () => {
    await coach.start(game(), { language: 'it' })
    const scripted = (text: string): TurnResult => ({
      ok: true,
      text,
      turnId: 'legacy',
      effectiveModel: null,
      durationMs: 1
    })
    codex.script = [
      scripted('```json\n{"headline":"bad"\n```'),
      scripted('Una spiegazione semplice.')
    ]
    const ctx = { fenBefore: START_FEN, fenAfter: AFTER_E4, pgn: '1. e4 *' }
    expect(await coach.commentOn(game(), 1, ctx)).toBeNull()
    expect(await coach.commentOn(game(), 1, ctx)).toMatchObject({
      text: 'Una spiegazione semplice.'
    })
  })

  it('returns null instead of throwing when the comment turn fails', async () => {
    await coach.start(game(), { language: 'it' })
    codex.script = [{ ok: false, reason: 'failed', message: 'boom', turnId: null }]
    expect(
      await coach.commentOn(game(), 1, { fenBefore: START_FEN, fenAfter: AFTER_E4, pgn: '1. e4 *' })
    ).toBeNull()
    expect(coach.off).toBe(false)
  })

  it('switches itself off after a quota failure instead of burning one call per move', async () => {
    await coach.start(game(), { language: 'it' })
    codex.script = [{ ok: false, reason: 'quota', message: 'usage limit reached', turnId: null }]
    expect(
      await coach.commentOn(game(), 1, { fenBefore: START_FEN, fenAfter: AFTER_E4, pgn: '1. e4 *' })
    ).toBeNull()
    expect(coach.off).toBe(true)
    expect(
      await coach.commentOn(game(), 1, { fenBefore: START_FEN, fenAfter: AFTER_E4, pgn: '1. e4 *' })
    ).toBeNull()
    expect(codex.requests).toHaveLength(1)
  })

  it('rides the resume recap on the first real turn instead of spending one on it', async () => {
    const log: CoachLogEntry[] = [
      {
        id: 'c1',
        ply: 1,
        kind: 'question',
        text: 'che piano ho?',
        language: 'it',
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'c2',
        ply: 1,
        kind: 'answer',
        text: 'sviluppa i pezzi',
        language: 'it',
        createdAt: '2026-01-01T00:00:00.000Z'
      }
    ]
    await coach.start(game(), { language: 'it', recap: log })
    expect(codex.requests).toHaveLength(0)

    await coach.ask(game(), 'e adesso?', { fen: AFTER_E4, pgn: '1. e4 *' })
    expect(codex.requests).toHaveLength(1)
    expect(codex.requests[0]!.text).toMatch(/riprende da un salvataggio/)
    expect(codex.requests[0]!.text).toContain('sviluppa i pezzi')
    expect(codex.requests[0]!.text).toContain('Domanda: e adesso?')

    // Only the first turn carries it.
    await coach.ask(game(), 'e poi?', { fen: AFTER_E4, pgn: '1. e4 *' })
    expect(codex.requests[1]!.text).not.toMatch(/riprende da un salvataggio/)
  })

  it('refuses an empty question and a question with no thread', async () => {
    await expect(coach.ask(game(), 'ciao', { fen: AFTER_E4, pgn: '' })).rejects.toMatchObject({
      code: 'COACH_NO_THREAD'
    })
    await coach.start(game(), { language: 'it' })
    await expect(coach.ask(game(), '   ', { fen: AFTER_E4, pgn: '' })).rejects.toMatchObject({
      code: 'COACH_EMPTY_QUESTION'
    })
  })

  it('reports a failed question as an error, unlike a comment', async () => {
    await coach.start(game(), { language: 'it' })
    codex.script = [{ ok: false, reason: 'failed', message: 'boom', turnId: null }]
    await expect(coach.ask(game(), 'perché?', { fen: AFTER_E4, pgn: '' })).rejects.toMatchObject({
      code: 'COACH_TURN_FAILED'
    })
  })

  it('returns one validated indication with structured advice', async () => {
    await coach.start(game(), { language: 'it' })
    codex.script = [
      {
        ok: true,
        text: JSON.stringify({ answer: 'Gioca e4 per occupare il centro.', move: 'e4' }),
        turnId: 'a1',
        effectiveModel: null,
        durationMs: 2
      }
    ]

    const answer = await coach.ask(game(), 'cosa gioco?', { fen: START_FEN, pgn: '' })

    expect(answer).toMatchObject({
      text: 'Gioca e4 per occupare il centro.',
      hint: { move: 'e4', uci: 'e2e4', reason: 'Gioca e4 per occupare il centro.' }
    })
    expect(codex.requests).toHaveLength(1)
    expect(codex.requests[0]!.outputSchema).toMatchObject({
      required: ['answer', 'move', 'card'],
      additionalProperties: false
    })
  })

  it('keeps explanatory advice and drops an illegal recommended move', async () => {
    await coach.start(game(), { language: 'it' })
    codex.script = [
      {
        ok: true,
        text: JSON.stringify({ answer: 'Il re è sotto scacco.', move: 'Qh5xf7' }),
        turnId: 'a1',
        effectiveModel: null,
        durationMs: 2
      },
      {
        ok: true,
        text: JSON.stringify({ answer: 'Controlli il centro.', move: null }),
        turnId: 'a2',
        effectiveModel: null,
        durationMs: 2
      }
    ]

    expect(await coach.ask(game(), 'cosa gioco?', { fen: START_FEN, pgn: '' })).toMatchObject({
      text: 'Il re è sotto scacco.',
      hint: null
    })
    expect(await coach.ask(game(), 'come sto?', { fen: START_FEN, pgn: '' })).toMatchObject({
      text: 'Controlli il centro.',
      hint: null
    })
    expect(codex.requests).toHaveLength(2)
  })

  it('returns grounded cards for advice and hints without another model call', async () => {
    await coach.start(game(), { language: 'it' })
    const card = {
      version: 1,
      headline: 'Guarda il centro',
      explanation: 'La scelta modifica il controllo delle case centrali.',
      priority: 'Controlla il pedone.',
      question: 'Quale mossa aumenta il controllo?',
      hints: ['Guarda i pedoni centrali.'],
      takeaway: 'Confronta le case controllate.',
      annotations: [{ square: 'e2', label: 'Pedone', kind: 'focus', from: null }]
    }
    const result = (text: string): TurnResult => ({
      ok: true,
      text,
      turnId: 'card',
      effectiveModel: null,
      durationMs: 1
    })
    codex.script = [
      result(JSON.stringify({ answer: 'Controlla il centro.', move: null, card })),
      result(JSON.stringify({ move: 'e4', reason: 'Controlla il centro.', card }))
    ]
    const advice = await coach.ask(game(), 'come procedo?', { fen: START_FEN, pgn: '' })
    expect(advice.hint).toBeNull()
    expect(advice.explanation?.annotations).toEqual([
      { square: 'e2', label: 'Pedone', kind: 'focus' }
    ])
    expect(advice.explanation?.evidence?.lines[0]?.startFen).toBe(START_FEN)
    const hint = await coach.hint(game(), { fen: START_FEN, pgn: '' })
    expect(hint).toMatchObject({ move: 'e4', explanation: { headline: 'Guarda il centro' } })
    expect(codex.requests).toHaveLength(2)
  })

  it('drops an illegal principal variation tail from evidence', async () => {
    const broken = fakeEngine()
    const analyze = broken.analyze
    broken.analyze = async (fen, profile, opts) => {
      const analysis = await analyze(fen, profile, opts)
      if (fen === START_FEN && analysis.lines[0]) analysis.lines[0].pv = ['e2e4', 'e2e5']
      return analysis
    }
    build({ engine: broken })
    await coach.start(game(), { language: 'it' })
    codex.script = [
      {
        ok: true,
        text: JSON.stringify({
          version: 1,
          headline: 'Centro',
          explanation: 'Il pedone avanza.',
          priority: '',
          question: '',
          hints: [],
          takeaway: '',
          annotations: []
        }),
        turnId: 'pv',
        effectiveModel: null,
        durationMs: 1
      }
    ]
    const comment = await coach.commentOn(game(), 1, {
      fenBefore: START_FEN,
      fenAfter: AFTER_E4,
      pgn: '1. e4 *'
    })
    expect(comment?.explanation?.evidence?.lines[0]?.moves).toHaveLength(1)
    expect(comment?.explanation?.evidence?.lines[0]?.moves[0]).toMatchObject({
      san: 'e4',
      uci: 'e2e4'
    })
  })

  describe('hint', () => {
    const hint = (move: string, reason = 'centro'): TurnResult => ({
      ok: true,
      text: JSON.stringify({ move, reason }),
      turnId: 'h1',
      effectiveModel: null,
      durationMs: 2
    })

    it('validates the move and returns it in SAN and UCI', async () => {
      await coach.start(game(), { language: 'it' })
      codex.script = [hint('e4')]
      const answer = await coach.hint(game(), { fen: START_FEN, pgn: '' })
      expect(answer).toEqual({ move: 'e4', uci: 'e2e4', reason: 'centro' })
      expect(codex.requests[0]!.outputSchema).toMatchObject({
        required: ['move', 'reason', 'card']
      })
    })

    it('retries once with the error when the move is not legal', async () => {
      await coach.start(game(), { language: 'it' })
      codex.script = [hint('Qh5xf7'), hint('d4', 'occupa il centro')]
      const answer = await coach.hint(game(), { fen: START_FEN, pgn: '' })
      expect(answer).toEqual({ move: 'd4', uci: 'd2d4', reason: 'occupa il centro' })
      expect(codex.requests).toHaveLength(2)
      expect(codex.requests[1]!.text).toMatch(/ERRORE/)
    })

    it('falls back to the engine best move and asks for the reason in plain text', async () => {
      await coach.start(game(), { language: 'it' })
      codex.script = [
        hint('Qh5xf7'),
        hint('Ke2xd9'),
        { ok: true, text: 'Apre la diagonale.', turnId: 'h3', effectiveModel: null, durationMs: 1 }
      ]
      const answer = await coach.hint(game(), { fen: START_FEN, pgn: '' })

      // The fake engine's best move is the first legal move in SAN order.
      expect(answer).toEqual({ move: 'Na3', uci: 'b1a3', reason: 'Apre la diagonale.' })
      expect(codex.requests).toHaveLength(3)
      expect(codex.requests[2]!.text).toContain('Spiega in una frase perché Na3')
      expect(codex.requests[2]!.outputSchema).toBeUndefined()
    })

    it('gives up when there is no engine to fall back on', async () => {
      build({ engine: fakeEngine(false) })
      await coach.start(game(), { language: 'it' })
      codex.script = [hint('Qh5xf7'), hint('Ke2xd9')]
      await expect(coach.hint(game(), { fen: START_FEN, pgn: '' })).rejects.toMatchObject({
        code: 'COACH_HINT_FAILED'
      })
    })
  })

  it('closes the thread and interrupts nothing when idle', async () => {
    await coach.start(game(), { language: 'it' })
    await coach.close()
    expect(codex.closed).toEqual(['thread-1'])
    expect(codex.interrupted).toEqual([])
    expect(coach.busy).toBe(false)
  })

  it('does not reopen a thread when close races the awaited close in start', async () => {
    await coach.start(game(), { language: 'it' })
    let release!: () => void
    const paused = new Promise<void>((resolve) => {
      release = resolve
    })
    const closeThread = vi.spyOn(codex, 'closeThread').mockImplementation(async () => {
      await paused
    })
    const restarting = coach.start(game(), { language: 'it' })
    await vi.waitFor(() => expect(closeThread).toHaveBeenCalledTimes(1))
    await coach.close()
    release()
    await restarting
    expect(codex.started).toHaveLength(1)
    expect(coach.busy).toBe(false)
    expect(
      await coach.commentOn(game(), 1, { fenBefore: START_FEN, fenAfter: AFTER_E4, pgn: '1. e4 *' })
    ).toBeNull()
  })
})
