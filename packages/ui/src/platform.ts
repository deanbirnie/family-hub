/**
 * What the shared interface needs from the app around it. The web app and
 * the Android app each provide one.
 */
import type { Api } from './api.ts'

export interface UpdateInfo {
  status: 'idle' | 'checking' | 'current' | 'available' | 'error'
  version?: string
  notes?: { version: string; changes: string[] }[]
  message?: string
  /** 0–100 while the new version downloads. */
  progress?: number
}

/** Updates for the Android app, from the project's GitHub releases. */
export interface Updates {
  info: UpdateInfo
  check(): Promise<void>
  /** Downloads and opens Android's installer. */
  install(): Promise<void>
  subscribe(listener: () => void): () => void
}

/** Push notifications on this device: Web Push in browsers, UnifiedPush on Android. */
export interface PushSupport {
  kind: 'webpush' | 'unifiedpush'
  /** 'unsupported' when this device cannot, 'denied' when notifications were blocked. */
  state(): Promise<'unsupported' | 'denied' | 'off' | 'on'>
  /**
   * Asks permission if needed and returns this device's push address and keys;
   * null on a phone without a push app (it still gets the daily check).
   */
  enable(vapidPublicKey: string): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } } | null>
  current(): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } } | null>
  disable(): Promise<void>
  /** Android: the daily check and the push app (ntfy or another), for Settings. */
  phone?: () => Promise<{ daily: boolean; lastCheck: number | null; pushApp: string | null; pushApps: string[]; problem: string | null }>
  /** Android: checks for due reminders now (when the app is opened). */
  checkNow?: () => Promise<void>
}

export interface Platform {
  kind: 'web' | 'android'
  /** This build's version. */
  version: string
  api: Api
  updates?: Updates
  /** Android: the server this app talks to, to show in Settings. */
  serverUrl?: string
  /** Android: signs this phone out entirely (forgets its key and the server). */
  forgetDevice?: () => Promise<void>
  /** Android: locks the app now (biometric unlock needed again). */
  lock?: () => void
  /**
   * Android: wraps and unwraps the family key with a key in the phone's
   * hardware keystore that only works shortly after a fingerprint or face
   * check (the one that opened the app, or a new prompt).
   */
  vaultDevice?: {
    wrap(familyKey: Uint8Array): Promise<string>
    unwrap(wrapped: string): Promise<Uint8Array>
    /** Forgets the keystore key (when the phone is signed out). */
    forget(): Promise<void>
  }
  /** Push notifications, where this device has them. */
  push?: PushSupport
  /** A name for this device in lists, e.g. "Pixel 8" or "Chrome on Windows". */
  deviceLabel?: string
  /** Native Android: saves an export from the API (e.g. a vCard file) where the person chooses. */
  saveExport?: (path: string, name: string) => Promise<void>
  /** Native Android save/open, using the already-unlocked session. */
  downloadFile?: (file: { id: string; name: string; mediaType: string }, action: 'save' | 'open') => Promise<void>
}
