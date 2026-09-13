import { useEffect } from 'react'

/**
 * Keyboard of the whole app (spec §7, task T22 item 4).
 *
 * Two rules keep the global shortcuts out of everybody's way:
 * - a key pressed while the user is writing belongs to the field, never to the app;
 * - a key a component has already handled is never handled twice (React's own handlers run on
 *   the root container, so by the time the window listener sees the event `defaultPrevented`
 *   already tells us the move list, a dialog or a select has taken it).
 */

/** True when the event comes from a field where the keys are text, not commands. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return target.isContentEditable
}

/** True when a modal dialog is open: its own focus trap owns the keyboard while it is. */
export function isDialogOpen(): boolean {
  return typeof document !== 'undefined' && document.querySelector('[role="dialog"][aria-modal="true"]') !== null
}

export interface MoveKeyHandlers {
  /** ← : one ply back. */
  previous(): void
  /** → : one ply forward. */
  next(): void
  /** Home: the position before the first move. */
  first?(): void
  /** End: back to the last position. */
  last?(): void
  /** Set to false while there is nothing to walk through. */
  enabled?: boolean
}

/** ← → Home End walk the moves of the game on screen, in Gioca as in Revisione. */
export function useMoveKeys({ previous, next, first, last, enabled = true }: MoveKeyHandlers): void {
  useEffect(() => {
    if (!enabled) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
      if (isTypingTarget(event.target) || isDialogOpen()) return
      switch (event.key) {
        case 'ArrowLeft':
          previous()
          break
        case 'ArrowRight':
          next()
          break
        case 'Home':
          if (!first) return
          first()
          break
        case 'End':
          if (!last) return
          last()
          break
        default:
          return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [previous, next, first, last, enabled])
}

/** `?` anywhere opens the shortcuts sheet; the sheet closes itself with Esc, like every dialog. */
export function useShortcutsKey(open: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey) return
      if (event.key !== '?' || isTypingTarget(event.target) || isDialogOpen()) return
      event.preventDefault()
      open()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
}

/**
 * Roving focus inside a tab strip (WAI-ARIA): ← → move between tabs, Home and End jump to the
 * ends. The strip keeps a single tab stop, so Tab enters it and leaves it in one step.
 */
export function tabStripKeyDown<T>(
  event: React.KeyboardEvent,
  tabs: readonly T[],
  current: T,
  select: (tab: T) => void
): void {
  const index = tabs.indexOf(current)
  if (index === -1) return
  let target = index
  switch (event.key) {
    case 'ArrowLeft':
      target = (index - 1 + tabs.length) % tabs.length
      break
    case 'ArrowRight':
      target = (index + 1) % tabs.length
      break
    case 'Home':
      target = 0
      break
    case 'End':
      target = tabs.length - 1
      break
    default:
      return
  }
  event.preventDefault()
  const next = tabs[target]
  if (next === undefined || next === current) return
  select(next)
  // The tab that takes the selection takes the focus with it: the strip has one tab stop.
  const strip = event.currentTarget as HTMLElement
  const buttons = strip.querySelectorAll<HTMLElement>('[role="tab"]')
  buttons[target]?.focus()
}
