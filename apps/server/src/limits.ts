/**
 * Slows down guessing. Kept in memory: a restart forgets them, which only
 * ever helps someone who can already restart the server.
 */

/** At most `limit` hits per key in any `windowMs`. */
export class RateLimiter {
  private hits = new Map<string, number[]>()
  private limit: number
  private windowMs: number

  constructor(limit: number, windowMs: number) {
    this.limit = limit
    this.windowMs = windowMs
  }

  /** Counts a hit; false when the key is over its limit. */
  hit(key: string, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }

  prune(now = Date.now()): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key)
    }
  }
}

/**
 * Locks an account for a while after repeated failed sign-ins (wrong password
 * or wrong code). Each further lock lasts twice as long, up to a day.
 */
export class AccountLockout {
  private state = new Map<string, { failures: number[]; lockedUntil: number; locks: number }>()
  private maxFailures: number
  private windowMs: number
  private baseLockMs: number

  constructor(maxFailures = 5, windowMs = 15 * 60_000, baseLockMs = 15 * 60_000) {
    this.maxFailures = maxFailures
    this.windowMs = windowMs
    this.baseLockMs = baseLockMs
  }

  /** Milliseconds until the account may try again, or 0. */
  lockedFor(account: string, now = Date.now()): number {
    const s = this.state.get(account.toLowerCase())
    return s && s.lockedUntil > now ? s.lockedUntil - now : 0
  }

  /** Records a failure; true if this one locked the account. */
  fail(account: string, now = Date.now()): boolean {
    const key = account.toLowerCase()
    const s = this.state.get(key) ?? { failures: [], lockedUntil: 0, locks: 0 }
    s.failures = s.failures.filter((t) => now - t < this.windowMs)
    s.failures.push(now)
    let locked = false
    if (s.failures.length >= this.maxFailures) {
      s.lockedUntil = now + Math.min(this.baseLockMs * 2 ** s.locks, 24 * 60 * 60_000)
      s.locks++
      s.failures = []
      locked = true
    }
    this.state.set(key, s)
    return locked
  }

  succeed(account: string): void {
    this.state.delete(account.toLowerCase())
  }

  /**
   * Forgets accounts with no recent failure and no lock in force, so trying
   * endless made-up usernames cannot grow this without limit. A forgotten
   * account's next lock starts again at the base length.
   */
  prune(now = Date.now()): void {
    for (const [key, s] of this.state) {
      const recent = s.failures.some((t) => now - t < this.windowMs)
      // Keep the doubling history for a day after a lock ends.
      if (!recent && s.lockedUntil + 24 * 60 * 60_000 <= now) this.state.delete(key)
    }
  }

  /** How many accounts are being tracked (for tests). */
  get size(): number {
    return this.state.size
  }
}
