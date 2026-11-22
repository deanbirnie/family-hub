/**
 * The phone's copy of the family vault key, wrapped by the native VaultKey
 * plugin (VaultKeyPlugin.java): a hardware-keystore key usable only shortly
 * after a fingerprint or face check. Builds for the browser end-to-end test
 * (__FAKE_DEVICE__) use a WebCrypto key in its place; release builds never
 * contain that.
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { Platform } from '@family-hub/ui'
import { fromBase64, toBase64 } from './device-auth.ts'

interface VaultKeyPlugin {
  wrap(options: { data: string }): Promise<{ data: string }>
  unwrap(options: { data: string }): Promise<{ data: string }>
  forget(): Promise<void>
}

const Native = registerPlugin<VaultKeyPlugin>('VaultKey')

// The server stores wrapped keys as base64url.
const toUrl = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromUrl = (b64u: string) => {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/')
  return b64 + '='.repeat((4 - (b64.length % 4)) % 4)
}

function fakeVaultKey(): VaultKeyPlugin {
  const STORE = 'familyhub.fakeVaultKey'
  const key = async () => {
    let raw = localStorage.getItem(STORE)
    if (!raw) {
      raw = toBase64(crypto.getRandomValues(new Uint8Array(32)))
      localStorage.setItem(STORE, raw)
    }
    return crypto.subtle.importKey('raw', fromBase64(raw) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
  }
  return {
    async wrap({ data }) {
      const iv = crypto.getRandomValues(new Uint8Array(12))
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), fromBase64(data) as BufferSource))
      return { data: toBase64(Uint8Array.of(...iv, ...ct)) }
    },
    async unwrap({ data }) {
      const raw = fromBase64(data)
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) }, await key(), raw.subarray(12) as BufferSource))
      return { data: toBase64(plain) }
    },
    async forget() {
      localStorage.removeItem(STORE)
    },
  }
}

const VaultKey: VaultKeyPlugin = __FAKE_DEVICE__ && !Capacitor.isNativePlatform() ? fakeVaultKey() : Native

export const vaultDevice: NonNullable<Platform['vaultDevice']> = {
  async wrap(familyKey) {
    return toUrl((await VaultKey.wrap({ data: toBase64(familyKey) })).data)
  },
  async unwrap(wrapped) {
    return fromBase64((await VaultKey.unwrap({ data: fromUrl(wrapped) })).data)
  },
  forget: () => VaultKey.forget(),
}
