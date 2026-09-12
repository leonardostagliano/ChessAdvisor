import { useLayoutEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface PortalProps {
  children: ReactNode
  /** Optional class on the host element appended to document.body. */
  className?: string
}

/**
 * Mounts its children in a dedicated host under document.body.
 * The host is attached in a layout effect, so child passive effects
 * (focus management) always run on a connected subtree.
 */
export function Portal({ children, className }: PortalProps): React.JSX.Element | null {
  const [host] = useState<HTMLDivElement | null>(() =>
    typeof document === 'undefined' ? null : document.createElement('div')
  )

  useLayoutEffect(() => {
    if (!host) return
    host.dataset.portal = 'chessadvisor'
    if (className) host.className = className
    document.body.appendChild(host)
    return () => {
      host.remove()
    }
  }, [host, className])

  if (!host) return null
  return createPortal(children, host)
}
