import { describe, expect, it } from 'vitest'
import { AccountLockout, RateLimiter } from '../src/limits.ts'

describe('account lockout memory', () => {
  it('forgets made-up usernames once their failures are old, but keeps locks in force', () => {
    const lockout = new AccountLockout(5, 15 * 60_000, 15 * 60_000)
    const t0 = 1_800_000_000_000
    for (let i = 0; i < 1000; i++) lockout.fail(`nobody${i}`, t0)
    for (let i = 0; i < 5; i++) lockout.fail('parent', t0)
    expect(lockout.lockedFor('parent', t0)).toBeGreaterThan(0)
    lockout.prune(t0 + 16 * 60_000)
    expect(lockout.size).toBe(1)
    expect(lockout.lockedFor('parent', t0 + 10 * 60_000)).toBeGreaterThan(0)
    lockout.prune(t0 + 26 * 60 * 60_000)
    expect(lockout.size).toBe(0)
  })
})

describe('rate limiter', () => {
  it('allows the limit per window, then refuses until hits age out', () => {
    const limiter = new RateLimiter(3, 60_000)
    const t0 = 1_800_000_000_000
    expect([1, 2, 3, 4].map(() => limiter.hit('ip', t0))).toEqual([true, true, true, false])
    expect(limiter.hit('ip', t0 + 60_001)).toBe(true)
  })
})
