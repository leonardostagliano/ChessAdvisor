import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { StudyPlanItem, StudyPlanView } from '@shared/types/training'
import { useTrainingStore } from '../../stores/trainingStore'
import { useUiStore } from '../../stores/uiStore'
import { StudyPlanSummary, StudyPlanTab, planProgress } from './StudyPlanTab'

/**
 * The study plan (spec §6.8): the items the coach wrote, what the user has ticked off, and the
 * two reasons the app has to propose a new plan — too many games played since, or too many
 * references that do not point at anything any more.
 */

function item(patch: Partial<StudyPlanItem> = {}): StudyPlanItem {
  return {
    id: 'i1',
    title: 'Dieci forchette',
    why: 'Le perdi spesso nei momenti chiave.',
    activity: { type: 'thematic', ref: 'fork' },
    done: false,
    ...patch
  }
}

function view(
  patch: Partial<StudyPlanView> = {},
  items: StudyPlanItem[] = [item()]
): StudyPlanView {
  return {
    plan: { generatedAt: '2026-09-13T09:00:00.000Z', items },
    suggestRegenerate: false,
    invalidRefs: 0,
    gamesSincePlan: 1,
    ...patch
  }
}

const generate = vi.fn(async (): Promise<StudyPlanView> => view())
const markDone = vi.fn(async (_id: string, done: boolean): Promise<StudyPlanView> =>
  view({}, [item({ done })])
)

function mockApi(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { training: { plan: { get: vi.fn(), generate, markDone } }, on: () => () => {} }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi()
  useTrainingStore.setState({
    tab: 'plan',
    plan: null,
    requests: [],
    selectedExercise: null,
    selectedOpening: null,
    error: null
  })
  useUiStore.setState({ area: 'training', reviewTarget: null })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

describe('StudyPlanTab', () => {
  it('offers to write the first plan when there is none', async () => {
    render(<StudyPlanTab />)
    expect(screen.getByText('Nessun piano di studio')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Genera il piano' }))
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.getByTestId('study-plan')).toBeInTheDocument())
  })

  it('lists the activities with their reason and counts the ones already done', () => {
    useTrainingStore.setState({
      plan: view({}, [
        item(),
        item({
          id: 'i2',
          title: 'Lucena',
          why: 'Il finale che chiudi peggio.',
          activity: { type: 'endgame', ref: 'lucena' },
          done: true
        })
      ])
    })
    render(<StudyPlanTab />)
    const plan = screen.getByTestId('study-plan')
    expect(within(plan).getByText('Dieci forchette')).toBeInTheDocument()
    expect(within(plan).getByText('Le perdi spesso nei momenti chiave.')).toBeInTheDocument()
    expect(screen.getByTestId('plan-progress')).toHaveTextContent('1 di 2 completate')
    expect(planProgress(useTrainingStore.getState().plan)).toEqual({ done: 1, total: 2 })
  })

  it('ticks an activity off through the main process', async () => {
    useTrainingStore.setState({ plan: view() })
    render(<StudyPlanTab />)
    fireEvent.click(screen.getByRole('checkbox'))
    await waitFor(() => expect(markDone).toHaveBeenCalledWith('i1', true))
    await waitFor(() => expect(screen.getByRole('checkbox')).toBeChecked())
  })

  it('takes the user to the material an activity points at', () => {
    useTrainingStore.setState({
      plan: view({}, [
        item({ id: 'i2', activity: { type: 'own_game', ref: 'og-g1-7' } }),
        item({ id: 'i3', activity: { type: 'opening', ref: 'B20' } }),
        item({ id: 'i4', activity: { type: 'play', ref: null } })
      ])
    })
    render(<StudyPlanTab />)
    const open = screen.getAllByRole('button', { name: 'Apri' })

    fireEvent.click(open[0]!)
    expect(useTrainingStore.getState().tab).toBe('own')
    expect(useTrainingStore.getState().selectedExercise).toBe('og-g1-7')

    fireEvent.click(open[1]!)
    expect(useTrainingStore.getState().tab).toBe('openings')
    expect(useTrainingStore.getState().selectedOpening).toBe('B20')

    fireEvent.click(open[2]!)
    expect(useUiStore.getState().area).toBe('play')
  })

  it('marks an activity whose material is gone and degrades it to its generic form', () => {
    useTrainingStore.setState({
      plan: view({}, [
        item({ id: 'i5', activity: { type: 'opening', ref: 'A00' }, invalidRef: true })
      ])
    })
    render(<StudyPlanTab />)
    expect(
      screen.getByText('Il materiale di questa attività non esiste più: resta l’attività generica.')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Apri' }))
    expect(useTrainingStore.getState().tab).toBe('openings')
    expect(useTrainingStore.getState().selectedOpening).toBeNull()
  })

  it('says when the plan is stale, counting the games or the dangling references', () => {
    useTrainingStore.setState({ plan: view({ suggestRegenerate: true, gamesSincePlan: 6 }) })
    const { rerender } = render(<StudyPlanTab />)
    expect(screen.getByTestId('plan-stale')).toHaveTextContent('Hai giocato 6 partite')

    useTrainingStore.setState({
      plan: view({ suggestRegenerate: true, invalidRefs: 3, gamesSincePlan: 1 })
    })
    rerender(<StudyPlanTab />)
    expect(screen.getByTestId('plan-stale')).toHaveTextContent(
      '3 attività puntano a materiale che non esiste più'
    )
  })

  it('writes a new plan on demand, keeping the same link', async () => {
    useTrainingStore.setState({ plan: view() })
    render(<StudyPlanTab />)
    fireEvent.click(screen.getByRole('button', { name: 'Rigenera' }))
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
  })
})

describe('StudyPlanSummary', () => {
  it('offers the first plan from the dashboard', async () => {
    render(<StudyPlanSummary />)
    expect(
      screen.getByText('Il coach non ha ancora scritto un piano di studio.')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Genera il piano' }))
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
  })

  it('shows the progress and the next activities, and opens the section on them', () => {
    useTrainingStore.setState({
      tab: 'own',
      plan: view({}, [item({ done: true }), item({ id: 'i2', title: 'Lucena' })])
    })
    useUiStore.setState({ area: 'progress' })
    render(<StudyPlanSummary />)
    const card = screen.getByTestId('study-plan-summary')
    expect(within(card).getByText('1 di 2 completate')).toBeInTheDocument()
    expect(within(card).getByText('Lucena')).toBeInTheDocument()
    expect(within(card).queryByText('Dieci forchette')).toBeNull()

    fireEvent.click(within(card).getByRole('button', { name: 'Apri il piano' }))
    expect(useTrainingStore.getState().tab).toBe('plan')
    expect(useUiStore.getState().area).toBe('training')
  })
})
