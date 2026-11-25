/**
 * An SOS's background sending on this phone (phase 10b), by SosService.java:
 * the location every 2 minutes (5 on low battery) with the pass the hub gave
 * for this SOS, kept and sent together when there is no signal.
 *
 * Builds for the browser end-to-end test (__FAKE_DEVICE__) use timers and
 * the browser's location in the page instead; release builds never contain
 * that.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { browserLocation, type SosStatus, type SosSupport } from '@family-hub/ui'

interface SosPluginApi {
  start(options: { server: string; id: string; pass: string }): Promise<void>
  status(): Promise<SosStatus>
  end(options: { reason: string; note: string }): Promise<void>
}

const Native = registerPlugin<SosPluginApi>('Sos')

export function makeSos(server: string): SosSupport {
  const listeners = new Set<() => void>()
  const emit = () => listeners.forEach((l) => l())
  const subscribe = (l: () => void) => {
    listeners.add(l)
    return () => void listeners.delete(l)
  }
  if (!__FAKE_DEVICE__ && Capacitor.isNativePlatform()) {
    return {
      start: async ({ id, pass }) => {
        await Native.start({ server, id, pass })
        emit()
      },
      status: () => Native.status(),
      end: async (reason, note) => {
        await Native.end({ reason, note })
        emit()
      },
      subscribe,
    }
  }
  return fakeSos(server, emit, subscribe)
}

/** The browser stand-in for the end-to-end test: the same requests, from the page. */
function fakeSos(server: string, emit: () => void, subscribe: SosSupport['subscribe']): SosSupport {
  const where = browserLocation()
  let state: { id: string; pass: string; timer: ReturnType<typeof setInterval> } | null = null
  const status: SosStatus = { active: false, id: null, waiting: 0, lastSentAt: null, lastFixAt: null }
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
  }
}
