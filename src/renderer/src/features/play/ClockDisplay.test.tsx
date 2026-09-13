import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { ClockState } from '@shared/types/session'
import { ClockDisplay, formatClock, remainingAt } from './ClockDisplay'

/**
 * The clock the user reads is an interpolation of the last snapshot the main process pushed: the
 * tests fix "now" and check that the number always comes out of that difference, never out of a
 * count of the ticks that have run.
 */

const snapshot = (patch: Partial<ClockState> = {}): ClockState => ({
  remainingMs: { w: 300_000, b: 300_000 },
  running: 'w',
  updatedAt: 1_000_000,
  ...patch
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('formatClock', () => {
  it('is mm:ss above ten seconds and shows the tenths under it', () => {
    expect(formatClock(300_000)).toBe('05:00')
    expect(formatClock(65_400)).toBe('01:05')
    expect(formatClock(10_000)).toBe('00:10')
    expect(formatClock(9_900)).toBe('00:09.9')
    expect(formatClock(1_450)).toBe('00:01.4')
  })

  it('never goes below zero and does not cap the minutes', () => {
    expect(formatClock(-5_000)).toBe('00:00.0')
    expect(formatClock(3_600_000)).toBe('60:00')
  })
})

describe('remainingAt', () => {
  it('charges the elapsed time only to the side whose clock is running', () => {
    const clock = snapshot()
    expect(remainingAt(clock, 'w', 1_002_500)).toBe(297_500)
    expect(remainingAt(clock, 'b', 1_002_500)).toBe(300_000)
  })

  it('stops at zero and ignores a timestamp older than the snapshot', () => {
    expect(remainingAt(snapshot({ remainingMs: { w: 1_000, b: 10 } }), 'w', 1_009_000)).toBe(0)
    expect(remainingAt(snapshot(), 'w', 999_000)).toBe(300_000)
  })
})

describe('ClockDisplay', () => {
  it('draws nothing for a game played without clocks', () => {
    render(<ClockDisplay clock={null} color="w" label="Il tuo orologio" />)
    expect(screen.queryByRole('timer')).not.toBeInTheDocument()
  })

  it('counts down the running side and leaves the other one still', () => {
    const clock = snapshot()
    const { rerender } = render(<ClockDisplay clock={clock} color="w" label="Il tuo orologio" />)
    expect(screen.getByRole('timer', { name: 'Il tuo orologio' })).toHaveTextContent('05:00')

    act(() => {
      vi.advanceTimersByTime(2_000)
    })
    expect(screen.getByRole('timer')).toHaveTextContent('04:58')

    rerender(<ClockDisplay clock={clock} color="b" label="Orologio dell’avversario" />)
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.getByRole('timer')).toHaveTextContent('05:00')
  })

  it('shows the tenths in the last ten seconds and flags an expired clock', () => {
    render(<ClockDisplay clock={snapshot({ remainingMs: { w: 9_000, b: 1_000 } })} color="w" label="Il tuo orologio" />)
    expect(screen.getByRole('timer')).toHaveTextContent('00:09.0')

    act(() => {
      vi.advanceTimersByTime(9_500)
    })
    expect(screen.getByRole('timer')).toHaveTextContent('00:00.0')
    expect(screen.getByText('tempo scaduto')).toBeInTheDocument()
  })
})
