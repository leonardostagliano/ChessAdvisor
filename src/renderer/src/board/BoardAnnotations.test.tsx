import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../i18n'
import { BoardAnnotations, squarePosition } from './BoardAnnotations'

afterEach(cleanup)
describe('board explanations', () => {
  it('maps anchors for either board orientation', () => {
    expect(squarePosition('a8', 'white')).toEqual({ x: 0, y: 0 })
    expect(squarePosition('a8', 'black')).toEqual({ x: 7, y: 7 })
    expect(squarePosition('e4', 'white')).toEqual({ x: 4, y: 4 })
  })
  it('keeps one label visible and lets users select an involved piece', () => {
    render(
      <BoardAnnotations
        orientation="white"
        annotations={[
          { square: 'e4', label: 'Pedone centrale', kind: 'focus' },
          { square: 'f3', label: 'Cavallo sviluppato', kind: 'focus' }
        ]}
      />
    )
    expect(screen.getByText('Pedone centrale')).toBeInTheDocument()
    expect(screen.queryByText('Cavallo sviluppato')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '2. f3: Cavallo sviluppato' }))
    expect(screen.getByText('Cavallo sviluppato')).toBeInTheDocument()
    expect(screen.queryByText('Pedone centrale')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '2. f3: Cavallo sviluppato' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})

it('navigates in place, supports arrow keys and keeps the selected piece after reopening', () => {
  const annotations = [
    { square: 'e4', label: 'Pedone centrale', kind: 'focus' as const },
    { square: 'e7', label: 'Pedone avversario', kind: 'focus' as const }
  ]
  const { rerender } = render(<BoardAnnotations orientation="white" annotations={annotations} />)
  const next = screen.getByRole('button', { name: 'Spiegazione successiva' })
  const captionClass = next.parentElement!.parentElement!.className
  expect(screen.getByText('Pezzo 1 di 2')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Spiegazione precedente' })).toBeDisabled()
  fireEvent.click(next)
  expect(screen.getByText('Pedone avversario')).toBeInTheDocument()
  expect(next).toBeDisabled()
  expect(next.parentElement!.parentElement!.className).toBe(captionClass)
  rerender(<BoardAnnotations orientation="white" annotations={annotations} visible={false} />)
  expect(screen.queryByTestId('board-annotations')).not.toBeInTheDocument()
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
  rerender(<BoardAnnotations orientation="white" annotations={annotations} />)
  expect(screen.getByText('Pedone avversario')).toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole('button', { name: 'Spiegazione precedente' }), {
    key: 'ArrowLeft'
  })
  expect(screen.getByText('Pedone centrale')).toBeInTheDocument()
})
