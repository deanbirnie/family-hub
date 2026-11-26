/**
 * An SOS on this phone (phase 10), by SosService.java: the location every 2
 * minutes (5 on low battery) with the pass the hub gave for this SOS, kept
 * and sent together when there is no signal, and by SMS to the family with
 * no data for a minute (10c). Set up once (permissions and the SOS key), it
 * also starts from the lock screen with the Quick Settings tile.
 *
 * Builds for the browser end-to-end test (__FAKE_DEVICE__) use timers, the
 * browser's location and a WebCrypto key in the page instead; release builds
 * never contain that.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { browserLocation, type Api, type SosCard, type SosStatus, type SosSupport } from '@family-hub/ui'

interface SosPluginApi {
  start(options: { server: string; id: string; pass: string; name: string }): Promise<void>
  status(): Promise<SosStatus>
  end(options: { reason: string; note: string }): Promise<void>
  prepare(): Promise<{ publicKey: string; location: boolean; sms: boolean }>
  store(options: Record<string, unknown>): Promise<void>
  card(): Promise<{ card: SosCard | null }>
  forget(): Promise<void>
}

const Native = registerPlugin<SosPluginApi>('Sos')
const native = () => !__FAKE_DEVICE__ && Capacitor.isNativePlatform()

/** Forgets the SOS key and what a locked phone keeps (when the phone is signed out). */
export const forgetSos = () => (native() ? Native.forget() : Promise.resolve(localStorage.removeItem(FAKE_STORE)))

const FAKE_STORE = 'familyhub.sosStore'

export function makeSos(server: string, api: Api, deviceId: () => string): SosSupport {
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((l) => l())
  const subscribe = (l: () => void) => {
    listeners.add(l)
    return () => void listeners.delete(l)
  }
  let name = ''
  const numbers = async () => (await api.get<{ numbers: { name: string; phone: string }[] }>('/api/safety/sos-numbers')).numbers

  if (native()) {
    return {
      start: async ({ id, pass }) => {
        await Native.start({ server, id, pass, name })
        emit()
      },
      status: () => Native.status(),
      end: async (reason, note) => {
        await Native.end({ reason, note })
        emit()
      },
      subscribe,
      setup: async (who) => {
        name = who
        const r = await Native.prepare()
        await api.request('PUT', '/api/safety/sos-key', { publicKey: r.publicKey })
        await Native.store({ server, deviceId: deviceId(), name: who, numbers: await numbers() })
        emit()
        return { sms: r.sms, location: r.location }
      },
      refresh: async (who) => {
        name = who
        await Native.store({ server, deviceId: deviceId(), name: who, numbers: await numbers() })
      },
      saveCard: (card) => Native.store({ card }),
      card: async () => (await Native.card()).card,
    }
  }
  return fakeSos(server, api, emit, subscribe, numbers)
}

/** The browser stand-in for the end-to-end test: the same requests, from the page. */
function fakeSos(server: string, api: Api, emit: () => void, subscribe: SosSupport['subscribe'], numbers: () => Promise<{ name: string; phone: string }[]>): SosSupport {
  const where = browserLocation()
  let state: { id: string; pass: string; timer: ReturnType<typeof setInterval> } | null = null
  const status: SosStatus = { active: false, id: null, waiting: 0, lastSentAt: null, lastFixAt: null, ready: false, sms: false }
  const read = (): Record<string, unknown> => {
    try {
      return JSON.parse(localStorage.getItem(FAKE_STORE) ?? '{}') as Record<string, unknown>
    } catch {
      return {}
    }
  }
  const store = (changes: Record<string, unknown>) => localStorage.setItem(FAKE_STORE, JSON.stringify({ ...read(), ...changes }))
  status.ready = !!read().ready
  const post = (path: string, body: unknown) =>
    fetch(`${server.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-requested-with': 'family-hub' }, body: JSON.stringify(body) })
  const send = async () => {
    if (!state || !where) return
    const p = await where.current().catch(() => null)
    if (!p || !state) return
    status.lastFixAt = Date.now()
    const r = await post(`/api/safety/sos/${state.id}/points`, { pass: state.pass, points: [{ ...p, at: Date.now() }] }).catch(() => null)
    if (r?.ok) status.lastSentAt = Date.now()
    emit()
  }
  return {
    start: async ({ id, pass }) => {
      if (state) clearInterval(state.timer)
      state = { id, pass, timer: setInterval(() => void send(), 2 * 60_000) }
      Object.assign(status, { active: true, id })
      emit()
      void send()
    },
    status: async () => ({ ...status }),
    end: async (reason, note) => {
      if (!state) return
      const r = await post(`/api/safety/sos/${state.id}/end`, { pass: state.pass, reason, note })
      if (!r.ok && r.status !== 404 && r.status !== 410) throw new Error('The hub did not take it. Try again.')
      clearInterval(state.timer)
      state = null
      Object.assign(status, { active: false, id: null, lastSentAt: null, lastFixAt: null })
      emit()
    },
    subscribe,
    setup: async (name) => {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
      const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))
      await api.request('PUT', '/api/safety/sos-key', { publicKey: btoa(String.fromCharCode(...spki)) })
      store({ ready: true, name, numbers: await numbers() })
      status.ready = true
      emit()
      return { sms: false, location: !!where }
    },
    refresh: async (name) => store({ name, numbers: await numbers() }),
    saveCard: async (card) => store({ card }),
    card: async () => (read().card as SosCard | undefined) ?? null,
  }
}
