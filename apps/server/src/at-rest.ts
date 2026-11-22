/**
 * Data the server key protects (tier S in docs/DATA-PROTECTION.md): reading
 * and writing authenticator secrets, and encrypting data stored before
 * encryption existed.
 */
import { open, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Services } from './app.ts'
import { FileEncryptor, isEncryptedFile } from './file-crypto.ts'
import { isSealed, type ServerKey } from './server-key.ts'

/** Authenticator secrets are bound to their user, so they cannot be copied to another account. */
export const sealTotp = (key: ServerKey, userId: string, secret: string) => key.seal(secret, 'totp', userId)

/** The plain secret, or null. Accepts a not-yet-encrypted value, which only exists until startup's migration runs. */
export function openTotp(key: ServerKey, userId: string, stored: string | null): string | null {
  if (!stored) return null
  return isSealed(stored) ? key.open(stored, 'totp', userId) : stored
}

/**
 * Encrypts anything still stored plain: authenticator secrets, then document
 * contents (each written to a temporary file and swapped in, so an
 * interruption leaves either the old or the new file, never half of one).
 * Safe to run again; it continues where it stopped. Runs before the server
 * accepts requests.
 */
export async function encryptStoredData(s: Services): Promise<{ secrets: number; files: number }> {
  let secrets = 0
  const users = s.db.prepare('SELECT id, totp_secret, totp_pending_secret FROM users').all() as {
    id: string
    totp_secret: string | null
    totp_pending_secret: string | null
  }[]
  for (const u of users) {
    for (const column of ['totp_secret', 'totp_pending_secret'] as const) {
      const value = u[column]
      if (value && !isSealed(value)) {
        s.db.prepare(`UPDATE users SET ${column} = ? WHERE id = ? AND ${column} = ?`).run(sealTotp(s.serverKey, u.id, value), u.id, value)
        secrets++
      }
    }
  }

  let files = 0
  const root = join(s.config.dataDir, 'files')
  const pending = s.db.prepare("SELECT id FROM files WHERE kind = 'file' AND encrypted = 0").all() as { id: string }[]
  for (const { id } of pending) {
    const path = join(root, id)
    let size: number
    try {
      size = (await stat(path)).size
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue // missing contents are reported when opened
      throw e
    }
    const source = await open(path, 'r')
    try {
      // A previous run may have swapped the file in but stopped before recording it.
      if (!(await isEncryptedFile(s.serverKey, id, source, size))) {
        const temp = join(root, `${id}.enc`)
        const out = await open(temp, 'w', 0o600)
        try {
          const enc = new FileEncryptor(s.serverKey, id, out)
          const buffer = Buffer.alloc(1024 * 1024)
          for (let position = 0; ; ) {
            const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
            if (bytesRead === 0) break
            await enc.write(Buffer.from(buffer.subarray(0, bytesRead)))
            position += bytesRead
          }
          await enc.finish()
          await out.sync()
        } catch (e) {
          await out.close()
          await unlink(temp).catch(() => undefined)
          throw e
        }
        await out.close()
        await rename(temp, path)
      }
    } finally {
      await source.close()
    }
    s.db.prepare('UPDATE files SET encrypted = 1 WHERE id = ?').run(id)
    files++
  }
  if (secrets || files) console.log(`Encrypted ${secrets} sign-in secret(s) and ${files} document(s) with the server key.`)
  return { secrets, files }
}
