/**
 * What the shared interface needs from the app around it. The web app and
 * the Android app each provide one.
 */
import type { EmergencyCard } from './health/reports.ts'
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

/** A device's position: degrees, and how far off it may be in metres. */
export interface Position {
  latitude: number
  longitude: number
  accuracy: number | null
}

/** The browser's location, where it has one. */
export function browserLocation(): Platform['location'] {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return undefined
  return {
    current: () =>
      new Promise((resolve, reject) =>
        navigator.geolocation.getCurrentPosition(
          (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null }),
          (e) => reject(new Error(e.code === e.PERMISSION_DENIED ? 'Location is blocked for this site. Allow it in the browser to share where you are.' : 'This device could not find where it is. Try again.')),
          { enableHighAccuracy: true, timeout: 30_000, maximumAge: 60_000 },
        ),
      ),
  }
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
  /** Saves or shares a file made on this device (a PDF report). Without it, the browser downloads it or offers its share sheet. */
  saveFile?: (file: { name: string; bytes: Uint8Array }, action: 'save' | 'share') => Promise<void>
  /**
   * Android: the offline emergency card. Made whenever the family vault is
   * open (no fingerprint needed to update it); opening it needs a fingerprint
   * or face check but no network.
   */
  emergencyCard?: {
    save(cards: EmergencyCard[]): Promise<void>
    /** The cards, after a fingerprint or face check; null if there are none on this phone. */
    open(): Promise<EmergencyCard[] | null>
    /** When the cards were last updated (ms), or null if there are none. Readable without unlocking. */
    updatedAt(): number | null
    /** Removes the cards and their key (when the phone is signed out). */
    clear(): Promise<void>
  }
  /** Where this device is now (phase 10: "Arrived"); asks permission the first time. Rejects with a readable reason. */
  location?: { current(): Promise<Position> }
  /** Native Android save/open, using the already-unlocked session. */
  downloadFile?: (file: { id: string; name: string; mediaType: string }, action: 'save' | 'open') => Promise<void>
}
