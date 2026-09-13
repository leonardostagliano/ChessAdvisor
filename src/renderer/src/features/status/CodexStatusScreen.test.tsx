import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import { codexBlocking, useCodexStore } from '../../stores/codexStore'
import { CodexStatusScreen } from './CodexStatusScreen'

afterEach(() => {
  cleanup()
  useCodexStore.setState({ isolationAccepted: false })
  vi.restoreAllMocks()
})

describe('CodexStatusScreen', () => {
  it('lists the paths that were searched when the CLI is missing', () => {
    render(
      <CodexStatusScreen
        state={{ status: 'not-installed', searched: ['C:/one/codex.exe', 'C:/two/codex.exe'] }}
      />
    )
    expect(screen.getByText('Codex CLI non trovato')).toBeInTheDocument()
    expect(screen.getByText('C:/one/codex.exe')).toBeInTheDocument()
    expect(screen.getByText('C:/two/codex.exe')).toBeInTheDocument()
  })

  it('offers the login command in a copyable block', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })

    render(<CodexStatusScreen state={{ status: 'not-authenticated' }} />)
    expect(screen.getByText('codex login')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Copia il comando' }))

    expect(writeText).toHaveBeenCalledWith('codex login')
    expect(await screen.findByText('Comando copiato')).toBeInTheDocument()
  })

  it('lets the user accept a non-isolated environment for this run', () => {
    render(
      <CodexStatusScreen state={{ status: 'not-isolated', problems: ['CODEX_HOME condiviso'] }} />
    )
    expect(screen.getByText('CODEX_HOME condiviso')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Continua comunque' }))
    const store = useCodexStore.getState()
    expect(store.isolationAccepted).toBe(true)
    expect(
      codexBlocking({ state: { status: 'not-isolated', problems: [] }, isolationAccepted: true })
    ).toBe(false)
    expect(
      codexBlocking({ state: { status: 'crashed', message: 'boom' }, isolationAccepted: true })
    ).toBe(true)
  })

  it('shows the crash message and retries through the store', () => {
    const retry = vi.fn()
    render(
      <CodexStatusScreen state={{ status: 'crashed', message: 'exit code 1' }} onRetry={retry} />
    )
    expect(screen.getByText('exit code 1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('shows a spinner while the session is starting', () => {
    render(<CodexStatusScreen state={{ status: 'starting' }} />)
    expect(
      screen.getByRole('status', { name: 'Collegamento a Codex in corso' })
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Riprova' })).not.toBeInTheDocument()
  })
})
