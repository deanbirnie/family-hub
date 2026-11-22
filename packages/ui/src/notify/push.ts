/**
 * Push notifications on this device: turning them on and off, and keeping
 * the server's copy of this device's push address current. The browser uses
 * Web Push (webpush.ts); the Android app provides its own (UnifiedPush).
 */
import type { Api } from '../api.ts'
import type { Platform, PushSupport } from '../platform.ts'

export interface PushRoute {
  id: string
  kind: 'webpush' | 'unifiedpush'
  label: string
  phone: boolean
  /** SHA-256 of the push address, to recognise this device in the list. */
  fingerprint: string
  createdAt: number
  lastOkAt: number | null
  failing: boolean
  failingSince: number | null
  lastError: string | null
}

export interface NotificationSettings {
  enabled: boolean
  expiry: boolean
  dates: boolean
  sendHour: number
}

/** A phone running the daily background check. */
export interface DailyCheck {
  deviceId: string
  label: string
  current: boolean
  createdAt: number
  lastCheckAt: number | null
}

export interface NotificationState {
  vapidPublicKey: string
  timeZone: string
  settings: NotificationSettings
  routes: PushRoute[]
  checks: DailyCheck[]
}

export async function fingerprint(endpoint: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)))
  let bin = ''
  for (const b of digest) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function register(api: Api, push: PushSupport, target: { endpoint: string; keys: { p256dh: string; auth: string } }, label: string): Promise<PushRoute> {
  const { route } = await api.post<{ route: PushRoute }>('/api/notifications/subscriptions', { kind: push.kind, ...target, label })
  return route
}

/**
 * Turns notifications on for this device (asks permission first). Returns the
 * push route, or null for a phone without a push app (daily check only).
 */
export async function turnOn(platform: Platform, vapidPublicKey: string): Promise<PushRoute | null> {
  const push = platform.push
  if (!push) throw new Error('This device cannot show notifications.')
  const target = await push.enable(vapidPublicKey)
  return target ? register(platform.api, push, target, platform.deviceLabel ?? 'This device') : null
}

/** Turns them off here: on the server and in the browser. */
export async function turnOff(platform: Platform, routes?: PushRoute[]): Promise<void> {
  const push = platform.push
  if (!push) return
  const current = await push.current()
  if (current) {
    const mine = await fingerprint(current.endpoint)
    const list = routes ?? (await platform.api.get<NotificationState>('/api/notifications')).routes
    const route = list.find((r) => r.fingerprint === mine)
    if (route) await platform.api.del(`/api/notifications/subscriptions/${route.id}`).catch(() => undefined)
  }
  await push.disable()
}

/**
 * After signing in: if this device already has notifications on, tell the
 * server again (its address may have changed, or someone else signed in).
 */
export async function refreshPush(platform: Platform): Promise<void> {
  const push = platform.push
  if (!push) return
  const current = await push.current()
  if (current) await register(platform.api, push, current, platform.deviceLabel ?? 'This device')
}
