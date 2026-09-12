import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { cx } from './cx'
import { Icon, type IconName } from './Icon'
import styles from './IconButton.module.css'

export type IconButtonVariant = 'ghost' | 'surface' | 'danger'
export type IconButtonSize = 'sm' | 'md' | 'lg'

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Accessible name, also used as the native tooltip. */
  label: string
  icon?: IconName
  children?: ReactNode
  variant?: IconButtonVariant
  size?: IconButtonSize
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, children, variant = 'ghost', size = 'md', className, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cx(styles.iconButton, styles[variant], styles[size], className)}
      {...rest}
    >
      {children ?? (icon ? <Icon name={icon} size={size === 'sm' ? 16 : 20} /> : null)}
    </button>
  )
})
