import { useEffect, useRef, type RefObject } from 'react'

/** How close to the end (px) the reader must be for the feed to keep following new content. */
export const FOLLOW_THRESHOLD_PX = 48

/**
 * The element that actually scrolls for `node`: the node itself when it overflows, otherwise the
 * nearest overflowing ancestor up to (and including) the tab panel. Never the page: a feed that
 * fits on screen has nothing to scroll and must not move the board.
 */
export function scrollContainerOf(node: HTMLElement): HTMLElement | null {
  let current: HTMLElement | null = node
  while (current) {
    const overflowY = getComputedStyle(current).overflowY
    const scrolls =
      (overflowY === 'auto' || overflowY === 'scroll') &&
      current.scrollHeight > current.clientHeight + 1
    if (scrolls) return current
    if (current.getAttribute('role') === 'tabpanel') return null
    current = current.parentElement
  }
  return null
}

export function isNearEnd(container: HTMLElement, threshold = FOLLOW_THRESHOLD_PX): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight <= threshold
}

/**
 * Keeps a message feed pinned to its end while new entries arrive or a streamed answer grows,
 * unless the reader has scrolled up to re-read something: then their position is left alone until
 * they come back within `FOLLOW_THRESHOLD_PX` of the end.
 *
 * `signals` are the values whose change means "new content" (entry count, streamed text, …).
 */
export function useFollowFeed(feedRef: RefObject<HTMLElement | null>, signals: unknown[]): void {
  const followRef = useRef(true)

  useEffect(() => {
    const node = feedRef.current
    if (!node) return
    const container = scrollContainerOf(node) ?? node
    const onScroll = (): void => {
      followRef.current = isNearEnd(container)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => container.removeEventListener('scroll', onScroll)
    // The container can change when the panel re-layouts: re-bind on every signal change too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedRef, ...signals])

  useEffect(() => {
    const node = feedRef.current
    if (!node || !followRef.current) return
    const container = scrollContainerOf(node)
    if (container) container.scrollTop = container.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedRef, ...signals])
}
