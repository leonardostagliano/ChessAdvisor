import type { QuotaSnapshot, QuotaWindow } from '@shared/types/codex'

/**
 * Quota bookkeeping.
 *
 * `account/rateLimits/read` returns a full snapshot; `account/rateLimits/updated` is a **sparse**
 * rolling patch: absent or null fields mean "no news", never "reset to nothing" (protocol note on
 * `AccountRateLimitsUpdatedNotification`). Everything here follows that rule, so a partial update
 * can never wipe a window the app already knows about.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const numberOr = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

function windowFrom(value: unknown): QuotaWindow | null {
  if (!isRecord(value)) return null
  if (typeof value.usedPercent !== 'number' || !Number.isFinite(value.usedPercent)) return null
  return {
    usedPercent: value.usedPercent,
    windowDurationMins: numberOr(value.windowDurationMins, 0),
    resetsAt: numberOr(value.resetsAt, 0)
  }
}

function mergeWindow(current: QuotaWindow | null, patch: unknown): QuotaWindow | null {
  if (!isRecord(patch)) return current
  if (current === null) return windowFrom(patch)
  return {
    usedPercent: numberOr(patch.usedPercent, current.usedPercent),
    windowDurationMins: numberOr(patch.windowDurationMins, current.windowDurationMins),
    resetsAt: numberOr(patch.resetsAt, current.resetsAt)
  }
}

const stringOr = (value: unknown, fallback: string | null): string | null =>
  typeof value === 'string' && value.length > 0 ? value : fallback

/** Builds the snapshot from an `account/rateLimits/read` response. */
export function quotaFromRead(result: unknown): QuotaSnapshot | null {
  if (!isRecord(result)) return null
  const limits = isRecord(result.rateLimits) ? result.rateLimits : null
  if (limits === null) return null
  return {
    // Null means "unavailable": the app must not infer permission from percentages (protocol note).
    ordinaryUsageAllowed: result.ordinaryUsageAllowed === true,
    primary: windowFrom(limits.primary),
    secondary: windowFrom(limits.secondary),
    rateLimitReachedType: stringOr(limits.rateLimitReachedType, null),
    planType: stringOr(limits.planType, null)
  }
}

/** Folds an `account/rateLimits/updated` notification into the snapshot, field by field. */
export function mergeQuotaPatch(
  current: QuotaSnapshot | null,
  patch: unknown
): QuotaSnapshot | null {
  if (!isRecord(patch)) return current
  const limits = isRecord(patch.rateLimits) ? patch.rateLimits : null
  if (limits === null && patch.ordinaryUsageAllowed === undefined) return current
  if (current === null) {
    const built = quotaFromRead(patch)
    return built ?? current
  }
  return {
    ordinaryUsageAllowed:
      typeof patch.ordinaryUsageAllowed === 'boolean'
        ? patch.ordinaryUsageAllowed
        : current.ordinaryUsageAllowed,
    primary: mergeWindow(current.primary, limits?.primary),
    secondary: mergeWindow(current.secondary, limits?.secondary),
    rateLimitReachedType: stringOr(limits?.rateLimitReachedType, current.rateLimitReachedType),
    planType: stringOr(limits?.planType, current.planType)
  }
}
