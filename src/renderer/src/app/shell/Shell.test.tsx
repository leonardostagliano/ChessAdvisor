import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import '@testing-library/jest-dom/vitest'
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

  it('opens the shortcuts sheet with ? and closes it with Esc', () => {
    render(<Shell />)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.keyDown(window, { key: '?' })
    const sheet = screen.getByRole('dialog')
    expect(sheet).toHaveTextContent('Scorciatoie da tastiera')
    expect(sheet).toHaveTextContent('Mossa precedente e successiva, in partita e in revisione')

    fireEvent.keyDown(sheet, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('leaves ? alone while the user is writing', () => {
    render(<Shell />)
    const field = document.createElement('input')
    document.body.appendChild(field)
    field.focus()

    fireEvent.keyDown(field, { key: '?' })
    expect(screen.queryByRole('dialog')).toBeNull()
    field.remove()
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
