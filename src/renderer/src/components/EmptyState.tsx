import type { ReactNode } from 'react'
import { Button } from './ui/Button'
import styles from './EmptyState.module.css'

export interface EmptyStateProps {
  eyebrow?: string
  title: string
  body: string
  /** Primary action label; the button is rendered disabled when `disabled`. */
  action?: string
  onAction?: () => void
  disabled?: boolean
  note?: string
  children?: ReactNode
}

export function EmptyState({
  eyebrow,
  title,
  body,
  action,
  onAction,
  disabled = false,
  note,
  children
}: EmptyStateProps): React.JSX.Element {
  return (
    <section className={styles.empty}>
      {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
      <h2 className={styles.title}>{title}</h2>
      <p className={styles.body}>{body}</p>
      {action ? (
        <div className={styles.actions}>
          <Button variant="primary" size="lg" disabled={disabled} onClick={onAction}>
            {action}
          </Button>
          {note ? <span className={styles.note}>{note}</span> : null}
        </div>
      ) : null}
      {children}
    </section>
  )
}
