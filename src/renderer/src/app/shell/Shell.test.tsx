import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '../../i18n'
import { useUiStore } from '../../stores/uiStore'
import { Shell } from './Shell'

afterEach(cleanup)

beforeEach(() => {
  useUiStore.setState({ area: 'play' })
})

describe('Shell', () => {
  it('renders the four rail areas and routes to the selected one', () => {
    render(<Shell />)

    for (const label of ['Gioca', 'Allenamento', 'Progressi', 'Impostazioni']) {
      expect(screen.getByRole('button', { name: label })).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('button', { name: 'Allenamento' }))
    expect(useUiStore.getState().area).toBe('training')
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Allenamento')
    expect(screen.getByRole('tablist', { name: 'Aree di allenamento' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: 'Piano di studio' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Impostazioni' }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Impostazioni')
  })

  it('re-renders the rail labels after a language change', async () => {
    render(<Shell />)
    await act(async () => {
      useUiStore.getState().setLanguage('en')
    })
    expect(screen.getByRole('button', { name: 'Training' })).toBeTruthy()
    await act(async () => {
      useUiStore.getState().setLanguage('it')
    })
    expect(screen.getByRole('button', { name: 'Allenamento' })).toBeTruthy()
  })
})
