import type { SVGProps } from 'react'
import { cx } from './cx'
import styles from './Icon.module.css'

export type IconName =
  | 'play'
  | 'training'
  | 'progress'
  | 'settings'
  | 'close'
  | 'check'
  | 'chevronDown'

const PATHS: Record<IconName, string[]> = {
  play: ['M4 4h16v16H4z', 'M4 10h16', 'M4 16h16', 'M10 4v16', 'M16 4v16'],
  training: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M12 13v-1'],
  progress: ['M4 5v14h16', 'M7 15l4-5 3 3 4-6'],
  settings: ['M4 8h8', 'M16 8h4', 'M4 16h4', 'M12 16h8', 'M14 8a2 2 0 1 0 4 0 2 2 0 0 0-4 0z', 'M6 16a2 2 0 1 0 4 0 2 2 0 0 0-4 0z'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  chevronDown: ['M6 9.5l6 6 6-6']
}

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName
  size?: number
  strokeWidth?: number
}

export function Icon({
  name,
  size = 20,
  strokeWidth = 1.6,
  className,
  ...rest
}: IconProps): React.JSX.Element {
  return (
    <svg
      className={cx(styles.icon, className)}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
}
