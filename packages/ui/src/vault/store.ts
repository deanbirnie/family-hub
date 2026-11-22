/**
 * The unlocked family key, held only in memory on this device, and only
 * while it is being used: it is forgotten after 15 minutes without use, on
 * "Lock now", when the person signs out, and (on Android) when the app locks.
 */

export const IDLE_LOCK_MS = 15 * 60_000

type Listener = () => void

export class VaultStore {
  private key: Uint8Array | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<Listener>()
  private idleMs: number

  constructor(idleMs = IDLE_LOCK_MS) {
    this.idleMs = idleMs
  }

  get unlocked(): boolean {
    return this.key !== null
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  /** The family key, restarting the idle timer; null when locked. */
  use(): Uint8Array | null {
    if (this.key) this.arm()
    return this.key
  }

  unlock(key: Uint8Array): void {
    this.key = key
    this.arm()
    this.emit()
  }

  lock = (): void => {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.key) this.key.fill(0)
    this.key = null
    this.emit()
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(this.lock, this.idleMs)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }
}

/** One vault per page or app. */
export const vault = new VaultStore()
