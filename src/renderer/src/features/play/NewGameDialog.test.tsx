import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ModelInfo } from '@shared/types/codex'
import type { Settings } from '@shared/types/settings'
import { DEFAULT_SETTINGS } from '@shared/types/settings'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import { useCodexStore } from '../../stores/codexStore'
import { EMPTY_SESSION, useGameStore } from '../../stores/gameStore'
import { NewGameDialog } from './NewGameDialog'

const MODELS: ModelInfo[] = [
  {
    id: 'gpt-6-astra',
    displayName: 'GPT-6 Astra',
    description: 'the default model',
    isDefault: true,
    defaultEffort: 'medium',
    efforts: [
      { id: 'low', description: 'fast' },
      { id: 'medium', description: 'balanced' },
      { id: 'high', description: 'slow' },
      { id: 'ultra', description: 'slowest' }
    ]
  },
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    description: 'the previous model',
    isDefault: false,
    defaultEffort: 'low',
    efforts: [
      { id: 'low', description: 'fast' },
      { id: 'xhigh', description: 'very slow' }
    ]
  }
]

let settings: Settings
let saved: Partial<Settings>[]
let started: unknown[]

function stubBridge(adaptive: { elo: number; games: number } | null = null): void {
  saved = []
  started = []
  const api = {
    settings: {
      get: vi.fn(async () => settings),
      save: vi.fn(async (patch: Partial<Settings>) => {
        saved.push(patch)
        settings = { ...settings, ...patch }
        return settings
      })
    },
    game: {
      adaptiveElo: vi.fn(async () => adaptive),
      new: vi.fn(async (options: unknown) => {
        started.push(options)
        return EMPTY_SESSION
      })
    }
  }
  Object.defineProperty(window, 'api', { value: api, configurable: true, writable: true })
}

/** Opens a Select popup and returns its listbox. */
async function openSelect(name: RegExp): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('combobox', { name }))
  return screen.findByRole('listbox', { name })
}

function optionTexts(listbox: HTMLElement): (string | null)[] {
  return within(listbox)
    .getAllByRole('option')
    .map((option) => option.textContent)
}

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS }
  stubBridge()
  useCodexStore.setState({ models: MODELS, ready: true })
  useGameStore.setState({ session: EMPTY_SESSION, browsePly: null, busy: false, error: null })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('NewGameDialog', () => {
  it('offers the seven difficulty options with their target Elo', async () => {
    render(<NewGameDialog open onClose={() => {}} />)
    const group = await screen.findByRole('radiogroup', { name: /difficolt/i })
    const options = within(group).getAllByRole('radio')

    expect(options).toHaveLength(7)
    expect(options.map((option) => option.textContent)).toEqual([
      'Principiante~600',
      'Facile~900',
      'Medio~1200',
      'Impegnativo~1500',
      'Forte~1800',
      'Massimoal massimo',
      'Adattivaparte da 1200'
    ])
    // The last difficulty stored in the settings is preselected.
    expect(within(group).getByRole('radio', { name: /Medio/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('shows the current adaptive rating under the adaptive option', async () => {
    stubBridge({ elo: 1275, games: 4 })
    render(<NewGameDialog open onClose={() => {}} />)
    expect(await screen.findByText('~1275')).toBeInTheDocument()
  })

  it('lists the efforts of the selected model and follows a model change', async () => {
    render(<NewGameDialog open onClose={() => {}} />)
    await screen.findByRole('radiogroup', { name: /difficolt/i })

    let listbox = await openSelect(/ragionamento/i)
    expect(optionTexts(listbox)).toEqual(['Bassofast', 'Mediobalanced', 'Altoslow', 'Estremoslowest'])
    fireEvent.keyDown(listbox, { key: 'Escape' })

    listbox = await openSelect(/modello/i)
    fireEvent.click(within(listbox).getByRole('option', { name: /GPT-5\.5/ }))

    listbox = await openSelect(/ragionamento/i)
    expect(optionTexts(listbox)).toEqual(['Bassofast', 'Molto altovery slow'])
  })

  it('hints at the effort that suits the chosen difficulty', async () => {
    render(<NewGameDialog open onClose={() => {}} />)
    const group = await screen.findByRole('radiogroup', { name: /difficolt/i })

    expect(screen.getByText(/impegno basso o medio/i)).toBeInTheDocument()
    fireEvent.click(within(group).getByRole('radio', { name: /Massimo/ }))
    expect(screen.getByText(/impegno alto/i)).toBeInTheDocument()
    fireEvent.click(within(group).getByRole('radio', { name: /Impegnativo/ }))
    expect(screen.queryByText(/impegno basso o medio/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/impegno alto/i)).not.toBeInTheDocument()
  })

  it('starts the game and remembers model, effort and difficulty', async () => {
    const onClose = vi.fn()
    render(<NewGameDialog open onClose={onClose} />)
    const group = await screen.findByRole('radiogroup', { name: /difficolt/i })

    fireEvent.click(within(group).getByRole('radio', { name: /Adattiva/ }))
    fireEvent.click(screen.getByRole('radio', { name: 'Nero' }))
    fireEvent.click(screen.getByRole('switch', { name: /ragionamento/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Inizia partita' }))

    await waitFor(() => expect(started).toHaveLength(1))
    expect(started[0]).toMatchObject({
      userColor: 'b',
      model: 'gpt-6-astra',
      effort: 'medium',
      difficulty: { mode: 'adaptive', level: 3 },
      coach: { model: 'gpt-6-astra', effort: 'medium' },
      showReasoning: true,
      commentsVisible: true
    })
    expect(saved.at(-1)).toMatchObject({
      defaultModel: 'gpt-6-astra',
      defaultEffort: 'medium',
      lastDifficulty: { mode: 'adaptive', level: 3 }
    })
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('explains that no model is playable when Codex has none', async () => {
    useCodexStore.setState({ models: [], ready: false })
    render(<NewGameDialog open onClose={() => {}} />)
    expect(await screen.findByText(/Nessun modello disponibile/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inizia partita' })).toBeDisabled()
  })
})
