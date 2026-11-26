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

/** An SOS on this phone, as the native service sees it. */
export interface SosStatus {
  active: boolean
  id: string | null
  /** Locations kept while there was no signal. */
  waiting: number
  lastSentAt: number | null
  lastFixAt: number | null
  /** Set up on this phone (10c): the SOS key registered, so it starts from the lock screen too. */
  ready?: boolean
  /** Whether it may send an SMS with no data. */
  sms?: boolean
}

/** What the SOS screen shows, with no fingerprint (the owner's choice): this person's emergency contacts and medical essentials. */
export interface SosCard {
  name: string
  contacts: { label: string; name: string; phone: string }[]
  bloodType: string
  severeAllergies: string[]
  otherAllergies: string[]
  medicines: string[]
  conditions: string[]
  careNotes: string
}

export interface SosSupport {
  /** Starts sending, with the pass the hub gave for this SOS. */
  start(args: { id: string; pass: string }): Promise<void>
  status(): Promise<SosStatus>
  /** Ends it with why; rejects (and keeps it on) with no connection. */
  end(reason: 'whoops' | 'services' | 'safe' | 'other', note: string): Promise<void>
  /** Told when it starts or ends here. */
  subscribe(listener: () => void): () => void
  /** 10c: sets SOS up on this phone (permissions, the SOS key), for the lock screen and the SMS with no data. */
  setup?(name: string): Promise<{ sms: boolean; location: boolean }>
  /** 10c: refreshes what a locked phone keeps (the family's numbers, the person's name). */
  refresh?(name: string): Promise<void>
  /** 10c: keeps this person's details for the SOS screen. */
  saveCard?(card: SosCard): Promise<void>
  /** 10c: the details for the SOS screen, or null. */
  card?(): Promise<SosCard | null>
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
  /** Android: an SOS's background sending (phase 10b): locations every 2 (or 5) minutes, kept and sent later with no signal. */
  sos?: SosSupport
  /** Where this device is now (phase 10: "Arrived"); asks permission the first time. Rejects with a readable reason. */
  location?: { current(): Promise<Position> }
  /** Native Android save/open, using the already-unlocked session. */
  downloadFile?: (file: { id: string; name: string; mediaType: string }, action: 'save' | 'open') => Promise<void>
}
