// Family Hub's service worker: shows push notifications, nothing else (no
// caching, no fetch handling). Messages are generic ("A family document
// expires soon"); the details are only in the signed-in app.
'use strict'

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  const title = typeof data.title === 'string' ? data.title : 'Family Hub'
  const body = typeof data.body === 'string' ? data.body : 'Something needs your attention.'
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/'
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/favicon.svg',
      data: { url },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const path = (event.notification.data && event.notification.data.url) || '/'
  const url = new URL(path, self.location.origin).href
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin)
      return open ? open.focus() : self.clients.openWindow(url)
    }),
  )
})

// The browser replaced this device's push address: tell the hub the new one.
self.addEventListener('pushsubscriptionchange', (event) => {
  const old = event.oldSubscription
  const key = old && old.options && old.options.applicationServerKey
  if (!key) return
  event.waitUntil(
    self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).then((sub) => {
      const json = sub.toJSON()
      return fetch('/api/notifications/subscriptions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'family-hub' },
        body: JSON.stringify({ kind: 'webpush', endpoint: sub.endpoint, keys: json.keys, label: 'This browser' }),
      })
    }),
  )
})
