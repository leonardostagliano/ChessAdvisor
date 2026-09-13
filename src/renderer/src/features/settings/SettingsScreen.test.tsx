import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { CodexState } from '@shared/types/codex'
import type { Settings } from '@shared/types/settings'
import { DEFAULT_SETTINGS } from '@shared/types/settings'
import { INITIAL_CODEX_STATE, useCodexStore } from '../../stores/codexStore'
import { INITIAL_ENGINE_STATE, useEngineStore } from '../../stores/engineStore'
import { SettingsScreen, quotaResetDate } from './SettingsScreen'

/**
 * Settings against a mocked bridge (spec §4.3, §8).
 *
 * The point of these cases is that nothing in the screen invents data: the model and effort
 * lists come from the mirrored Codex catalogue, the effort list narrows to the model actually
 * selected, and the Codex and engine blocks read the published state rather than a guess.
 */

const READY: CodexState = {
  status: 'ready',
  account: { email: 'user@example.com', planType: 'pro' },
  cliVersion: '0.155.0',
  versionMismatch: true,
  models: [
    {
      id: 'gpt-6-astra',
      displayName: 'GPT-6 Astra',
      description: 'Il modello predefinito',
      isDefault: true,
      defaultEffort: 'medium',
      efforts: [
        { id: 'low', description: 'rapido' },
        { id: 'medium', description: 'equilibrato' },
        { id: 'high', description: 'lento e accurato' }
      ]
    },
    {
      id: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: 'Piu economico',
      isDefault: false,
      defaultEffort: 'low',
      efforts: [{ id: 'low', description: 'rapido' }]
    }
  ],
  quota: {
    ordinaryUsageAllowed: true,
    primary: { usedPercent: 42.4, windowDurationMins: 300, resetsAt: 1_789_000_000 },
    secondary: null,
    rateLimitReachedType: null,
    planType: 'pro'
  }
}

const save = vi.fn(async (patch: Partial<Settings>) => ({ ...DEFAULT_SETTINGS, ...patch }))

function mockApi(settings: Partial<Settings> = {}): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      settings: { get: async () => ({ ...DEFAULT_SETTINGS, ...settings }), save },
      app: { versionInfo: async () => ({ version: '0.1.0', isPackaged: false }), readNotices: async () => '' },
      on: () => () => {}
    }
  })
}

/** Opens a Select by its accessible name and returns the labels of its popup options. */
async function optionsOf(name: string): Promise<string[]> {
  await act(async () => {
    fireEvent.click(screen.getByRole('combobox', { name }))
  })
  const list = await screen.findByRole('listbox', { name })
  return Array.from(list.querySelectorAll('[role="option"]')).map((node) => (node.textContent ?? '').trim())
}

beforeEach(() => {
  vi.clearAllMocks()
  mockApi({ defaultModel: 'gpt-6-astra', defaultEffort: 'medium' })
  useCodexStore.setState({ state: READY, models: READY.models, quota: READY.quota, ready: true })
  useEngineStore.getState().apply({ available: true, binary: 'avx2', version: 'Stockfish 17', message: null })
})

