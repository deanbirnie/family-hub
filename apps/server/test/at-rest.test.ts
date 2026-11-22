import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { encryptStoredData } from '../src/at-rest.ts'
import { openDb } from '../src/db.ts'
import { CHUNK_BYTES, decryptFile, encryptedSize, FileEncryptor } from '../src/file-crypto.ts'
import { loadServerKey, serverKeyFrom, ServerKeyError } from '../src/server-key.ts'
import { totpAt } from '../src/totp.ts'
import { Client, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer | undefined
const dirs: string[] = []
afterEach(async () => {
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'family-hub-at-rest-'))
  dirs.push(d)
  return d
}

const key = serverKeyFrom(randomBytes(32))

async function encryptTo(path: string, id: string, data: Buffer, pieces = 7): Promise<void> {
  const out = await open(path, 'w')
  const enc = new FileEncryptor(key, id, out)
  // Arrives in uneven pieces, as a network upload does.
  for (let i = 0; i < data.length; i += Math.ceil(data.length / pieces) || 1) await enc.write(data.subarray(i, i + Math.ceil(data.length / pieces)))
  await enc.finish()
  await out.close()
}

async function decrypt(path: string, id: string, k = key): Promise<Buffer> {
  const handle = await open(path, 'r')
  try {
    const parts: Buffer[] = []
    for await (const part of decryptFile(k, id, handle, statSync(path).size)) parts.push(part)
    return Buffer.concat(parts)
  } finally {
    await handle.close()
  }
}

describe('document encryption format', () => {
  it('round-trips every size around the chunk boundaries', async () => {
    const dir = tempDir()
    for (const size of [0, 1, 17, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 3 * CHUNK_BYTES, 3 * CHUNK_BYTES + 5]) {
      const data = randomBytes(size)
      const path = join(dir, `f${size}`)
      await encryptTo(path, 'doc-1', data)
      expect(statSync(path).size).toBe(encryptedSize(size))
      expect((await decrypt(path, 'doc-1')).equals(data)).toBe(true)
    }
  })

  it('detects altered, truncated, reordered and misplaced contents', async () => {
    const dir = tempDir()
    const data = randomBytes(3 * CHUNK_BYTES + 100)
    const path = join(dir, 'doc')
    await encryptTo(path, 'doc-1', data)
    const good = readFileSync(path)
    const record = CHUNK_BYTES + 16
    const variants: Record<string, Buffer> = {
      'one flipped byte': Buffer.from(good).fill(good[5000]! ^ 1, 5000, 5001),
      'cut at a chunk boundary': good.subarray(0, 20 + 2 * record),
      'last chunk dropped': good.subarray(0, good.length - 116),
      'two chunks swapped': Buffer.concat([good.subarray(0, 20), good.subarray(20 + record, 20 + 2 * record), good.subarray(20, 20 + record), good.subarray(20 + 2 * record)]),
    }
    for (const [what, bytes] of Object.entries(variants)) {
      writeFileSync(path, bytes)
      await expect(decrypt(path, 'doc-1'), what).rejects.toThrow()
    }
    writeFileSync(path, good)
    await expect(decrypt(path, 'doc-2'), 'another document’s ID').rejects.toThrow()
    await expect(decrypt(path, 'doc-1', serverKeyFrom(randomBytes(32))), 'another server key').rejects.toThrow()
    expect((await decrypt(path, 'doc-1')).equals(data)).toBe(true)
  })
})

describe('the server key file', () => {
  it('is created once, private, and must match the database afterwards', () => {
    const keyDir = tempDir()
    const data = tempDir()
    const path = join(keyDir, 'keys', 'server.key')
    const db = openDb(':memory:')
    const first = loadServerKey(path, db, data)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const sealed = first.seal('secret', 'test', 'a')
    expect(loadServerKey(path, db, data).open(sealed, 'test', 'a')).toBe('secret')

    // Never quietly replaced: a missing or different key stops the server.
    const saved = readFileSync(path)
    rmSync(path)
    expect(() => loadServerKey(path, db, data)).toThrow(ServerKeyError)
    expect(existsSync(path)).toBe(false)
    writeFileSync(path, `${randomBytes(32).toString('base64')}\n`)
    expect(() => loadServerKey(path, db, data)).toThrow(/does not match/)
    writeFileSync(path, saved)
    expect(loadServerKey(path, db, data).open(sealed, 'test', 'a')).toBe('secret')
  })

  it('binds sealed values to their purpose and owner', () => {
    const sealed = key.seal('JBSWY3DPEHPK3PXP', 'totp', 'user-a')
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP')
    expect(key.open(sealed, 'totp', 'user-a')).toBe('JBSWY3DPEHPK3PXP')
    expect(() => key.open(sealed, 'totp', 'user-b')).toThrow()
    expect(() => key.open(sealed, 'contacts', 'user-a')).toThrow()
  })
})

