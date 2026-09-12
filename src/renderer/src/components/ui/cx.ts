export type ClassValue = string | false | null | undefined

/** Tiny class-name joiner used by the UI primitives (no utility CSS framework). */
export function cx(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ')
}
