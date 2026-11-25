/**
 * Where this phone is now (phase 10: "Arrived"), from LocationPlugin.java:
 * Android's own location service, asking permission the first time.
 *
 * Builds for the browser end-to-end test (__FAKE_DEVICE__) use the browser's
 * location instead; release builds never contain that.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { browserLocation, type Platform, type Position } from '@family-hub/ui'

interface LocationPluginApi {
  current(): Promise<Position & { at: number }>
}

const Native = registerPlugin<LocationPluginApi>('Location')

export const location: Platform['location'] =
  __FAKE_DEVICE__ || !Capacitor.isNativePlatform()
    ? browserLocation()
    : {
        current: async () => {
          const p = await Native.current()
          return { latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy ?? null }
        },
      }