afterEach(() => {
  cleanup()
  useCodexStore.setState({ state: INITIAL_CODEX_STATE, models: [], quota: null, ready: false })
  useEngineStore.getState().apply(INITIAL_ENGINE_STATE)
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

describe('quotaResetDate', () => {
  it('reads epoch seconds and milliseconds alike, and refuses a missing timestamp', () => {
    expect(quotaResetDate(1_789_000_000)?.getTime()).toBe(1_789_000_000_000)
    expect(quotaResetDate(1_789_000_000_000)?.getTime()).toBe(1_789_000_000_000)
    expect(quotaResetDate(0)).toBeNull()
  })
})

describe('SettingsScreen', () => {
  it('offers the models of the mirrored catalogue, with their descriptions', async () => {
    render(<SettingsScreen />)
    await screen.findByRole('combobox', { name: 'Modello predefinito' })

    const options = await optionsOf('Modello predefinito')
    expect(options).toHaveLength(2)
    expect(options[0]).toContain('GPT-6 Astra')
    expect(options[0]).toContain('Il modello predefinito')
    expect(options[1]).toContain('GPT-5.5')
  })

  it('lists only the efforts of the selected model', async () => {
    render(<SettingsScreen />)
    await screen.findByRole('combobox', { name: 'Impegno predefinito' })

    const options = await optionsOf('Impegno predefinito')
    expect(options).toHaveLength(3)
    expect(options[0]).toContain('low')
    expect(options[0]).toContain('rapido')
    expect(options[2]).toContain('high')
  })

  it('narrows the effort list when the selected model offers fewer of them', async () => {
    mockApi({ defaultModel: 'gpt-5.5', defaultEffort: 'low' })
    render(<SettingsScreen />)
    await screen.findByRole('combobox', { name: 'Impegno predefinito' })

    const options = await optionsOf('Impegno predefinito')
    expect(options).toHaveLength(1)
    expect(options[0]).toContain('low')
  })

  it('saves a chosen model through the bridge', async () => {
    render(<SettingsScreen />)
    await screen.findByRole('combobox', { name: 'Modello predefinito' })

    await act(async () => {
      fireEvent.click(screen.getByRole('combobox', { name: 'Modello predefinito' }))
    })
    await act(async () => {
      fireEvent.click(await screen.findByRole('option', { name: /GPT-5\.5/ }))
    })
    expect(save).toHaveBeenCalledWith({ defaultModel: 'gpt-5.5' })
  })

  it('reveals the coach model and effort only once they are kept separate', async () => {
    render(<SettingsScreen />)
    await screen.findByRole('combobox', { name: 'Modello predefinito' })
    expect(screen.queryByRole('combobox', { name: 'Modello del coach' })).toBeNull()

    await act(async () => {
      fireEvent.click(screen.getByRole('switch', { name: /Impostazioni separate per il coach/ }))
    })
    expect(save).toHaveBeenCalledWith({ separateCoach: true })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Modello del coach' })).toBeInTheDocument())
    expect(screen.getByRole('combobox', { name: 'Impegno del coach' })).toBeInTheDocument()
  })

  it('shows the Codex account, the CLI mismatch warning and the quota bar', async () => {
    render(<SettingsScreen />)

    expect(await screen.findByText('user@example.com')).toBeInTheDocument()
    expect(screen.getByText('0.155.0')).toBeInTheDocument()
    expect(screen.getByText(/aggiorna Codex/)).toBeInTheDocument()

    const bar = screen.getByRole('progressbar', { name: 'Quota' })
    expect(bar).toHaveAttribute('aria-valuenow', '42')
    expect(screen.getByText(/42% usato/)).toBeInTheDocument()
    expect(screen.getByText(/Si azzera il/)).toBeInTheDocument()
  })

  it('reports the engine binary and version the probe found', async () => {
    render(<SettingsScreen />)

    expect(await screen.findByText('Stockfish 17')).toBeInTheDocument()
    expect(screen.getByText('avx2')).toBeInTheDocument()
    expect(screen.getByText('Disponibile')).toBeInTheDocument()
  })

  it('disables the model pickers and warns when no Codex session is ready', async () => {
    useCodexStore.setState({ state: INITIAL_CODEX_STATE, models: [], quota: null, ready: false })
    useEngineStore.getState().apply({ available: false, binary: 'none', version: null, message: 'nessun binario' })
    render(<SettingsScreen />)

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Modello predefinito' })).toBeDisabled())
    expect(screen.getByRole('combobox', { name: 'Impegno predefinito' })).toBeDisabled()
    expect(screen.getByText('Non disponibile')).toBeInTheDocument()
    expect(screen.getByText('nessun binario')).toBeInTheDocument()
  })
})
