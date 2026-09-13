import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import { Rail } from './Rail'

/**
 * The brand block of the rail (spec §3.4): logo, name and a monospace pill with the version the
 * main process reports. The pill never invents a fallback — while `versionInfo()` has not
 * answered (or the bridge is missing) nothing is rendered in its place.
 */

function mockApi(versionInfo: () => Promise<{ version: string; isPackaged: boolean }>): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { app: { versionInfo } }
  })
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'api')
})

describe('Rail version badge', () => {
  it('shows v<version> for an installed build', async () => {
    mockApi(() => Promise.resolve({ version: '1.4.0', isPackaged: true }))
    render(<Rail />)

    const pill = await screen.findByTestId('rail-version')
    expect(pill).toHaveTextContent('v1.4.0')
    // The narrow rail hides the texts, so the tooltip has to carry the same information.
    expect(screen.getByTestId('rail-brand').getAttribute('title')).toContain('1.4.0')
  })

  it('marks a development build instead of pretending it is installed', async () => {
    mockApi(() => Promise.resolve({ version: '1.4.0-dev', isPackaged: false }))
    render(<Rail />)

    const pill = await screen.findByTestId('rail-version')
    expect(pill.textContent).toBe('Sviluppo · base 1.4.0-dev')
  })

  it('renders no pill at all while the version is unknown', async () => {
    mockApi(() => Promise.reject(new Error('no bridge')))
    render(<Rail />)

    await waitFor(() => expect(screen.getByTestId('rail-brand')).toBeInTheDocument())
    expect(screen.queryByTestId('rail-version')).toBeNull()
  })
})
