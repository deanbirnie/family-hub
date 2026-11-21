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
  /** Native Android save/open, using the already-unlocked session. */
  downloadFile?: (file: { id: string; name: string; mediaType: string }, action: 'save' | 'open') => Promise<void>
}
