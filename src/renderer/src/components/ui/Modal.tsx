import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from './cx'
import { focusableElements } from './focus'
import { IconButton } from './IconButton'
import { Portal } from './Portal'
import styles from './Modal.module.css'

export interface ModalProps {
  open: boolean
  title: ReactNode
  onClose(): void
  children?: ReactNode
  footer?: ReactNode
  /** Dialog width. */
  size?: 'sm' | 'md' | 'lg'
  /** Set to false to keep a click on the backdrop from closing the dialog. */
  closeOnBackdrop?: boolean
  className?: string
}

export function Modal({ open, ...rest }: ModalProps): React.JSX.Element | null {
  if (!open) return null
  return (
    <Portal>
      <ModalDialog {...rest} />
    </Portal>
  )
}

function ModalDialog({
  title,
  onClose,
  children,
  footer,
  size = 'md',
  closeOnBackdrop = true,
  className
}: Omit<ModalProps, 'open'>): React.JSX.Element {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const node = dialogRef.current
    if (node) {
      const [first] = focusableElements(node)
      ;(first ?? node).focus()
    }
    return () => {
      if (previous && typeof previous.focus === 'function' && previous.isConnected) {
        previous.focus()
      }
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return

    const node = dialogRef.current
    if (!node) return
    const items = focusableElements(node)
    if (items.length === 0) {
      event.preventDefault()
      node.focus()
      return
    }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement as HTMLElement | null
    const inside = active ? node.contains(active) : false

    if (event.shiftKey) {
      if (!inside || active === first) {
        event.preventDefault()
        last.focus()
      }
      return
    }
    if (!inside || active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (closeOnBackdrop && event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={cx(styles.dialog, styles[size], className)}
        onKeyDown={onKeyDown}
      >
        <header className={styles.header}>
          <h2 className={styles.title} id={titleId}>
            {title}
          </h2>
          <IconButton label={t('common.close')} icon="close" onClick={onClose} />
        </header>
        <div className={cx(styles.body, 'selectable')}>{children}</div>
        {footer ? <footer className={styles.footer}>{footer}</footer> : null}
      </div>
    </div>
  )
}
