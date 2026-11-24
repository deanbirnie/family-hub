/**
 * The offline emergency card (phase 5d), kept on this phone.
 *
 * Each time the family vault is open, the app makes the cards and encrypts
 * them: a fresh AES-256 key seals the cards (AES-GCM), and that key is
 * sealed with the public half of an RSA key pair in the Android Keystore
 * (EmergencyCardPlugin.java). Updating needs no fingerprint. Opening needs
 * the private key, which works only right after a fingerprint or face check
 * and never leaves the keystore. No network is involved, so the card opens
 * from the locked screen without a signal.
 *
 * Only "when it was last updated" is readable without unlocking.
 *
 * Builds for the browser end-to-end test (__FAKE_DEVICE__) use a WebCrypto
 * key pair in place of the keystore; release builds never contain that.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { EmergencyCard, Platform } from '@family-hub/ui'
import { fromBase64, toBase64 } from './device-auth.ts'

interface CardKeyPlugin {
  publicKey(): Promise<{ data: string }>
  open(options: { data: string }): Promise<{ data: string }>
  forget(): Promise<void>
}

const Native = registerPlugin<CardKeyPlugin>('EmergencyCard')

const STORE = 'familyhub.emergencyCard'
const AAD = new TextEncoder().encode('family-hub/emergency-card/v1')
const OAEP = { name: 'RSA-OAEP', hash: 'SHA-1' } as const

interface Stored {
  v: 1
  /** The AES key, sealed with the keystore's public key. */
  wrapped: string
  iv: string
  ct: string
  updatedAt: number
}

function fakeCardKey(): CardKeyPlugin {
  const KEY = 'familyhub.fakeCardKey'
  const pair = async () => {
    const saved = localStorage.getItem(KEY)
    if (saved) {
      const { pub, priv } = JSON.parse(saved) as { pub: JsonWebKey; priv: JsonWebKey }
      return { pub, priv: await crypto.subtle.importKey('jwk', priv, OAEP, false, ['decrypt']) }
    }
    const made = await crypto.subtle.generateKey({ ...OAEP, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, true, ['encrypt', 'decrypt'])
    const pub = await crypto.subtle.exportKey('jwk', made.publicKey)
    localStorage.setItem(KEY, JSON.stringify({ pub, priv: await crypto.subtle.exportKey('jwk', made.privateKey) }))
    return { pub, priv: made.privateKey }
  }
  return {
    async publicKey() {
      const { pub } = await pair()
      const key = await crypto.subtle.importKey('jwk', pub, OAEP, true, ['encrypt'])
      return { data: toBase64(new Uint8Array(await crypto.subtle.exportKey('spki', key))) }
    },
    async open({ data }) {
      const { priv } = await pair()
      return { data: toBase64(new Uint8Array(await crypto.subtle.decrypt(OAEP, priv, fromBase64(data) as BufferSource))) }
    },
    async forget() {
      localStorage.removeItem(KEY)
    },
  }
}

const CardKey: CardKeyPlugin = __FAKE_DEVICE__ && !Capacitor.isNativePlatform() ? fakeCardKey() : Native

const read = (): Stored | null => {
  try {
    const raw = localStorage.getItem(STORE)
    const parsed = raw ? (JSON.parse(raw) as Stored) : null
    return parsed?.v === 1 ? parsed : null
  } catch {
    return null
  }
}

/** The last cards saved in this app session, so an unchanged set is not encrypted again. */
let lastSaved = ''

export const emergencyCard: NonNullable<Platform['emergencyCard']> = {
  async save(cards) {
    const json = JSON.stringify(cards.map((c) => ({ ...c, updatedAt: 0 })))
    if (json === lastSaved && read()) return
    const spki = fromBase64((await CardKey.publicKey()).data)
    const publicKey = await crypto.subtle.importKey('spki', spki as BufferSource, OAEP, false, ['encrypt'])
    const raw = crypto.getRandomValues(new Uint8Array(32))
    const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(JSON.stringify(cards))))
    const wrapped = new Uint8Array(await crypto.subtle.encrypt(OAEP, publicKey, raw as BufferSource))
    raw.fill(0)
    const stored: Stored = { v: 1, wrapped: toBase64(wrapped), iv: toBase64(iv), ct: toBase64(ct), updatedAt: Date.now() }
    localStorage.setItem(STORE, JSON.stringify(stored))
    lastSaved = json
  },

  async open() {
    const stored = read()
    if (!stored) return null
    let raw: Uint8Array
    try {
      raw = fromBase64((await CardKey.open({ data: stored.wrapped })).data)
    } catch (e) {
      // New fingerprints or face: the key is gone, and so is this copy. The next open vault makes it again.
      if ((e as { code?: string }).code === 'INVALIDATED') localStorage.removeItem(STORE)
      throw e
    }
    const key = await crypto.subtle.importKey('raw', raw as BufferSource, 'AES-GCM', false, ['decrypt'])
    raw.fill(0)
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(stored.iv) as BufferSource, additionalData: AAD }, key, fromBase64(stored.ct) as BufferSource)
    return JSON.parse(new TextDecoder().decode(plain)) as EmergencyCard[]
  },

  updatedAt: () => read()?.updatedAt ?? null,

  async clear() {
    lastSaved = ''
    localStorage.removeItem(STORE)
    await CardKey.forget().catch(() => undefined)
  },
}