describe('encrypted at rest through the API', () => {
  it('stores authenticator secrets sealed, and sign-in still works', async () => {
    server = await startServer()
    const { secret } = await setUpAdmin(server)
    const row = server.services.db.prepare('SELECT id, totp_secret FROM users').get() as { id: string; totp_secret: string }
    expect(row.totp_secret.startsWith('s1.')).toBe(true)
    expect(row.totp_secret).not.toContain(secret)
    const client = new Client(server.url)
    await client.post('/api/auth/login', { username: 'parent', password: PASSWORD })
    nextStep(server)
    expect((await client.post('/api/auth/totp', { code: totpAt(secret, server.clock.now) })).status).toBe(200)
  })

  it('streams a multi-chunk upload back intact, and still previews by content', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const big = randomBytes(5 * CHUNK_BYTES + 123)
    const upload = async (name: string, body: Buffer) => {
      const res = await fetch(`${server!.url}/api/files/upload?${new URLSearchParams({ name })}`, { method: 'POST', headers: { cookie: client.cookie, 'x-requested-with': 'family-hub' }, body })
      expect(res.status).toBe(200)
      return ((await res.json()) as { item: { id: string } }).item.id
    }
    const id = await upload('big.bin', big)
    const res = await fetch(`${server.url}/api/files/${id}/content`, { headers: { cookie: client.cookie } })
    expect(Number(res.headers.get('content-length'))).toBe(big.length)
    expect(Buffer.from(await res.arrayBuffer()).equals(big)).toBe(true)

    const pdf = await upload('form.pdf', Buffer.from('%PDF-1.7\n% a tiny pdf\n'))
    const preview = await fetch(`${server.url}/api/files/${pdf}/content?preview=1`, { headers: { cookie: client.cookie } })
    expect(preview.headers.get('content-type')).toBe('application/pdf')
  })

  it('reports a damaged document instead of sending garbage', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const res = await fetch(`${server.url}/api/files/upload?name=doc.txt`, { method: 'POST', headers: { cookie: client.cookie, 'x-requested-with': 'family-hub' }, body: 'family paperwork' })
    const { item } = (await res.json()) as { item: { id: string } }
    const path = join(server.services.config.dataDir, 'files', item.id)
    const bytes = readFileSync(path)
    bytes[bytes.length - 1]! ^= 1
    writeFileSync(path, bytes)
    expect((await client.get(`/api/files/${item.id}/content`)).body).toMatchObject({ error: 'damaged_content' })
  })
})

describe('encrypting data stored before encryption', () => {
  it('encrypts old documents and secrets in place, resumably, without double-encrypting', async () => {
    server = await startServer()
    const { client, secret } = await setUpAdmin(server)
    const { db, config } = server.services
    const userId = (db.prepare('SELECT id FROM users').get() as { id: string }).id
    // As an older server left them: a plain secret and plain documents.
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, userId)
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
    const contents = [Buffer.from('an old plain document'), randomBytes(2 * CHUNK_BYTES + 9)]
    ids.forEach((id, i) => {
      writeFileSync(join(config.dataDir, 'files', id), contents[i]!)
      db.prepare("INSERT INTO files (id, name, kind, size, created_by, created_at, updated_at) VALUES (?, ?, 'file', ?, ?, 0, 0)").run(id, `old${i}`, contents[i]!.length, userId)
    })
    // Plain documents still download during the migration window.
    const during = await fetch(`${server.url}/api/files/${ids[0]}/content`, { headers: { cookie: client.cookie } })
    expect(await during.text()).toBe('an old plain document')

    expect(await encryptStoredData(server.services)).toEqual({ secrets: 1, files: 2 })
    // Interrupted after swapping the file in but before recording it: not encrypted twice.
    db.prepare('UPDATE files SET encrypted = 0 WHERE id = ?').run(ids[1]!)
    expect(await encryptStoredData(server.services)).toEqual({ secrets: 0, files: 1 })

    for (const [i, id] of ids.entries()) {
      const onDisk = readFileSync(join(config.dataDir, 'files', id))
      expect(onDisk.subarray(0, 4).toString()).toBe('FHF1')
      const res = await fetch(`${server.url}/api/files/${id}/content`, { headers: { cookie: client.cookie } })
      expect(Buffer.from(await res.arrayBuffer()).equals(contents[i]!)).toBe(true)
    }
    const row = db.prepare('SELECT totp_secret FROM users').get() as { totp_secret: string }
    expect(row.totp_secret.startsWith('s1.')).toBe(true)
    const again = new Client(server.url)
    await again.post('/api/auth/login', { username: 'parent', password: PASSWORD })
    nextStep(server)
    expect((await again.post('/api/auth/totp', { code: totpAt(secret, server.clock.now) })).status).toBe(200)
  })
})
