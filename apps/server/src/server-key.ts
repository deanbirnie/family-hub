/**
 * The server key: encrypts data at rest that the server itself must read
 * (tier S in docs/DATA-PROTECTION.md): authenticator secrets and document
 * contents, and later contacts and push addresses.
 *
 * It is a 32-byte random key in a file kept outside the data volume, so a
 * copy of the database or a backup of /data alone reveals nothing. Each use
 * gets its own subkey (HKDF-SHA-256 with a purpose label), and every value is
 * bound to what it belongs to (associated data), so ciphertext cannot be
 * moved between users, files or fields.
 *
 * The database records a check value for the key. If encrypted data exists
 * and the key file is missing or different, the server refuses to start
 * rather than make a new key and lose access to everything.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve, isAbsolute } from 'node:path'
import type { Db } from './db.ts'

const KEY_BYTES = 32
const CHECK_SETTING = 'server_key_check'
/** Small sealed values start with this; base32 TOTP secrets never contain a dot. */
const SEALED_PREFIX = 's1.'

export class ServerKeyError extends Error {}

export interface ServerKey {
  /** Encrypts a small value (a TOTP secret, a contact) for one purpose and owner. */
  seal(plain: string, purpose: string, aad: string): string
  /** Decrypts a value from seal(); throws if it was altered or belongs elsewhere. */
  open(sealed: string, purpose: string, aad: string): string
  /** The key for one document's contents. */
  fileKey(fileId: string, salt: Buffer): Buffer
}

export const isSealed = (value: string) => value.startsWith(SEALED_PREFIX)

const checkValue = (key: Buffer) => createHmac('sha256', key).update('family-hub server key check v1').digest('base64url')

function subkey(master: Buffer, info: string, salt: Buffer = Buffer.alloc(0)): Buffer {
  return Buffer.from(hkdfSync('sha256', master, salt, `family-hub/${info}`, KEY_BYTES))
}

export function serverKeyFrom(master: Buffer): ServerKey {
  if (master.length !== KEY_BYTES) throw new ServerKeyError('The server key must be 32 bytes.')
  return {
    seal(plain, purpose, aad) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', subkey(master, `seal/${purpose}`), iv)
      cipher.setAAD(Buffer.from(aad))
      const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
      return SEALED_PREFIX + Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')
    },
    open(sealed, purpose, aad) {
      if (!isSealed(sealed)) throw new ServerKeyError('Not a sealed value.')
      const raw = Buffer.from(sealed.slice(SEALED_PREFIX.length), 'base64url')
      if (raw.length < 28) throw new ServerKeyError('Sealed value is damaged.')
      const decipher = createDecipheriv('aes-256-gcm', subkey(master, `seal/${purpose}`), raw.subarray(0, 12))
      decipher.setAAD(Buffer.from(aad))
      decipher.setAuthTag(raw.subarray(raw.length - 16))
      return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8')
    },
    fileKey(fileId, salt) {
      return subkey(master, `file/${fileId}`, salt)
    },
  }
}

/**
 * Loads the key file, creating it on first start. Refuses to continue when the
 * database was set up with a different key, or with a key that is now missing.
 */
export function loadServerKey(path: string, db: Db, dataDir: string): ServerKey {
  const stored = (db.prepare('SELECT value FROM settings WHERE key = ?').get(CHECK_SETTING) as { value: string } | undefined)?.value
  let master: Buffer
  if (existsSync(path)) {
    master = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
    if (master.length !== KEY_BYTES) throw new ServerKeyError(`The server key file ${path} is not a valid key (expected 32 bytes, base64).`)
    if (stored) {
      const a = Buffer.from(checkValue(master))
      const b = Buffer.from(stored)
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        throw new ServerKeyError(
          `The server key file ${path} does not match this database. Restore the key that belongs with this data (from your password manager); do not replace it, or encrypted documents and sign-in codes cannot be read.`,
        )
      }
    }
  } else {
    if (stored) {
      throw new ServerKeyError(
        `The server key file ${path} is missing, but this database has data encrypted with it. Restore the key file from your password manager (see docs/BACKUPS.md) and start again.`,
      )
    }
    master = randomBytes(KEY_BYTES)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, `${master.toString('base64')}\n`, { mode: 0o600, flag: 'wx' })
    console.warn(
      `Created a new server key at ${path}. Copy it to your password manager now: without it, a backup of the data cannot be restored. (See docs/BACKUPS.md.)`,
    )
  }
  if (!stored) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(CHECK_SETTING, checkValue(master))
  if (isInside(resolve(path), resolve(dataDir))) {
    console.warn(
      `The server key ${path} is inside the data folder ${dataDir}. A backup of the data then contains the key that unlocks it. Keep it on a separate mount (FAMILY_HUB_KEY_FILE).`,
    )
  }
  return serverKeyFrom(master)
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}
