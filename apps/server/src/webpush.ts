/**
 * Web Push, with Node's built-in crypto only (the server has no npm
 * dependencies). Used for browsers (Web Push) and Android (UnifiedPush, which
 * speaks the same protocol to ntfy and other distributors).
 *
 * - The message is encrypted to the receiving browser or phone (RFC 8291,
 *   "aes128gcm" content encoding, RFC 8188), so the push service in between
 *   (ntfy, Google, Mozilla, Apple) cannot read it.
 * - The request is signed with the hub's VAPID key (RFC 8292), so a push
 *   service can tell the hub's messages apart and refuse anyone else's.
 */
import { createCipheriv, createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto'

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url')
const unb64u = (s: string) => Buffer.from(s, 'base64url')

const hkdf = (salt: Buffer, ikm: Buffer, info: Buffer, length: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, length))

/** A receiver's keys, as a browser's PushSubscription or a UnifiedPush endpoint gives them. */
export interface PushKeys {
  /** The receiver's P-256 public key, uncompressed, base64url (65 bytes). */
  p256dh: string
  /** The receiver's 16-byte authentication secret, base64url. */
  auth: string
}

/** Checks a receiver's keys are the right shape and a real P-256 point. */
export function validPushKeys(keys: PushKeys): boolean {
  try {
    const pub = unb64u(keys.p256dh)
    const auth = unb64u(keys.auth)
    if (pub.length !== 65 || pub[0] !== 4 || auth.length !== 16) return false
    // Throws if the point is not on the curve.
    const probe = createECDH('prime256v1')
    probe.generateKeys()
    probe.computeSecret(pub)
    return true
  } catch {
    return false
  }
}

/** For tests: the sender's key pair and salt, which are random otherwise. */
export interface EncryptFixed {
  senderPrivate: Buffer
  salt: Buffer
}

/** Encrypts one message to a receiver (RFC 8291, section 3; one record). */
export function encryptPayload(keys: PushKeys, plaintext: Buffer, fixed?: EncryptFixed): Buffer {
  const uaPublic = unb64u(keys.p256dh)
  const authSecret = unb64u(keys.auth)
  const ecdh = createECDH('prime256v1')
  if (fixed) ecdh.setPrivateKey(fixed.senderPrivate)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const salt = fixed?.salt ?? randomBytes(16)

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hkdf(authSecret, shared, keyInfo, 32)
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12)

  // One record: the plaintext, then the 0x02 "last record" delimiter.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])

  const recordSize = Buffer.alloc(4)
  recordSize.writeUInt32BE(4096)
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, body])
}

/** Largest message we send; push services accept at least 4096 bytes after encryption. */
export const MAX_PLAINTEXT = 3000

// ---- VAPID (RFC 8292) ----------------------------------------------------------------

export interface VapidKeys {
  /** Uncompressed public key, base64url: what browsers need as applicationServerKey. */
  publicKey: string
  /** PKCS#8 private key, base64url. Stored sealed with the server key. */
  privateKey: string
}

export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(pkcs8FromRaw(ecdh.getPrivateKey(), ecdh.getPublicKey())) }
}

/** Wraps a raw P-256 private key in PKCS#8 via JWK, so node:crypto can sign with it. */
function pkcs8FromRaw(priv: Buffer, pub: Buffer): Buffer {
  const key = createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', d: b64u(priv), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) },
    format: 'jwk',
  })
  return key.export({ format: 'der', type: 'pkcs8' })
}

const privateKeyFrom = (vapid: VapidKeys): KeyObject => createPrivateKey({ key: unb64u(vapid.privateKey), format: 'der', type: 'pkcs8' })

/** The Authorization header for one push request. */
export function vapidAuthorization(endpoint: string, vapid: VapidKeys, subject: string, nowMs: number): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64u(
    Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })),
  )
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyFrom(vapid), dsaEncoding: 'ieee-p1363' })
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`
}

/** The public key of a VAPID key pair, for checking a signature in tests. */
export const vapidPublicKeyObject = (publicKey: string): KeyObject => {
  const raw = unb64u(publicKey)
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33, 65)) }, format: 'jwk' })
}

// ---- sending -------------------------------------------------------------------------

export type SendOutcome =
  /** Accepted by the push service. */
  | { ok: true }
  /** The push service says this address no longer exists: forget it. */
  | { ok: false; gone: true; status: number }
  /** Anything else: try again later, and report the route as failing. */
  | { ok: false; gone: false; status: number | null; error: string }

/** How the server makes outbound requests; tests replace it. */
export type PushFetch = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer; signal: AbortSignal }) => Promise<{ status: number }>

export const defaultPushFetch: PushFetch = async (url, init) => {
  const res = await fetch(url, { ...init, redirect: 'error' })
  // The body is not needed; release the connection.
  await res.body?.cancel().catch(() => {})
  return { status: res.status }
}

export interface PushMessage {
  title: string
  body: string
  /** Notifications with the same tag replace each other, so one reminder shows once. */
  tag: string
  /** Where tapping it goes, inside the app. */
  url: string
}

export async function sendPush(
  fetcher: PushFetch,
  target: { endpoint: string; keys: PushKeys },
  message: PushMessage,
  vapid: VapidKeys,
  subject: string,
  nowMs: number,
  ttlSeconds = 24 * 3600,
): Promise<SendOutcome> {
  const plaintext = Buffer.from(JSON.stringify(message))
  if (plaintext.length > MAX_PLAINTEXT) return { ok: false, gone: false, status: null, error: 'message too long' }
  try {
    const res = await fetcher(target.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        TTL: String(ttlSeconds),
        Urgency: 'normal',
        Authorization: vapidAuthorization(target.endpoint, vapid, subject, nowMs),
      },
      body: encryptPayload(target.keys, plaintext),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status >= 200 && res.status < 300) return { ok: true }
    if (res.status === 404 || res.status === 410) return { ok: false, gone: true, status: res.status }
    return { ok: false, gone: false, status: res.status, error: `push service answered ${res.status}` }
  } catch (e) {
    return { ok: false, gone: false, status: null, error: e instanceof Error ? e.message.slice(0, 200) : 'request failed' }
  }
}

/**
 * Whether an address is acceptable to send to: https only, no user name or
 * password in it, and a sensible length. Addresses come from signed-in
 * family members' own browsers and phones.
 */
export function validEndpoint(endpoint: string, allowHttp: boolean): boolean {
  if (endpoint.length > 1024) return false
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.username || url.password || url.hash) return false
  return url.protocol === 'https:' || (allowHttp && url.protocol === 'http:')
}
