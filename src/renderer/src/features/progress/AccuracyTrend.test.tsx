import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import '../../i18n'
import type { ProfileHistoryEntry } from '@shared/types/profile'
import { AccuracyTrend, TREND_HEIGHT, trendAverage, trendPoints } from './AccuracyTrend'
import { TREND_WINDOW } from '../../stores/profileStore'

/**
 * The trend is the one chart of the dashboard drawn from the profile alone: the assertions here
 * are about the window it takes (spec §6.9), the fixed 0–100 scale, and the fact that every value
 * is readable as text and not only as a curve (spec §7).
 */

function entry(index: number, accuracy: number, acpl = 40): ProfileHistoryEntry {
  return {
    gameId: `g${index}`,
    date: new Date(Date.UTC(2026, 8, 1 + index, 10)).toISOString(),
    accuracy,
    acpl
  }
}

const history = (values: number[]): ProfileHistoryEntry[] => values.map((value, index) => entry(index, value))

afterEach(cleanup)

describe('trendPoints', () => {
  it('keeps the last twenty games, oldest first', () => {
    const points = trendPoints(history(Array.from({ length: 26 }, (_, index) => 50 + (index % 10))))
    expect(points).toHaveLength(TREND_WINDOW)
    expect(points[0]!.gameId).toBe('g6')
    expect(points[TREND_WINDOW - 1]!.gameId).toBe('g25')
    expect(points.map((point) => point.index)).toEqual(Array.from({ length: TREND_WINDOW }, (_, i) => i))
  })

  it('maps the accuracy on a fixed scale, so a better game always sits higher', () => {
    const [low, high] = trendPoints(history([40, 90]))
    expect(high!.y).toBeLessThan(low!.y)
    // 0 and 100 are the ends of the plot, never the ends of the data.
    const [zero, hundred] = trendPoints(history([0, 100]))
    expect(hundred!.y).toBeLessThan(zero!.y)
    expect(hundred!.y).toBeGreaterThanOrEqual(0)
    expect(zero!.y).toBeLessThanOrEqual(TREND_HEIGHT)
  })

  it('clamps an impossible accuracy and drops an unusable one', () => {
    const points = trendPoints([entry(0, 120), entry(1, Number.NaN), entry(2, -5)])
    expect(points.map((point) => point.accuracy)).toEqual([100, 0])
  })

  it('centres a single game instead of pinning it to the left edge', () => {
    const [only] = trendPoints(history([72]))
    expect(only!.x).toBeGreaterThan(0)
  })
})

describe('trendAverage', () => {
  it('averages the drawn window to one decimal', () => {
    expect(trendAverage(trendPoints(history([60, 70, 75])))).toBe(68.3)
    expect(trendAverage([])).toBe(0)
  })
})

describe('AccuracyTrend', () => {
  it('draws one point per game and names each of them in words', () => {
    const { container } = render(<AccuracyTrend history={history([61.5, 72.25, 80])} />)
    const points = container.querySelectorAll('[data-point]')
    expect(points).toHaveLength(3)
    expect(points[2]!.querySelector('title')?.textContent).toContain('80.0%')
    expect(points[2]!.querySelector('title')?.textContent).toContain('ACPL 40')
    expect(screen.getByRole('img', { name: /3/ })).toBeInTheDocument()
  })

  it('repeats the last value and the average as text under the chart', () => {
    render(<AccuracyTrend history={history([60, 70])} />)
    // Printed twice on purpose: once on the curve, once in the legend.
    expect(screen.getAllByText('70.0%').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('65.0%')).toBeInTheDocument()
  })

  it('says so, rather than drawing an empty axis, when nothing is analysed', () => {
    const { container } = render(<AccuracyTrend history={[]} />)
    expect(container.querySelector('[data-testid="accuracy-trend"]')).toBeNull()
    expect(screen.getByText(/Nessuna partita analizzata/)).toBeInTheDocument()
  })
})
