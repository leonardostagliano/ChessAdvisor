import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionState } from '@shared/types/session'
import type { StudyPlanView } from '@shared/types/training'
import { EMPTY_SESSION, useGameStore } from './gameStore'
import { useTrainingStore } from './trainingStore'

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const emptyPlan: StudyPlanView = {
  plan: null,
  suggestRegenerate: false,
  invalidRefs: 0,
  gamesSincePlan: 0
}

const session: SessionState = { ...EMPTY_SESSION, status: 'playing' }

function activityKey(kind: 'explain' | 'lesson' | 'thematic', ref: string | null): string {
  return JSON.stringify([kind, ref])
}

function envelope(streamId: string, chunk: string) {
  return {
    streamId,
    threadId: 'thread-' + streamId,
    turnId: 'turn-' + streamId,
    itemId: 'item-' + streamId,
    kind: 'text' as const,
    chunk
  }
}

const explain = vi.fn<() => Promise<string>>()
const lesson = vi.fn<() => Promise<string>>()
const generate = vi.fn<() => Promise<StudyPlanView>>()
const start = vi.fn<() => Promise<SessionState>>()

function installApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      training: {
        exercises: {
          explain,
          list: vi.fn(),
          get: vi.fn(),
          attempt: vi.fn(),
          reset: vi.fn()
        },
        thematic: { next: vi.fn() },
        openings: { overview: vi.fn(), lesson },
        endgames: { list: vi.fn(), start },
        plan: { get: vi.fn(), generate, markDone: vi.fn() }
      },
      on: vi.fn(() => () => {})
    }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  installApi()
  useTrainingStore.setState({
    requests: [],
    activities: {},
    streams: {},
    lessons: {},
    explanations: {},
    plan: null,
    error: null
  })
})

