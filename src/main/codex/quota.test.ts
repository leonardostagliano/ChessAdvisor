import { describe, expect, it } from 'vitest'
import { mergeQuotaPatch, quotaFromRead } from './quota'

/** Shape of a real `account/rateLimits/read` response (fields the app does not use omitted). */
const READ = {
  ordinaryUsageAllowed: true,
  rateLimits: {
    limitId: 'codex',
    limitName: 'Codex',
    primary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1767225600 },
    secondary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1767139200 },
    credits: null,
    planType: 'prolite',
    rateLimitReachedType: null
  },
  rateLimitsByLimitId: {},
  accountId: 'acct'
}

describe('quotaFromRead', () => {
  it('reads the real response shape', () => {
    expect(quotaFromRead(READ)).toEqual({
      ordinaryUsageAllowed: true,
      primary: { usedPercent: 31, windowDurationMins: 10080, resetsAt: 1767225600 },
      secondary: { usedPercent: 4, windowDurationMins: 300, resetsAt: 1767139200 },
      rateLimitReachedType: null,
      planType: 'prolite'
    })
  })

  it('keeps null windows null and treats an unavailable permission as not allowed', () => {
    const snapshot = quotaFromRead({
      ordinaryUsageAllowed: null,
      rateLimits: { primary: null, secondary: null, rateLimitReachedType: 'rate_limit_reached' }
    })
    expect(snapshot).toEqual({
      ordinaryUsageAllowed: false,
      primary: null,
      secondary: null,
      rateLimitReachedType: 'rate_limit_reached',
      planType: null
    })
  })

  it('tolerates a window without duration or reset', () => {
    const snapshot = quotaFromRead({ rateLimits: { primary: { usedPercent: 12 } } })
    expect(snapshot?.primary).toEqual({ usedPercent: 12, windowDurationMins: 0, resetsAt: 0 })
  })

  it('returns null for anything that is not a rate-limit response', () => {
    expect(quotaFromRead(null)).toBeNull()
    expect(quotaFromRead({})).toBeNull()
    expect(quotaFromRead('nope')).toBeNull()
  })
})

describe('mergeQuotaPatch', () => {
  it('merges a sparse update without clearing the fields it omits', () => {
    const current = quotaFromRead(READ)!
    const merged = mergeQuotaPatch(current, { rateLimits: { primary: { usedPercent: 32 } } })
    expect(merged).toEqual({
      ...current,
      primary: { usedPercent: 32, windowDurationMins: 10080, resetsAt: 1767225600 }
    })
  })

  it('updates the permission flag and the reached type when they are present', () => {
    const current = quotaFromRead(READ)!
    const merged = mergeQuotaPatch(current, {
      ordinaryUsageAllowed: false,
      rateLimits: { rateLimitReachedType: 'workspace_member_usage_limit_reached' }
    })
    expect(merged?.ordinaryUsageAllowed).toBe(false)
    expect(merged?.rateLimitReachedType).toBe('workspace_member_usage_limit_reached')
    expect(merged?.primary).toEqual(current.primary)
  })

  it('does not clear a known window when the patch carries no news about it', () => {
    const current = quotaFromRead(READ)!
    expect(mergeQuotaPatch(current, { rateLimits: { primary: null, secondary: null } })).toEqual(
      current
    )
    expect(mergeQuotaPatch(current, {})).toEqual(current)
    expect(mergeQuotaPatch(current, null)).toEqual(current)
  })

  it('bootstraps a snapshot when none was read yet', () => {
    expect(mergeQuotaPatch(null, { rateLimits: { primary: { usedPercent: 32 } } })).toEqual({
      ordinaryUsageAllowed: false,
      primary: { usedPercent: 32, windowDurationMins: 0, resetsAt: 0 },
      secondary: null,
      rateLimitReachedType: null,
      planType: null
    })
    expect(mergeQuotaPatch(null, {})).toBeNull()
  })
})
