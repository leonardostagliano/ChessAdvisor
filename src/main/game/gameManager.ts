import type { ClockConfig, NewGameOptions, SessionState } from '@shared/types/session'
import { GameError, GameSession, type GameSessionDeps } from './gameSession'

/**
 * Owner of the single {@link GameSession} and of the `game` IPC namespace.
 *
 * The app plays one game at a time (spec §4.3), so the session is created once with the services
 * and lives as long as the process; `game.new()` and `game.resume()` recycle it. Keeping the IPC
 * bindings here — with `handle` injected, exactly like the updater — leaves `ipc/register.ts`
 * free of game logic.
 */

export type GameManagerDeps = Omit<GameSessionDeps, 'now'> & { now?: () => number }

export class GameManager {
  private readonly current: GameSession

  constructor(deps: GameManagerDeps) {
    this.current = new GameSession({ ...deps, now: deps.now ?? Date.now })
  }

  session(): GameSession {
    return this.current
  }

  /** True while an opponent turn is in flight; the updater refuses to install during one. */
  isBusy(): boolean {
    return this.current.isBusy()
  }

  /**
   * Settles the clocks and checks the flag after the machine woke up: while it slept the tick
   * never ran, and the main process is the only authority on the time left (spec §4.3).
   */
  async checkClock(): Promise<void> {
    await this.current
      .checkClock()
      .catch((error) => console.error('[game] the clock check failed:', error))
  }

  /** Called on quit: interrupts the running turn and leaves the game `in_progress` on disk. */
  async shutdown(): Promise<void> {
    await this.current.close().catch((error) => console.error('[game] shutdown failed:', error))
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandleFn = <T>(channel: string, fn: (...args: any[]) => Promise<T>) => void

export interface RegisterGameIpcDeps {
  handle: HandleFn
  manager: GameManager
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Bounds of a clock the dialog can ask for: from one second to three hours, increment up to 3'. */
const MIN_INITIAL_MS = 1_000
const MAX_INITIAL_MS = 3 * 60 * 60 * 1_000
const MAX_INCREMENT_MS = 3 * 60 * 1_000

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** No clock at all unless the dialog asked for a usable one (spec §4.3: "Nessuno" is the default). */
function clockConfig(raw: unknown): ClockConfig | null {
  if (!isRecord(raw)) return null
  const initial = finite(raw.initialMs)
  if (initial === null || initial < MIN_INITIAL_MS) return null
  const increment = finite(raw.incrementMs) ?? 0
  return {
    initialMs: Math.round(Math.min(initial, MAX_INITIAL_MS)),
    incrementMs: Math.round(Math.min(Math.max(0, increment), MAX_INCREMENT_MS)),
    aiClock: raw.aiClock === true
  }
}

/** The renderer sends plain JSON: nothing reaches the session before it has the expected shape. */
function newGameOptions(raw: unknown): NewGameOptions {
  if (!isRecord(raw)) throw new GameError('BAD_OPTIONS', 'the new-game options are missing')
  const difficulty = isRecord(raw.difficulty) ? raw.difficulty : {}
  const coach = isRecord(raw.coach) ? raw.coach : {}
  const model = typeof raw.model === 'string' ? raw.model : ''
  const effort = typeof raw.effort === 'string' ? raw.effort : ''
  if (!model) throw new GameError('BAD_OPTIONS', 'a model is required')
  const level =
    typeof difficulty.level === 'number' && difficulty.level >= 1 && difficulty.level <= 6
      ? Math.round(difficulty.level)
      : 3
  return {
    userColor: raw.userColor === 'w' || raw.userColor === 'b' ? raw.userColor : 'random',
    model,
    effort,
    difficulty: {
      mode: difficulty.mode === 'adaptive' ? 'adaptive' : 'fixed',
      level: level as NewGameOptions['difficulty']['level']
    },
    coach: {
      model: typeof coach.model === 'string' && coach.model ? coach.model : model,
      effort: typeof coach.effort === 'string' && coach.effort ? coach.effort : effort
    },
    language: raw.language === 'en' ? 'en' : 'it',
    showReasoning: raw.showReasoning === true,
    commentsVisible: raw.commentsVisible !== false,
    clock: clockConfig(raw.clock),
    ...(typeof raw.startFen === 'string' && raw.startFen.trim()
      ? { startFen: raw.startFen.trim() }
      : {}),
    ...(raw.kind === 'endgame_drill' ? { kind: 'endgame_drill' as const } : {})
  }
}

/** Binds the `game` namespace of `window.api`. `game:state` is also pushed as an event. */
export function registerGameIpc(deps: RegisterGameIpcDeps): void {
  const session = (): GameSession => deps.manager.session()

  deps.handle('game:new', async (opts: unknown): Promise<SessionState> =>
    session().newGame(newGameOptions(opts))
  )
  deps.handle(
    'game:resume',
    async (id: unknown, opts?: { substituteModel?: string }): Promise<SessionState> => {
      if (typeof id !== 'string' || id.length === 0)
        throw new GameError('BAD_GAME_ID', 'a game id is required')
      const substitute =
        typeof opts?.substituteModel === 'string' && opts.substituteModel.length > 0
          ? { substituteModel: opts.substituteModel }
          : undefined
      return session().resume(id, substitute)
    }
  )
  deps.handle('game:userMove', async (uci: unknown): Promise<SessionState> => {
    if (typeof uci !== 'string' || uci.length === 0)
      throw new GameError('BAD_MOVE', 'a move is required')
    return session().userMove(uci)
  })
  deps.handle('game:takeback', async (): Promise<SessionState> => session().takeback())
  deps.handle('game:resign', async (): Promise<SessionState> => session().resign())
  deps.handle('game:offerDraw', async () => session().offerDraw())
  deps.handle('game:navigateEval', async (fen: unknown) => {
    await session().navigateEval(String(fen ?? ''))
  })
  deps.handle('game:state', async (): Promise<SessionState> => session().state())
  deps.handle('game:close', async (): Promise<SessionState> => {
    await session().close()
    return session().state()
  })
  deps.handle('game:adaptiveElo', async () => session().adaptiveElo())

  // ── Task 12: the coach in game (spec §4.2) ──
  deps.handle('game:setCommentsVisible', async (visible: unknown): Promise<SessionState> =>
    session().setCommentsVisible(visible === true)
  )
  deps.handle('game:askCoach', async (question: unknown): Promise<SessionState> => {
    if (typeof question !== 'string' || question.trim().length === 0)
      throw new GameError('BAD_QUESTION', 'a question is required')
    return session().askCoach(question)
  })
  deps.handle('game:requestHint', async (): Promise<SessionState> => session().requestHint())
  deps.handle('game:clearHint', async (): Promise<SessionState> => session().clearHint())
  deps.handle('game:commentSkipped', async (): Promise<SessionState> => session().commentSkipped())
}
