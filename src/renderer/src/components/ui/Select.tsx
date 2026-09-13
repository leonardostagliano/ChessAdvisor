import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent
} from 'react'
import { useTranslation } from 'react-i18next'
import { cx } from './cx'
import { Icon } from './Icon'
import { Portal } from './Portal'
import styles from './Select.module.css'

export interface SelectOption<T extends string = string> {
  value: T
  label: string
  hint?: string
  disabled?: boolean
}

export interface SelectProps<T extends string = string> {
  value: T
  options: SelectOption<T>[]
  onChange(value: T): void
  /** Accessible name of the control. */
  label?: string
  placeholder?: string
  disabled?: boolean
  id?: string
  className?: string
}

interface PopupRect {
  top: number
  left: number
  width: number
}

export function Select<T extends string = string>({
  value,
  options,
  onChange,
  label,
  placeholder,
  disabled = false,
  id,
  className
}: SelectProps<T>): React.JSX.Element {
  const { t } = useTranslation()
  const generatedId = useId()
  const listId = `${id ?? generatedId}-listbox`
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [rect, setRect] = useState<PopupRect | null>(null)
  const selectedIndex = options.findIndex((option) => option.value === value)
  const [activeIndex, setActiveIndex] = useState(selectedIndex < 0 ? 0 : selectedIndex)
  const selected = selectedIndex < 0 ? undefined : options[selectedIndex]

  const close = useCallback((refocus: boolean): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const node = triggerRef.current
    if (!node) return
    const box = node.getBoundingClientRect()
    setRect({ top: box.bottom + 6, left: box.left, width: box.width })
    setActiveIndex(selectedIndex < 0 ? 0 : selectedIndex)
  }, [open, selectedIndex])

  useEffect(() => {
    if (!open) return
    listRef.current?.focus()
    const onPointerDown = (event: MouseEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    const onViewportChange = (): void => setOpen(false)
    document.addEventListener('mousedown', onPointerDown, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('blur', onViewportChange)
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true)
      window.removeEventListener('resize', onViewportChange)
      window.removeEventListener('blur', onViewportChange)
    }
  }, [open])

  const step = (from: number, delta: number): number => {
    if (options.length === 0) return 0
    let next = from
    for (let i = 0; i < options.length; i += 1) {
      next = (next + delta + options.length) % options.length
      if (!options[next]?.disabled) return next
    }
    return from
  }

  const commit = (index: number): void => {
    const option = options[index]
    if (!option || option.disabled) return
    if (option.value !== value) onChange(option.value)
    close(true)
  }

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (open) return
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowUp' ||
      event.key === 'Enter' ||
      event.key === ' '
    ) {
      event.preventDefault()
      setOpen(true)
    }
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        close(true)
        break
      case 'ArrowDown':
        event.preventDefault()
        setActiveIndex((index) => step(index, 1))
        break
      case 'ArrowUp':
        event.preventDefault()
        setActiveIndex((index) => step(index, -1))
        break
      case 'Home':
        event.preventDefault()
        setActiveIndex(step(options.length - 1, 1))
        break
      case 'End':
        event.preventDefault()
        setActiveIndex(step(0, -1))
        break
      case 'Enter':
      case ' ':
        event.preventDefault()
        commit(activeIndex)
        break
      case 'Tab':
        close(false)
        break
      default:
        break
    }
  }

  return (
    <div className={cx(styles.select, className)}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        disabled={disabled}
        className={cx(styles.trigger, open && styles.triggerOpen)}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={cx(styles.value, !selected && styles.placeholder)}>
          {selected?.label ?? placeholder ?? t('common.select')}
        </span>
        <Icon
          name="chevronDown"
          size={16}
          className={cx(styles.chevron, open && styles.chevronOpen)}
        />
      </button>

      {open && rect ? (
        <Portal>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            aria-activedescendant={`${listId}-${activeIndex}`}
            tabIndex={-1}
            className={styles.popup}
            style={{ top: rect.top, left: rect.left, minWidth: rect.width }}
            onKeyDown={onListKeyDown}
          >
            {options.map((option, index) => (
              <div
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={option.value === value}
                aria-disabled={option.disabled || undefined}
                className={cx(
                  styles.option,
                  index === activeIndex && styles.active,
                  option.disabled && styles.optionDisabled
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => commit(index)}
              >
                <span className={styles.optionTexts}>
                  <span className={styles.optionLabel}>{option.label}</span>
                  {option.hint ? <span className={styles.optionHint}>{option.hint}</span> : null}
                </span>
                {option.value === value ? <Icon name="check" size={16} /> : null}
              </div>
            ))}
          </div>
        </Portal>
      ) : null}
    </div>
  )
}
