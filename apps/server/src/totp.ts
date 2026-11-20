/**
 * Time-based one-time passwords (RFC 6238): 6 digits, 30-second steps,
 * HMAC-SHA1, as every authenticator app (Google Authenticator, Aegis,
 * 1Password, Bitwarden, Microsoft Authenticator…) expects.
 */
import { createHmac, randomBytes } from 'node:crypto'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
export const STEP_SECONDS = 30
const DIGITS = 6

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase()
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch)
    if (i < 0) throw new Error('Not base32')
    value = ((value << 5) | i) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new secret: 20 random bytes (160 bits, as RFC 4226 recommends), in base32. */
export const newTotpSecret = () => base32Encode(randomBytes(20))

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', secret).update(msg).digest()
  const offset = mac[mac.length - 1]! & 0x0f
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS
  return code.toString().padStart(DIGITS, '0')
}

export const counterAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS)

/** The code an authenticator shows at `ms` (for tests and tools). */
export const totpAt = (secretBase32: string, ms: number) => hotp(base32Decode(secretBase32), counterAt(ms))

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matching counter so the caller can refuse it and any
 * earlier one next time (each code works once), or null.
 */
export function checkTotp(
  secretBase32: string,
  code: unknown,
  lastUsedCounter: number | null,
  now = Date.now(),
): number | null {
  if (typeof code !== 'string') return null
  const digits = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(digits)) return null
  const secret = base32Decode(secretBase32)
  const current = counterAt(now)
  for (const c of [current, current - 1, current + 1]) {
    if (lastUsedCounter !== null && c <= lastUsedCounter) continue
    if (hotp(secret, c) === digits) return c
  }
  return null
}

/** The otpauth:// link an authenticator app reads from the QR code. */
export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  })
  return `otpauth://totp/${label}?${params}`
}

/** Recovery codes: 10 of them, each 10 characters from an unambiguous alphabet, shown as xxxxx-xxxxx. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
export function newRecoveryCodes(count = 10): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    let code = ''
    // Rejection sampling, so every character is equally likely.
    while (code.length < 10) {
      for (const byte of randomBytes(16)) {
        if (byte < 248 && code.length < 10) code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]
      }
    }
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`)
  }
  return codes
}

/** How recovery codes are compared: lower case, no spaces or dashes. */
export const normaliseRecoveryCode = (code: string) => code.toLowerCase().replace(/[\s-]/g, '')
