import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import '../../i18n'
import { Button } from './Button'
import { Modal } from './Modal'

afterEach(cleanup)

function renderModal(
  props: Partial<{ open: boolean; onClose: () => void }> = {}
): ReturnType<typeof render> {
  const onClose = props.onClose ?? vi.fn()
  return render(
    <Modal
      open={props.open ?? true}
      title="Titolo"
      onClose={onClose}
      footer={<Button>Conferma</Button>}
    >
      <Button>Prima</Button>
      <Button>Seconda</Button>
    </Modal>
  )
}

describe('Modal', () => {
  it('renders nothing while closed and children once open', () => {
    const view = renderModal({ open: false })
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(
      <Modal open title="Titolo" onClose={vi.fn()}>
        <Button>Prima</Button>
      </Modal>
    )
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Prima')).toBeTruthy()
  })

  it('is labelled by its title and rendered through a portal on document.body', () => {
    const { container } = renderModal()
    const dialog = screen.getByRole('dialog')
    expect(container.contains(dialog)).toBe(false)
    expect(document.body.contains(dialog)).toBe(true)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    const labelledBy = dialog.getAttribute('aria-labelledby')
    expect(labelledBy).toBeTruthy()
    expect(document.getElementById(labelledBy as string)?.textContent).toBe('Titolo')
  })

  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('calls onClose from the header close button', () => {
    const onClose = vi.fn()
    renderModal({ onClose })
    fireEvent.click(screen.getByRole('button', { name: 'Chiudi' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('moves focus into the dialog and restores it on close', () => {
    const opener = document.createElement('button')
    opener.textContent = 'Apri'
    document.body.appendChild(opener)
    opener.focus()
    expect(document.activeElement).toBe(opener)

    const view = renderModal()
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)

    view.rerender(
      <Modal open={false} title="Titolo" onClose={vi.fn()}>
        <Button>Prima</Button>
      </Modal>
    )
    expect(document.activeElement).toBe(opener)
    opener.remove()
  })

  it('traps Tab from the last focusable back to the first', () => {
    renderModal()
    const dialog = screen.getByRole('dialog')
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )
    )
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    expect(focusable.length).toBeGreaterThan(1)

    last.focus()
    fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })
})
