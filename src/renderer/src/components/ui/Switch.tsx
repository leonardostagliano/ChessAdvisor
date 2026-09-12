import { useId } from 'react'
import { cx } from './cx'
import styles from './Switch.module.css'

export interface SwitchProps {
  checked: boolean
  onChange(checked: boolean): void
  label: string
  hint?: string
  disabled?: boolean
  className?: string
  id?: string
}

export function Switch({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
  className,
  id
}: SwitchProps): React.JSX.Element {
  const generatedId = useId()
  const labelId = `${id ?? generatedId}-label`
  const hintId = `${id ?? generatedId}-hint`

  return (
    <div className={cx(styles.row, disabled && styles.disabled, className)}>
      <span className={styles.texts}>
        <span className={styles.label} id={labelId}>
          {label}
        </span>
        {hint ? (
          <span className={styles.hint} id={hintId}>
            {hint}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        role="switch"
        id={id}
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={hint ? hintId : undefined}
        disabled={disabled}
        className={cx(styles.track, checked && styles.on)}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.thumb} />
      </button>
    </div>
  )
}
