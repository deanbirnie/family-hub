/**
 * Small building blocks for everything secret: random tokens, hashing them
 * for storage, password hashing with Argon2id, and constant-time comparison.
 * Uses only Node's built-in crypto.
 */
import { argon2, createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** A random token for a URL or header: 32 bytes, base64url. */
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

/** A short random id for rows that are shown to people (sessions, devices). */
export const newId = () => randomBytes(12).toString('base64url')

/**
 * Tokens are stored only as their SHA-256, so a copy of the database cannot be
 * used to sign in. (They are long and random, so a fast hash is enough.)
 */
export const hashToken = (token: string) => createHash('sha256').update(token).digest('base64url')

export function equalStrings(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

// ---- passwords ---------------------------------------------------------------

export interface Argon2Params {
  /** KiB */
  memory: number
  passes: number
  parallelism: number
}

/** RFC 9106's second recommended option: 64 MiB, 3 passes, 4 lanes. */
export const DEFAULT_ARGON2: Argon2Params = { memory: 65536, passes: 3, parallelism: 4 }

/** Accepted when reading stored hashes, so a tampered row cannot ask for absurd work. */
const LIMITS = { memory: [1024, 1048576], passes: [1, 10], parallelism: [1, 16] } as const

function derive(password: string, salt: Buffer, p: Argon2Params): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    argon2(
      'argon2id',
      {
        message: password,
        nonce: salt,
        parallelism: p.parallelism,
        tagLength: 32,
        memory: p.memory,
        passes: p.passes,
      },
      (err, key) => (err ? reject(err) : resolve(key)),
    ),
  )
}

/** Hashes a password into a PHC string: $argon2id$v=19$m=…,t=…,p=…$salt$hash */
export async function hashPassword(password: string, params: Argon2Params = DEFAULT_ARGON2): Promise<string> {
  const salt = randomBytes(16)
  const key = await derive(password, salt, params)
  const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '')
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(key)}`
}

function parsePhc(phc: string): { params: Argon2Params; salt: Buffer; hash: Buffer } | null {
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(phc)
  if (!m) return null
  const params = { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]) }
  for (const k of ['memory', 'passes', 'parallelism'] as const) {
    if (params[k] < LIMITS[k][0] || params[k] > LIMITS[k][1]) return null
  }
  return { params, salt: Buffer.from(m[4]!, 'base64'), hash: Buffer.from(m[5]!, 'base64') }
}

export async function verifyPassword(password: string, phc: string): Promise<boolean> {
  const parsed = parsePhc(phc)
  if (!parsed) return false
  const key = await derive(password, parsed.salt, parsed.params)
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash)
}

/** True when a stored hash uses other settings than the current ones and should be redone. */
export function needsRehash(phc: string, params: Argon2Params = DEFAULT_ARGON2): boolean {
  const parsed = parsePhc(phc)
  if (!parsed) return true
  return (
    parsed.params.memory !== params.memory ||
    parsed.params.passes !== params.passes ||
    parsed.params.parallelism !== params.parallelism
  )
}

/**
 * What a new password must meet. Length matters most (NIST SP 800-63B):
 * at least 12 characters, no arbitrary composition rules.
 */
export function passwordProblem(password: unknown, username = ''): string | null {
  if (typeof password !== 'string' || password === '') return 'Enter a password.'
  if ([...password].length < 12) return 'Use at least 12 characters. A few random words work well.'
  if (password.length > 256) return 'Use at most 256 characters.'
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    return 'The password must not contain your username.'
  }
  if (/^(.)\1+$/s.test(password)) return 'That password is too easy to guess.'
  return null
}
