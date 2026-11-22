import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { expect, it } from 'vitest'
import { createApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { loadServerKey } from '../src/server-key.ts'
import { setUpAdmin, type TestServer } from './helpers.ts'

/** The server key lives outside the data folder, so it is not part of the copied backup. */
async function persistent(dataDir: string, keyFile: string): Promise<TestServer> {
  const db = openDb(join(dataDir, 'family-hub.db'))
  const clock = { now: Date.UTC(2026, 10, 20) }
  const config = { ...loadConfig(), dataDir, keyFile }
  const { server, services } = createApp({ db, config, serverKey: loadServerKey(keyFile, db, dataDir), now: () => clock.now, argon2: { memory: 1024, passes: 1, parallelism: 1 } })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, services, clock,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { db.close(); resolve() }) }) }
}

it('a stopped-data backup restores accounts, folders, active files and recoverable files together', async () => {
  const root = mkdtempSync(join(tmpdir(), 'family-hub-backup-test-'))
  const source = join(root, 'source'), restored = join(root, 'restored')
  mkdirSync(source)
  const keyFile = join(root, 'keys', 'server.key')
  let running: TestServer | null = await persistent(source, keyFile)
  try {
    const { client } = await setUpAdmin(running)
    const folder = await client.post<{ item: { id: string } }>('/api/files/folders', { name: 'Policies' })
    const upload = async (name: string, contents: string) => {
      const res = await fetch(`${running!.url}/api/files/upload?${new URLSearchParams({ name, parent: folder.body.item.id })}`, { method: 'POST', headers: { cookie: client.cookie, 'x-requested-with': 'family-hub' }, body: contents })
      expect(res.status).toBe(200)
      return ((await res.json()) as { item: { id: string } }).item.id
    }
    const active = await upload('active.txt', 'Keep this'), deleted = await upload('deleted.txt', 'Recover this')
    await client.del(`/api/files/${deleted}`)
    await running.close(); running = null
    cpSync(source, restored, { recursive: true })
    running = await persistent(restored, keyFile)
    client.base = running.url
    expect(Object.values(running.services.db.prepare('PRAGMA integrity_check').get()!)).toEqual(['ok'])
    expect((await client.get('/api/auth/session')).status).toBe(200)
    expect((await client.get<{ items: { id: string }[] }>(`/api/files?parent=${folder.body.item.id}`)).body.items[0]?.id).toBe(active)
    expect((await client.post(`/api/files/${deleted}/restore`)).status).toBe(200)
    for (const [id, text] of [[active, 'Keep this'], [deleted, 'Recover this']]) {
      const res = await fetch(`${running.url}/api/files/${id}/content`, { headers: { cookie: client.cookie } })
      expect(await res.text()).toBe(text)
    }
  } finally { await running?.close(); rmSync(root, { recursive: true, force: true }) }
})
