/**
 * The family vault's cryptography, done on the device with WebCrypto. The
 * server only ever sees the results: wrapped keys, a check value and pairing
 * messages, none of which it can open. (See apps/server/src/routes/vault.ts
 * and docs/DATA-PROTECTION.md, tier E2E.)
 *
 * - The family key: 32 random bytes; AES-256-GCM.
 * - Wrapping: the family key encrypted (AES-256-GCM) under a 32-byte key
 *   belonging to one way of opening the vault, with associated data naming it.
 * - The recovery key: 32 random bytes, written as "FH1-" and base32 groups,
 *   for a password manager.
 * - Pairing: ECDH P-256 between a one-time key on the new device and one on
 *   the approving device; HKDF-SHA-256 of the shared secret (salted with both
 *   public keys) encrypts the family key. Six words derived from the new
 *   device's public key are compared on both screens.
 */
import { WORDS } from './words.ts'

const enc = new TextEncoder()
const subtle = () => globalThis.crypto.subtle

export const toB64u = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

export function fromB64u(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)), (c) => c.charCodeAt(0))
}

export const randomBytes = (n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n))
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let i = 0
  for (const p of parts) {
    out.set(p, i)
    i += p.length
  }
  return out
}

export class VaultCryptoError extends Error {}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new VaultCryptoError('A vault key must be 32 bytes.')
  return subtle().importKey('raw', raw as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

/** AES-256-GCM: base64url(iv ‖ ciphertext ‖ tag). */
export async function seal(key: Uint8Array, plain: Uint8Array, aad: string): Promise<string> {
  const iv = randomBytes(12)
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv as BufferSource, additionalData: enc.encode(aad) }, await aesKey(key), plain as BufferSource))
  return toB64u(cat(iv, ct))
}

export async function open(key: Uint8Array, sealed: string, aad: string): Promise<Uint8Array> {
  const raw = fromB64u(sealed)
  if (raw.length < 28) throw new VaultCryptoError('The vault data is damaged.')
  try {
    return new Uint8Array(
      await subtle().decrypt({ name: 'AES-GCM', iv: raw.subarray(0, 12) as BufferSource, additionalData: enc.encode(aad) }, await aesKey(key), raw.subarray(12) as BufferSource),
    )
  } catch {
    throw new VaultCryptoError('That key does not open the family vault.')
  }
}

export async function hkdf(secret: Uint8Array, info: string, salt: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', secret as BufferSource, 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: enc.encode(info) }, base, 256))
}

// ---- the family key -------------------------------------------------------------------

export const newFamilyKey = () => randomBytes(32)

const CHECK_TEXT = 'family-hub vault check v1'

/** A known text under the family key, so a device can tell it holds the right one. */
export const makeCheck = (familyKey: Uint8Array) => seal(familyKey, enc.encode(CHECK_TEXT), 'family-hub/check')

export async function verifyCheck(familyKey: Uint8Array, check: string): Promise<boolean> {
  try {
    return new TextDecoder().decode(await open(familyKey, check, 'family-hub/check')) === CHECK_TEXT
  } catch {
    return false
  }
}

export type WrapKind = 'recovery' | 'passkey' | 'device'

export const wrapFamilyKey = (wrappingKey: Uint8Array, familyKey: Uint8Array, kind: WrapKind) =>
  seal(wrappingKey, familyKey, `family-hub/wrap/${kind}`)

export async function unwrapFamilyKey(wrappingKey: Uint8Array, wrapped: string, kind: WrapKind): Promise<Uint8Array> {
  const key = await open(wrappingKey, wrapped, `family-hub/wrap/${kind}`)
  if (key.length !== 32) throw new VaultCryptoError('The vault data is damaged.')
  return key
}

/** A passkey's PRF output, turned into its wrapping key. */
export const passkeyWrappingKey = (prfOutput: Uint8Array) => hkdf(prfOutput, 'family-hub/passkey-wrap')

// ---- the recovery key -----------------------------------------------------------------

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function formatRecoveryKey(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const b of bytes) {
    value = ((value << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return `FH1-${out.match(/.{1,4}/g)!.join('-')}`
}

/** Reads a recovery key as typed or pasted (case, spaces and dashes do not matter). */
export function parseRecoveryKey(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^FH1/, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const i = B32.indexOf(ch)
    if (i < 0) throw new VaultCryptoError('That is not a recovery key. It starts with FH1- and has only letters and the digits 2 to 7.')
    value = ((value << 5) | i) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  if (out.length !== 32) throw new VaultCryptoError('That recovery key is not complete. Copy it again from your password manager.')
  return Uint8Array.from(out)
}

// ---- pairing a new device ----------------------------------------------------------

export interface PairingKeys {
  privateKey: CryptoKey
  /** SubjectPublicKeyInfo, base64url: what the new device posts. */
  publicKey: string
}

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const

export async function newPairingKeys(): Promise<PairingKeys> {
  const pair = (await subtle().generateKey(ECDH, false, ['deriveBits'])) as CryptoKeyPair
  return { privateKey: pair.privateKey, publicKey: toB64u(new Uint8Array(await subtle().exportKey('spki', pair.publicKey))) }
}

async function pairingKey(privateKey: CryptoKey, peerSpki: string, newDeviceSpki: string, approverSpki: string): Promise<Uint8Array> {
  const peer = await subtle().importKey('spki', fromB64u(peerSpki) as BufferSource, ECDH, false, [])
  const shared = new Uint8Array(await subtle().deriveBits({ name: 'ECDH', public: peer }, privateKey, 256))
  return hkdf(shared, 'family-hub/pairing', cat(fromB64u(newDeviceSpki), fromB64u(approverSpki)))
}

/** On the approving device: the family key, encrypted to the new device's public key. */
export async function sealForNewDevice(familyKey: Uint8Array, newDeviceSpki: string, pairingId: string): Promise<string> {
  const mine = await newPairingKeys()
  const key = await pairingKey(mine.privateKey, newDeviceSpki, newDeviceSpki, mine.publicKey)
  const ct = await seal(key, familyKey, `family-hub/pairing/${pairingId}`)
  return toB64u(enc.encode(JSON.stringify({ v: 1, epk: mine.publicKey, ct })))
}

/** On the new device: the family key from the approval. */
export async function openFromApproval(keys: PairingKeys, payload: string, pairingId: string): Promise<Uint8Array> {
  let parsed: { v?: number; epk?: string; ct?: string }
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromB64u(payload))) as typeof parsed
  } catch {
    throw new VaultCryptoError('The approval was damaged. Start again.')
  }
  if (parsed.v !== 1 || typeof parsed.epk !== 'string' || typeof parsed.ct !== 'string') throw new VaultCryptoError('The approval was damaged. Start again.')
  const key = await pairingKey(keys.privateKey, parsed.epk, keys.publicKey, parsed.epk)
  const familyKey = await open(key, parsed.ct, `family-hub/pairing/${pairingId}`)
  if (familyKey.length !== 32) throw new VaultCryptoError('The approval was damaged. Start again.')
  return familyKey
}

/**
 * Six words from the new device's public key (48 bits). Both screens show
 * them; if they match, the approving device is encrypting to the real new
 * device, not to a key swapped in on the way.
 */
export async function checkWords(spki: string): Promise<string[]> {
  const digest = new Uint8Array(await subtle().digest('SHA-256', fromB64u(spki) as BufferSource))
  return Array.from(digest.subarray(0, 6), (b) => WORDS[b]!)
}
