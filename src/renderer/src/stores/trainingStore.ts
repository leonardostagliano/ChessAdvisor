import { create } from 'zustand'
import { parseIpcError } from '@shared/ipcError'
import type { StreamEnvelope } from '@shared/types/api'
import type {
  AttemptResult,
  EndgameListEntry,
  Exercise,
  OpeningOverviewEntry,
  StudyPlanView,
  ThematicSet,
  TrainingActivity,
  TrainingChanged
} from '@shared/types/training'
import { useGameStore } from './gameStore'
import { useUiStore } from './uiStore'

/**
 * Renderer state of the training section (spec §6.4–§6.8).
 *
 * The main process owns every file behind it — the exercises, the plan, the bundled datasets — so
 * this store is a mirror plus the few things that only exist while somebody is looking: which tab
 * is open, which exercise or opening is selected, and the text of the coach turn that is streaming
 * right now. `training:changed` is the single event it follows: a change of the exercises or of
 * the plan re-reads them, an `activity` announces a turn before it starts so its `streamId` can be
 * followed from the first delta.
 *
 * One rule runs through the actions: a failure never empties what is already on screen. A request
 * that fails leaves the previous data alone and writes a message next to the button that asked.
 */

export type TrainingTab = 'own' | 'thematic' | 'openings' | 'endgames' | 'plan'

export const TRAINING_TABS: readonly TrainingTab[] = [
  'own',
  'thematic',
  'openings',
  'endgames',
  'plan'
]

/** What *this* window asked for; only the button that asked disables itself on it. */
export interface TrainingRequest {
  kind: 'thematic' | 'plan' | 'lesson' | 'explain' | 'endgame'
  /** Exercise id, ECO code, endgame id — `null` for the requests that are about nothing. */
  ref: string | null
}

export interface TrainingStoreState {
  tab: TrainingTab
  exercises: Exercise[]
  endgames: EndgameListEntry[]
  openings: OpeningOverviewEntry[]
  plan: StudyPlanView | null
  thematic: ThematicSet | null
  /** Mini-lessons already written in this window, by ECO code. */
  lessons: Record<string, string>
  /** Explanations already written in this window, by exercise id. */
  explanations: Record<string, string>
  /** Exercise the "from your games" tab is playing. */
  selectedExercise: string | null
  /** Opening whose deviations and lesson are open. */
  selectedOpening: string | null
  /** True while the first read of the section is in flight. */
  loading: boolean
  requests: TrainingRequest[]
  activities: Record<string, TrainingActivity>
  /** Each concurrent coach turn keeps its own text. */
  streams: Record<string, string>
  error: string | null

  setTab(tab: TrainingTab): void
  selectExercise(id: string | null): void
  selectOpening(eco: string | null): void
  load(): Promise<void>
  refreshExercises(): Promise<void>
  refreshPlan(): Promise<void>
  loadOpenings(): Promise<void>
  nextThematic(): Promise<void>
  lesson(eco: string): Promise<void>
  explain(id: string): Promise<void>
  attempt(id: string, uci: string): Promise<AttemptResult | null>
  reset(id: string): Promise<void>
  startEndgame(id: string): Promise<void>
  generatePlan(): Promise<void>
  markDone(itemId: string, done: boolean): Promise<void>
  clearError(): void

  applyChanged(event: TrainingChanged): void
  applyStream(envelope: StreamEnvelope): void
}

/** The bridge is absent in unit tests and in a renderer opened without the preload. */
function bridge(): Window['api'] | undefined {
  return typeof window === 'undefined' ? undefined : window.api
}

function failure(error: unknown): string {
  const { message, code } = parseIpcError(error)
  return message.length > 0 ? message : code
}

/** Exercises of one kind, in the order the main process listed them (newest first). */
export function exercisesOfKind(
  exercises: readonly Exercise[],
  kind: Exercise['kind']
): Exercise[] {
  return exercises.filter((exercise) => exercise.kind === kind)
}

