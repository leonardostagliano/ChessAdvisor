import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ModelInfo } from '@shared/types/codex'
import type { Settings } from '@shared/types/settings'
import { DEFAULT_SETTINGS } from '@shared/types/settings'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import { useCodexStore } from '../../stores/codexStore'
import { EMPTY_SESSION, useGameStore } from '../../stores/gameStore'
import { NewGameDialog, clockOf, needsClockWarning } from './NewGameDialog'

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

describe('clockOf', () => {
  it('answers null for "Nessuno" and milliseconds for everything else', () => {
    expect(clockOf('none', 10, 5, false)).toBeNull()
    expect(clockOf('5+0', 10, 5, false)).toEqual({ initialMs: 300_000, incrementMs: 0, aiClock: false })
    expect(clockOf('custom', 3, 2, true)).toEqual({ initialMs: 180_000, incrementMs: 2_000, aiClock: true })
  })

  it('keeps a custom time control inside usable bounds', () => {
    expect(clockOf('custom', 0, 5, false)).toBeNull()
    expect(clockOf('custom', 10_000, 10_000, false)).toEqual({
      initialMs: 180 * 60_000,
      incrementMs: 180_000,
      aiClock: false
    })
  })
})

describe('needsClockWarning', () => {
  it('fires only for a high effort on a short time control the AI also runs', () => {
    const short = { initialMs: 300_000, incrementMs: 0, aiClock: true }
    expect(needsClockWarning(short, 'high')).toBe(true)
    expect(needsClockWarning({ ...short, initialMs: 600_000 }, 'xhigh')).toBe(true)
    expect(needsClockWarning(short, 'medium')).toBe(false)
    expect(needsClockWarning({ ...short, aiClock: false }, 'high')).toBe(false)
    expect(needsClockWarning({ ...short, initialMs: 900_000, incrementMs: 10_000 }, 'high')).toBe(false)
    expect(needsClockWarning(null, 'high')).toBe(false)
  })
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

  it('behaves like a radio group: a single Tab stop and arrow keys that move the choice', async () => {
    render(<NewGameDialog open onClose={() => {}} />)
    const group = await screen.findByRole('radiogroup', { name: /difficolt/i })
    const options = within(group).getAllByRole('radio')

    // "Medio" is the remembered choice, so it is the only option Tab can land on.
    expect(options.map((option) => option.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1, -1])

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(within(group).getByRole('radio', { name: /Impegnativo/ })).toHaveAttribute('aria-checked', 'true')
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: /Impegnativo/ }))

    fireEvent.keyDown(group, { key: 'ArrowUp' })
    expect(within(group).getByRole('radio', { name: /Medio/ })).toHaveAttribute('aria-checked', 'true')

    fireEvent.keyDown(group, { key: 'End' })
    expect(within(group).getByRole('radio', { name: /Adattiva/ })).toHaveAttribute('aria-checked', 'true')

    // The arrows wrap around, as the radio-group pattern prescribes.
    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(within(group).getByRole('radio', { name: /Principiante/ })).toHaveAttribute('aria-checked', 'true')

    const colors = screen.getByRole('radiogroup', { name: 'Colore' })
    expect(within(colors).getAllByRole('radio').map((option) => option.tabIndex)).toEqual([0, -1, -1])
    fireEvent.keyDown(colors, { key: 'ArrowLeft' })
    expect(within(colors).getByRole('radio', { name: 'Casuale' })).toHaveAttribute('aria-checked', 'true')
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

  it('offers the clock presets and starts with none of them', async () => {
    render(<NewGameDialog open onClose={() => {}} />)
    const group = await screen.findByRole('radiogroup', { name: 'Orologio' })

    expect(within(group).getAllByRole('radio').map((option) => option.textContent)).toEqual([
      'Nessuno',
      '5+0',
      '10+0',
      '15+10',
      'Personalizzato'
    ])
    expect(within(group).getByRole('radio', { name: 'Nessuno' })).toHaveAttribute('aria-checked', 'true')
    // The mode only exists once there is a clock to share (spec §4.3).
    expect(screen.queryByRole('radiogroup', { name: 'Modalità' })).not.toBeInTheDocument()

    fireEvent.click(within(group).getByRole('radio', { name: '15+10' }))
    expect(screen.getByRole('radiogroup', { name: 'Modalità' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Solo il mio tempo' })).toHaveAttribute('aria-checked', 'true')
  })

  it('passes the chosen time control to the new game', async () => {
    render(<NewGameDialog open onClose={() => {}} />)
    const clocks = await screen.findByRole('radiogroup', { name: 'Orologio' })

    fireEvent.click(within(clocks).getByRole('radio', { name: '15+10' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Orologio anche per l’AI' }))
    fireEvent.click(screen.getByRole('button', { name: 'Inizia partita' }))

    await waitFor(() => expect(started).toHaveLength(1))
    expect(started[0]).toMatchObject({ clock: { initialMs: 900_000, incrementMs: 10_000, aiClock: true } })
  })

  it('takes the custom time control from its two inputs', async () => {
    render(<NewGameDialog open onClose={() => {}} />)
    const clocks = await screen.findByRole('radiogroup', { name: 'Orologio' })

    fireEvent.click(within(clocks).getByRole('radio', { name: 'Personalizzato' }))
    fireEvent.change(screen.getByLabelText('Minuti'), { target: { value: '3' } })
    fireEvent.change(screen.getByLabelText('Incremento (secondi)'), { target: { value: '2' } })
    fireEvent.click(screen.getByRole('button', { name: 'Inizia partita' }))

    await waitFor(() => expect(started).toHaveLength(1))
    expect(started[0]).toMatchObject({ clock: { initialMs: 180_000, incrementMs: 2_000, aiClock: false } })
  })

  it('makes the user choose before giving the AI a clock it will flag on', async () => {
    render(<NewGameDialog open onClose={() => {}} />)
    await screen.findByRole('radiogroup', { name: /difficolt/i })

    // gpt-6-astra with a high effort, 5+0, clock for the AI too: the case of spec §4.3.
    const listbox = await openSelect(/ragionamento/i)
    fireEvent.click(within(listbox).getByRole('option', { name: /Alto/ }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Orologio' })).getByRole('radio', { name: '5+0' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Orologio anche per l’AI' }))
    fireEvent.click(screen.getByRole('button', { name: 'Inizia partita' }))

    const warning = await screen.findByText(/rischia di perdere per tempo/)
    expect(warning).toBeInTheDocument()
    expect(started).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Solo il mio tempo' }))
    await waitFor(() => expect(started).toHaveLength(1))
    expect(started[0]).toMatchObject({ effort: 'high', clock: { initialMs: 300_000, aiClock: false } })
  })

  it('starts the risky game as it is when the user insists', async () => {
    render(<NewGameDialog open onClose={() => {}} />)
    await screen.findByRole('radiogroup', { name: /difficolt/i })

    const listbox = await openSelect(/ragionamento/i)
    fireEvent.click(within(listbox).getByRole('option', { name: /Alto/ }))
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Orologio' })).getByRole('radio', { name: '10+0' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Orologio anche per l’AI' }))
    fireEvent.click(screen.getByRole('button', { name: 'Inizia partita' }))

    await screen.findByText(/rischia di perdere per tempo/)
    fireEvent.click(screen.getByRole('button', { name: 'Continua comunque' }))
    await waitFor(() => expect(started).toHaveLength(1))
    expect(started[0]).toMatchObject({ clock: { initialMs: 600_000, incrementMs: 0, aiClock: true } })
  })

  it('explains that no model is playable when Codex has none', async () => {
    useCodexStore.setState({ models: [], ready: false })
    render(<NewGameDialog open onClose={() => {}} />)
    expect(await screen.findByText(/Nessun modello disponibile/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Inizia partita' })).toBeDisabled()
  })
})
