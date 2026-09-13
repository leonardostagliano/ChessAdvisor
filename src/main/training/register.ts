import type { SessionState } from '@shared/types/session'
import type {
  AttemptResult,
  EndgameListEntry,
  Exercise,
  ExerciseKind,
  OpeningOverviewEntry,
  StudyPlanView,
  ThematicSet
} from '@shared/types/training'
import { TrainingError, type TrainingService } from './trainingService'

/**
 * The `training` namespace of `window.api` (spec §3.2).
 *
 * Same shape as the other registrars of the app: `handle` is injected, the service is the only
 * thing that knows anything, and every argument coming from the renderer is checked here before
 * it reaches it.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HandleFn = <T>(channel: string, fn: (...args: any[]) => Promise<T>) => void

export interface RegisterTrainingIpcDeps {
  handle: HandleFn
  service: TrainingService
}

const KINDS: readonly ExerciseKind[] = ['own_game', 'thematic', 'endgame']

const exerciseId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0) throw new TrainingError('BAD_EXERCISE_ID', 'an exercise id is required')
  return value
}

const text = (value: unknown, code: string, what: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TrainingError(code, `${what} is required`)
  return value.trim()
}

const kindOf = (value: unknown): ExerciseKind | undefined => (typeof value === 'string' && KINDS.includes(value as ExerciseKind) ? (value as ExerciseKind) : undefined)

export function registerTrainingIpc(deps: RegisterTrainingIpcDeps): void {
  const service = deps.service

  deps.handle('training:exercises:list', async (kind: unknown): Promise<Exercise[]> => service.list(kindOf(kind)))
  deps.handle('training:exercises:get', async (id: unknown): Promise<Exercise | null> => service.get(exerciseId(id)))
  deps.handle('training:exercises:attempt', async (id: unknown, uci: unknown): Promise<AttemptResult> => service.attempt(exerciseId(id), text(uci, 'BAD_MOVE', 'a move')))
  deps.handle('training:exercises:reset', async (id: unknown): Promise<Exercise> => service.reset(exerciseId(id)))
  deps.handle('training:exercises:explain', async (id: unknown): Promise<string> => service.explain(exerciseId(id)))

  deps.handle('training:thematic:next', async (): Promise<ThematicSet> => service.nextThematicSet())

  deps.handle('training:openings:overview', async (): Promise<OpeningOverviewEntry[]> => service.openingsOverview())
  deps.handle('training:openings:lesson', async (eco: unknown): Promise<string> => service.openingLesson(text(eco, 'BAD_ECO', 'an ECO code')))

  deps.handle('training:endgames:list', async (): Promise<EndgameListEntry[]> => service.endgames())
  deps.handle('training:endgames:start', async (id: unknown): Promise<SessionState> => service.startEndgame(text(id, 'BAD_ENDGAME_ID', 'an endgame id')))

  deps.handle('training:plan:get', async (): Promise<StudyPlanView> => service.plan())
  deps.handle('training:plan:generate', async (): Promise<StudyPlanView> => service.generatePlan())
  deps.handle('training:plan:markDone', async (itemId: unknown, done: unknown): Promise<StudyPlanView> => service.markDone(text(itemId, 'BAD_ITEM_ID', 'an item id'), done !== false))
}