/** How many of a set have been solved, read from the exercises the store mirrors. */
export function solvedCount(exercises: readonly Exercise[], set: ThematicSet | null): number {
  if (!set) return 0
  const byId = new Map(exercises.map((exercise) => [exercise.id, exercise]))
  return set.exercises.filter((exercise) => (byId.get(exercise.id) ?? exercise).status === 'solved')
    .length
}

function activityKey(kind: string, ref: string | null): string {
  return JSON.stringify([kind, ref])
}

export const useTrainingStore = create<TrainingStoreState>((set, get) => {
  /**
   * One request that can fail. Like the coach's turns, it is deliberately outside any global busy
   * flag: writing a lesson can take half a minute and must grey out its own button only.
   */
  async function ask(
    request: TrainingRequest,
    run: (api: Window['api']) => Promise<void>
  ): Promise<void> {
    const api = bridge()
    if (!api) return
    // Independent tabs remain usable; identical actions and simultaneous game starts are deduped.
    if (
      get().requests.some(
        (active) =>
          active.kind === request.kind && (request.kind === 'endgame' || active.ref === request.ref)
      )
    )
      return
    set({ requests: [...get().requests, request], error: null })
    try {
      await run(api)
    } catch (error) {
      set({ error: failure(error) })
    } finally {
      const kind = request.kind === 'plan' ? 'lesson' : request.kind
      const key = activityKey(kind, request.ref)
      const activities = { ...get().activities }
      const streams = { ...get().streams }
      const streamId = activities[key]?.streamId
      delete activities[key]
      if (streamId) delete streams[streamId]
      // Completion may happen while the screen is unmounted and its event listener is absent.
      set({ requests: get().requests.filter((active) => active !== request), activities, streams })
    }
  }

  return {
    tab: 'own',
    exercises: [],
    endgames: [],
    openings: [],
    plan: null,
    thematic: null,
    lessons: {},
    explanations: {},
    selectedExercise: null,
    selectedOpening: null,
    loading: false,
    requests: [],
    activities: {},
    streams: {},
    error: null,

    setTab(tab) {
      if (!TRAINING_TABS.includes(tab) || get().tab === tab) return
      set({ tab })
      if (tab === 'openings' && get().openings.length === 0) void get().loadOpenings()
    },

    selectExercise(id) {
      set({ selectedExercise: id })
    },

    selectOpening(eco) {
      set({ selectedOpening: eco })
    },

    /** Everything the section shows before anybody asks for anything: the material on disk. */
    async load() {
      const api = bridge()
      if (!api) return
      set({ loading: true, error: null })
      try {
        const [exercises, endgames, plan] = await Promise.all([
          api.training.exercises.list(),
          api.training.endgames.list(),
          api.training.plan.get()
        ])
        set({ exercises, endgames, plan, loading: false })
      } catch (error) {
        set({ loading: false, error: failure(error) })
      }
    },

    async refreshExercises() {
      const api = bridge()
      if (!api) return
      try {
        const [exercises, endgames] = await Promise.all([
          api.training.exercises.list(),
          api.training.endgames.list()
        ])
        set({ exercises, endgames })
      } catch {
        // A refresh that fails leaves the list as it was: the event will come again.
      }
    },

    async refreshPlan() {
      const api = bridge()
      if (!api) return
      try {
        set({ plan: await api.training.plan.get() })
      } catch {
        /* same as above: the plan on screen stays */
      }
    },

    async loadOpenings() {
      const api = bridge()
      if (!api) return
      try {
        set({ openings: await api.training.openings.overview() })
      } catch (error) {
        set({ error: failure(error) })
      }
    },

    async nextThematic() {
      await ask({ kind: 'thematic', ref: null }, async (api) => {
        const thematic = await api.training.thematic.next()
        set({ thematic })
        await get().refreshExercises()
      })
    },

    async lesson(eco) {
      await ask({ kind: 'lesson', ref: eco }, async (api) => {
        const text = await api.training.openings.lesson(eco)
        set({ lessons: { ...get().lessons, [eco]: text } })
      })
    },

    async explain(id) {
      await ask({ kind: 'explain', ref: id }, async (api) => {
        const text = await api.training.exercises.explain(id)
        set({ explanations: { ...get().explanations, [id]: text } })
      })
    },

    /**
     * One move played inside an exercise. The answer says what the board must show next, so it is
     * handed back to the player instead of being mirrored here; only the record changes, and the
     * main process announces that on its own event.
     */
    async attempt(id, uci) {
      const api = bridge()
      if (!api) return null
      try {
        return await api.training.exercises.attempt(id, uci)
      } catch (error) {
        set({ error: failure(error) })
        return null
      }
    },

    async reset(id) {
      const api = bridge()
      if (!api) return
      try {
        const exercise = await api.training.exercises.reset(id)
        set({
          exercises: get().exercises.map((entry) => (entry.id === exercise.id ? exercise : entry))
        })
      } catch (error) {
        set({ error: failure(error) })
      }
    },

    /** "Gioca" of an endgame (spec §6.7): the drill starts and the user lands on the board. */
    async startEndgame(id) {
      await ask({ kind: 'endgame', ref: id }, async (api) => {
        const session = await api.training.endgames.start(id)
        useGameStore.getState().apply(session)
        useUiStore.getState().setArea('play')
      })
    },

    async generatePlan() {
      await ask({ kind: 'plan', ref: null }, async (api) => {
        set({ plan: await api.training.plan.generate() })
      })
    },

    async markDone(itemId, done) {
      const api = bridge()
      if (!api) return
      try {
        set({ plan: await api.training.plan.markDone(itemId, done) })
      } catch (error) {
        set({ error: failure(error) })
      }
    },

    clearError() {
      set({ error: null })
    },

    applyChanged(event) {
      if (!event) return
      if (event.kind === 'exercises') {
        void get().refreshExercises()
        return
      }
      if (event.kind === 'plan') {
        void get().refreshPlan()
        return
      }
      const activity = event.activity
      if (!activity) return
      const key = activityKey(activity.kind, activity.ref)
      const activities = { ...get().activities }
      const streams = { ...get().streams }
      const previous = activities[key]
      if (previous?.streamId && previous.streamId !== activity.streamId)
        delete streams[previous.streamId]
      if (activity.busy && activity.streamId) activities[key] = activity
      else delete activities[key]
      set({ activities, streams })
    },

    applyStream(envelope) {
      if (!envelope || envelope.kind !== 'text') return
      if (
        !Object.values(get().activities).some((activity) => activity.streamId === envelope.streamId)
      )
        return
      set({
        streams: {
          ...get().streams,
          [envelope.streamId]: (get().streams[envelope.streamId] ?? '') + envelope.chunk
        }
      })
    }
  }
})

/**
 * The text streaming right now for `kind`/`ref`, or `null` when the turn on the wire is another
 * one. It is what tells an explanation card from a lesson card while both are on screen.
 */
export function streamingText(
  state: TrainingStoreState,
  kind: TrainingActivity['kind'],
  ref: string | null
): string | null {
  const activity = state.activities[activityKey(kind, ref)]
  if (!activity?.busy || !activity.streamId) return null
  return state.streams[activity.streamId] ?? ''
}

/**
 * Subscribes the store to the two channels the section listens to and reads the material once.
 * The screen calls it while it is mounted; the returned function unsubscribes.
 */
export function initTrainingStore(): () => void {
  const api = bridge()
  if (!api) return () => {}
  const unsubscribe = [
    api.on('training:changed', (event) => useTrainingStore.getState().applyChanged(event)),
    api.on('stream', (envelope) => useTrainingStore.getState().applyStream(envelope))
  ]
  void useTrainingStore.getState().load()
  return () => {
    for (const stop of unsubscribe) stop()
  }
}