describe('trainingStore concurrent requests', () => {
  it('allows an explanation to remain pending while lesson, plan and endgame actions run', async () => {
    const pendingExplanation = deferred<string>()
    explain.mockReturnValueOnce(pendingExplanation.promise)
    lesson.mockResolvedValueOnce('Opening lesson')
    generate.mockResolvedValueOnce(emptyPlan)
    start.mockResolvedValueOnce(session)

    const explanationPromise = useTrainingStore.getState().explain('ex1')
    await Promise.resolve()

    const lessonPromise = useTrainingStore.getState().lesson('B20')
    const planPromise = useTrainingStore.getState().generatePlan()
    const endgamePromise = useTrainingStore.getState().startEndgame('lucena')

    await Promise.all([lessonPromise, planPromise, endgamePromise])

    expect(explain).toHaveBeenCalledTimes(1)
    expect(lesson).toHaveBeenCalledWith('B20')
    expect(generate).toHaveBeenCalledTimes(1)
    expect(start).toHaveBeenCalledWith('lucena')
    expect(useGameStore.getState().session.status).toBe('playing')
    expect(useTrainingStore.getState().requests).toHaveLength(1)

    pendingExplanation.resolve('Explanation')
    await explanationPromise
    expect(useTrainingStore.getState().requests).toEqual([])
  })

  it('does not submit the same action twice while its request is pending', async () => {
    const pendingExplanation = deferred<string>()
    explain.mockReturnValueOnce(pendingExplanation.promise)

    const first = useTrainingStore.getState().explain('ex1')
    await Promise.resolve()
    const second = useTrainingStore.getState().explain('ex1')

    expect(explain).toHaveBeenCalledTimes(1)
    pendingExplanation.resolve('Explanation')
    await Promise.all([first, second])
    expect(useTrainingStore.getState().requests).toEqual([])
  })

  it('clears only the matching activity when a request completes without a final event', async () => {
    const pendingExplanation = deferred<string>()
    const pendingLesson = deferred<string>()
    explain.mockReturnValueOnce(pendingExplanation.promise)
    lesson.mockReturnValueOnce(pendingLesson.promise)

    const explanationPromise = useTrainingStore.getState().explain('ex1')
    const lessonPromise = useTrainingStore.getState().lesson('B20')
    await Promise.resolve()

    useTrainingStore.getState().applyChanged({
      kind: 'activity',
      activity: { kind: 'explain', ref: 'ex1', streamId: 's-explain', busy: true }
    })
    useTrainingStore.getState().applyChanged({
      kind: 'activity',
      activity: { kind: 'lesson', ref: 'B20', streamId: 's-lesson', busy: true }
    })

    pendingExplanation.resolve('Explanation')
    await explanationPromise

    const state = useTrainingStore.getState()
    expect(state.activities[activityKey('explain', 'ex1')]).toBeUndefined()
    expect(state.activities[activityKey('lesson', 'B20')]).toMatchObject({
      streamId: 's-lesson',
      busy: true
    })
    expect(state.requests).toEqual([{ kind: 'lesson', ref: 'B20' }])

    pendingLesson.resolve('Lesson')
    await lessonPromise
  })

  it('clears only the matching activity when a request rejects without a final event', async () => {
    const pendingExplanation = deferred<string>()
    const pendingLesson = deferred<string>()
    explain.mockReturnValueOnce(pendingExplanation.promise)
    lesson.mockReturnValueOnce(pendingLesson.promise)

    const explanationPromise = useTrainingStore.getState().explain('ex1')
    const lessonPromise = useTrainingStore.getState().lesson('B20')
    await Promise.resolve()

    useTrainingStore.getState().applyChanged({
      kind: 'activity',
      activity: { kind: 'explain', ref: 'ex1', streamId: 's-explain', busy: true }
    })
    useTrainingStore.getState().applyChanged({
      kind: 'activity',
      activity: { kind: 'lesson', ref: 'B20', streamId: 's-lesson', busy: true }
    })

    pendingExplanation.reject(new Error('connection lost'))
    await explanationPromise

    const state = useTrainingStore.getState()
    expect(state.activities[activityKey('explain', 'ex1')]).toBeUndefined()
    expect(state.activities[activityKey('lesson', 'B20')]).toMatchObject({
      streamId: 's-lesson',
      busy: true
    })
    expect(state.requests).toEqual([{ kind: 'lesson', ref: 'B20' }])

    pendingLesson.resolve('Lesson')
    await lessonPromise
  })

  it('keeps overlapping stream chunks in their own stream buffers', () => {
    const store = useTrainingStore.getState()
    store.applyChanged({
      kind: 'activity',
      activity: { kind: 'explain', ref: 'ex1', streamId: 's-explain', busy: true }
    })
    store.applyChanged({
      kind: 'activity',
      activity: { kind: 'lesson', ref: 'B20', streamId: 's-lesson', busy: true }
    })

    store.applyStream(envelope('s-explain', 'explain '))
    store.applyStream(envelope('s-lesson', 'lesson '))
    store.applyStream(envelope('s-explain', 'text'))
    store.applyStream(envelope('s-lesson', 'text'))

    expect(useTrainingStore.getState().streams).toEqual({
      's-explain': 'explain text',
      's-lesson': 'lesson text'
    })
  })
})

describe('training refresh ordering', () => {
  it('keeps the latest plan when a previous read completes late', async () => {
    const pending = deferred<StudyPlanView>()
    vi.mocked(window.api.training.plan.get)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ ...emptyPlan, gamesSincePlan: 2 })
    const first = useTrainingStore.getState().refreshPlan()
    await useTrainingStore.getState().refreshPlan()
    pending.resolve(emptyPlan)
    await first
    expect(useTrainingStore.getState().plan?.gamesSincePlan).toBe(2)
  })

  it('does not restore an exercise deleted while an older list was loading', async () => {
    const pending = deferred<Awaited<ReturnType<Window['api']['training']['exercises']['list']>>>()
    vi.mocked(window.api.training.exercises.list)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([])
    vi.mocked(window.api.training.endgames.list).mockResolvedValue([])
    useTrainingStore.setState({ selectedExercise: 'deleted' })
    const first = useTrainingStore.getState().refreshExercises()
    await useTrainingStore.getState().refreshExercises()
    pending.resolve([{ id: 'deleted' } as never])
    await first
    expect(useTrainingStore.getState().exercises).toEqual([])
    expect(useTrainingStore.getState().selectedExercise).toBeNull()
  })
})
