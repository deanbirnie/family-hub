/**
 * The phone's sign-in key, kept in Android's hardware keystore by the
 * native DeviceAuth plugin (DeviceAuthPlugin.java). The private key never
 * leaves the keystore, and it signs only straight after a fingerprint or face
 * check; a newly enrolled fingerprint or face destroys it.
 *
 * Builds for the browser end-to-end test (__FAKE_DEVICE__) use a WebCrypto
 * key instead, with no biometric check. Release builds never contain it.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'

export interface DeviceStatus {
  /** A strong (class 3) fingerprint or face sensor is set up on the phone. */
  available: boolean
  /** Why not, in words for the person. */
  reason?: string
  /** A key already exists on this phone. */
  hasKey: boolean
  /** The phone's model, to name it in the devices list. */
  model: string
}

interface DeviceAuthPlugin {
  status(): Promise<DeviceStatus>
  /** Makes a new key (replacing any old one); returns its public half, SPKI DER in base64. */
  createKey(): Promise<{ publicKey: string }>
  /** Asks for a fingerprint or face, then signs `message` (base64) with SHA256withECDSA; signature DER in base64. */
  sign(options: { message: string; title: string; subtitle: string }): Promise<{ signature: string }>
  deleteKey(): Promise<void>
}

/** Error codes the native side rejects with. */
export const CANCELLED = 'CANCELLED'
export const INVALIDATED = 'INVALIDATED'

const Native = registerPlugin<DeviceAuthPlugin>('DeviceAuth')

export const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
export const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))

// ---- stand-in for the browser test ---------------------------------------------------

/** ECDSA signatures from WebCrypto are r‖s; the server (like Android) uses DER. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const int = (b: Uint8Array) => {
    let i = 0
    while (i < b.length - 1 && b[i] === 0) i++
    let v = b.slice(i)
    if (v[0]! & 0x80) v = Uint8Array.of(0, ...v)
    return Uint8Array.of(0x02, v.length, ...v)
  }
  const r = int(raw.slice(0, 32))
  const s = int(raw.slice(32))
  return Uint8Array.of(0x30, r.length + s.length, ...r, ...s)
}

function fakeDevice(): DeviceAuthPlugin {
  // Kept in localStorage so it survives a reload, as a keystore key would.
  const STORE = 'familyhub.fakeDeviceKey'
  const algo = { name: 'ECDSA', namedCurve: 'P-256' }
  const load = async () => {
    const jwk = localStorage.getItem(STORE)
    return jwk ? crypto.subtle.importKey('jwk', JSON.parse(jwk) as JsonWebKey, algo, false, ['sign']) : null
  }
  return {
    async status() {
      return { available: true, hasKey: localStorage.getItem(STORE) !== null, model: 'Test phone' }
    },
    async createKey() {
      const pair = await crypto.subtle.generateKey(algo, true, ['sign', 'verify'])
      localStorage.setItem(STORE, JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)))
      return { publicKey: toBase64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))) }
    },
    async sign({ message }) {
      const key = await load()
      if (!key) throw Object.assign(new Error('No key'), { code: INVALIDATED })
      const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, fromBase64(message)))
      return { signature: toBase64(rawToDer(raw)) }
    },
    async deleteKey() {
      localStorage.removeItem(STORE)
    },
  }
}

export const DeviceAuth: DeviceAuthPlugin = __FAKE_DEVICE__ && !Capacitor.isNativePlatform() ? fakeDevice() : Native
