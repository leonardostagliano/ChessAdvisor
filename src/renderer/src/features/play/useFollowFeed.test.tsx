import '@testing-library/jest-dom/vitest'
import { describe, expect, it } from 'vitest'
import { act, render } from '@testing-library/react'
import { useRef, useState, type RefObject } from 'react'
import { FOLLOW_THRESHOLD_PX, isNearEnd, scrollContainerOf, useFollowFeed } from './useFollowFeed'

/** jsdom lays nothing out: give an element explicit scroll geometry. */
function geometry(
  el: HTMLElement,
  scrollHeight: number,
  clientHeight: number,
  overflowY = 'auto'
): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight })
  el.style.overflowY = overflowY
}

describe('scrollContainerOf', () => {
  it('returns the node itself when it overflows', () => {
    const feed = document.createElement('div')
    geometry(feed, 1000, 300)
    document.body.appendChild(feed)
    expect(scrollContainerOf(feed)).toBe(feed)
    feed.remove()
  })

  it('walks up to the overflowing tab panel but never past it', () => {
    const panel = document.createElement('div')
    panel.setAttribute('role', 'tabpanel')
    geometry(panel, 1000, 300)
    const wrapper = document.createElement('div')
    const feed = document.createElement('div')
    geometry(feed, 300, 300) // fits: nothing to scroll here
    wrapper.appendChild(feed)
    panel.appendChild(wrapper)
    const page = document.createElement('div')
    geometry(page, 5000, 800)
    page.appendChild(panel)
    document.body.appendChild(page)
    expect(scrollContainerOf(feed)).toBe(panel)
    geometry(panel, 300, 300) // panel fits too: the page must not be picked
    expect(scrollContainerOf(feed)).toBeNull()
    page.remove()
  })
})

describe('isNearEnd', () => {
  it('is true within the threshold of the end and false further up', () => {
    const el = document.createElement('div')
    geometry(el, 1000, 300)
    el.scrollTop = 1000 - 300 - FOLLOW_THRESHOLD_PX
    expect(isNearEnd(el)).toBe(true)
    el.scrollTop = 200
    expect(isNearEnd(el)).toBe(false)
  })
})

function Feed({
  onRef
}: {
  onRef: (ref: RefObject<HTMLDivElement | null>, bump: () => void) => void
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [count, setCount] = useState(0)
  useFollowFeed(ref, [count])
  onRef(ref, () => setCount((n) => n + 1))
  return <div ref={ref} data-testid="feed" />
}

describe('useFollowFeed', () => {
  it('pins the feed to its end when content grows and the reader was at the end', () => {
    let feedRef: RefObject<HTMLDivElement | null> | null = null
    let bump: () => void = () => {}
    render(
      <Feed
        onRef={(r, b) => {
          feedRef = r
          bump = b
        }}
      />
    )
    const feed = feedRef!.current!
    geometry(feed, 1000, 300)
    feed.scrollTop = 700 // at the end
    act(() => bump())
    geometry(feed, 1400, 300) // new content arrived
    act(() => bump())
    expect(feed.scrollTop).toBe(1400)
  })

  it('leaves the reader alone after they scrolled up', () => {
    let feedRef: RefObject<HTMLDivElement | null> | null = null
    let bump: () => void = () => {}
    render(
      <Feed
        onRef={(r, b) => {
          feedRef = r
          bump = b
        }}
      />
    )
    const feed = feedRef!.current!
    geometry(feed, 1000, 300)
    act(() => bump())
    feed.scrollTop = 100
    act(() => {
      feed.dispatchEvent(new Event('scroll'))
    })
    geometry(feed, 1400, 300)
    act(() => bump())
    expect(feed.scrollTop).toBe(100)
  })
})
