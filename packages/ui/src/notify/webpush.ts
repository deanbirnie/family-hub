/**
 * Web Push in the browser: a small service worker (apps/web/public/sw.js)
 * shows the notifications; the browser's own push service delivers them.
 */
import type { PushSupport } from '../platform.ts'

const b64u = (buf: ArrayBuffer | null) => {
  if (!buf) return ''
  let bin = ''
  for (const b of new Uint8Array(buf)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const fromB64u = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

const target = (sub: PushSubscription) => ({ endpoint: sub.endpoint, keys: { p256dh: b64u(sub.getKey('p256dh')), auth: b64u(sub.getKey('auth')) } })

/** Web Push for this browser, or undefined if it has none (or the page is not on https). */
export function browserPush(): PushSupport | undefined {
  if (typeof window === 'undefined' || !window.isSecureContext) return undefined
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return undefined

  const registration = async () => (await navigator.serviceWorker.getRegistration('/')) ?? null
  const ready = async () => {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    return navigator.serviceWorker.ready
  }

  return {
    kind: 'webpush',
    async state() {
      if (Notification.permission === 'denied') return 'denied'
      const reg = await registration()
      const sub = await reg?.pushManager.getSubscription()
      return sub && Notification.permission === 'granted' ? 'on' : 'off'
    },
    async enable(vapidPublicKey) {
      const permission = await Notification.requestPermission()
      if (permission !== 'granted') throw new Error('Notifications were not allowed. You can allow them in the browser’s site settings.')
      const reg = await ready()
      let sub = await reg.pushManager.getSubscription()
      // A subscription made for another server's key cannot be reused.
      const key = fromB64u(vapidPublicKey)
      const current = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null
      if (sub && (!current || current.length !== key.length || current.some((b, i) => b !== key[i]))) {
        await sub.unsubscribe()
        sub = null
      }
      sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      return target(sub)
    },
    async current() {
      if (Notification.permission !== 'granted') return null
      const sub = await (await registration())?.pushManager.getSubscription()
      return sub ? target(sub) : null
    },
    async disable() {
      const sub = await (await registration())?.pushManager.getSubscription()
      await sub?.unsubscribe()
    },
  }
}
