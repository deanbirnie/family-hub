/**
 * Notifications on the phone (PushPlugin.java): a daily background check
 * that asks the hub what is due, which always works, and UnifiedPush
 * through the push app the person installed (ntfy or another) for reminders
 * as soon as they are sent. Browser end-to-end builds have neither.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Api, PushSupport } from '@family-hub/ui'

type Target = { endpoint: string; keys: { p256dh: string; auth: string } }

interface PushNative {
  status(): Promise<{
    permission: 'granted' | 'denied' | 'prompt'
    daily: boolean
    lastCheck: number
    distributors: string[]
    distributor?: string | null
    endpoint?: Target | null
  }>
  requestPermission(): Promise<{ permission: 'granted' | 'denied' | 'prompt' }>
  configure(options: { serverUrl: string; checkToken: string }): Promise<void>
  register(options: { vapid: string }): Promise<{ endpoint?: Target | null; problem?: string }>
  disable(): Promise<void>
  checkNow(): Promise<{ shown: number }>
}

const Native = registerPlugin<PushNative>('Push')

/** Friendly names for the push apps people are likely to have. */
const PUSH_APPS: Record<string, string> = {
  'io.heckel.ntfy': 'ntfy',
  'org.unifiedpush.distributor.nextpush': 'NextPush',
  'org.unifiedpush.distributor.sunup': 'Sunup',
}
export const pushAppName = (pkg: string) => PUSH_APPS[pkg] ?? pkg

export function phonePush(api: Api): PushSupport | undefined {
  if (!Capacitor.isNativePlatform()) return undefined
  let lastProblem: string | null = null
  return {
    kind: 'unifiedpush',
    async state() {
      const s = await Native.status()
      if (s.permission === 'denied') return 'denied'
      return s.daily ? 'on' : 'off'
    },
    async enable(vapidPublicKey) {
      const { permission } = await Native.requestPermission()
      if (permission !== 'granted') throw new Error('Notifications were not allowed. Allow them for Family Hub in Android’s settings, then try again.')
      // The daily check first: it works whether or not a push app is installed.
      const { checkToken } = await api.post<{ checkToken: string }>('/api/notifications/check-token')
      await Native.configure({ serverUrl: api.baseUrl, checkToken })
      const result = await Native.register({ vapid: vapidPublicKey })
      lastProblem = result.problem ?? null
      return result.endpoint ?? null
    },
    async current() {
      return (await Native.status()).endpoint ?? null
    },
    async disable() {
      await api.del('/api/notifications/check-token').catch(() => undefined)
      await Native.disable()
    },
    async phone() {
      const s = await Native.status()
      return {
        daily: s.daily,
        lastCheck: s.lastCheck || null,
        pushApp: s.endpoint && s.distributor ? pushAppName(s.distributor) : null,
        pushApps: s.distributors.map(pushAppName),
        problem: lastProblem,
      }
    },
    async checkNow() {
      if ((await Native.status()).daily) await Native.checkNow()
    },
  }
}
