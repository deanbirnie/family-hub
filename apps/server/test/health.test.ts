import { afterEach, describe, expect, it } from 'vitest'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

// The server only ever sees ciphertext (encrypted on the device); any base64url will do here.
const ct = (tag: string) => Buffer.from(`ciphertext-${tag}`).toString('base64url')

async function family() {
  server = await startServer()
  const { client } = await setUpAdmin(server)
  const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
  const kid = new Client(server.url)
  await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
  nextStep(server)
  await enrollTotp(server, kid)
  const sam = (await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })).body.profile.id
  return { client, kid, sam }
}

function upload(client: Client, name: string, parent: string) {
  return fetch(`${server.url}/api/files/upload?${new URLSearchParams({ name, parent })}`, {
    method: 'POST',
    headers: { 'x-requested-with': 'family-hub', cookie: client.cookie },
    body: 'x-ray report',
  })
}

describe('health records', () => {
  it('keeps ciphertext only, per person, with versions; parents only', async () => {
    const { client, kid, sam } = await family()
    const added = await client.post<{ record: { id: string; version: number } }>('/api/health/records', { profileId: sam, ciphertext: ct('allergy') })
    expect(added.status).toBe(200)
    expect((await client.post('/api/health/records', { profileId: sam, ciphertext: 'not encrypted!' })).status).toBe(400)
    expect((await client.post('/api/health/records', { profileId: 'nobody', ciphertext: ct('x') })).status).toBe(404)
    const list = await client.get<{ profiles: { displayName: string }[]; records: { profileId: string; ciphertext: string }[] }>('/api/health/records')
    expect(list.body.records).toEqual([expect.objectContaining({ profileId: sam, ciphertext: ct('allergy') })])
    // The table holds nothing but whose, when, and the ciphertext: no kind of record.
    expect(Object.keys(server.services.db.prepare('SELECT * FROM health_records').get() as object).sort()).toEqual(
      ['ciphertext', 'created_at', 'id', 'profile_id', 'updated_at', 'updated_by', 'version'].sort(),
    )

    const id = added.body.record.id
    expect((await client.call('PUT', `/api/health/records/${id}`, { ciphertext: ct('allergy2'), baseVersion: 1 })).status).toBe(200)
    expect((await client.call('PUT', `/api/health/records/${id}`, { ciphertext: ct('allergy3'), baseVersion: 1 })).status).toBe(409)
    expect((await client.del(`/api/health/records/${id}`)).status).toBe(204)

    // Removing the person removes their health records.
    await client.post('/api/health/records', { profileId: sam, ciphertext: ct('med') })
    await client.del(`/api/quick-info/profiles/${sam}`)
    expect((await client.get<{ records: unknown[] }>('/api/health/records')).body.records).toEqual([])

    for (const r of [kid.get('/api/health/records'), kid.post('/api/health/records', { profileId: sam, ciphertext: ct('x') }), kid.get('/api/health/folder')]) expect((await r).status).toBe(403)
  })
})

describe('the parents-only Health folder', () => {
  it('is hidden from members everywhere, and stays put', async () => {
    const { client, kid } = await family()
    const folder = (await client.get<{ folderId: string }>('/api/health/folder')).body.folderId
    expect((await client.get<{ folderId: string }>('/api/health/folder')).body.folderId).toBe(folder)
    const up = await upload(client, 'xray.txt', folder)
    expect(up.status).toBe(200)
    const file = ((await up.json()) as { item: { id: string } }).item.id
    const sub = (await client.post<{ item: { id: string } }>('/api/files/folders', { name: 'Sam', parentId: folder })).body.item.id

    // Parents see it, marked as parents-only.
    const root = await client.get<{ items: { name: string; parentsOnly: boolean }[] }>('/api/files')
    expect(root.body.items).toEqual([expect.objectContaining({ name: 'Health', parentsOnly: true })])

    // Members: not in the list, not in search, not openable, nothing can be put in or taken out.
    expect((await kid.get<{ items: unknown[] }>('/api/files')).body.items).toEqual([])
    expect((await kid.get<{ items: unknown[] }>('/api/files?q=xray')).body.items).toEqual([])
    expect((await kid.get(`/api/files?parent=${folder}`)).status).toBe(404)
    expect((await kid.get(`/api/files?parent=${sub}`)).status).toBe(404)
    expect((await fetch(`${server.url}/api/files/${file}/content`, { headers: { cookie: kid.cookie } })).status).toBe(404)
    expect((await upload(kid, 'sneaky.txt', folder)).status).toBe(404)
    expect((await kid.post('/api/files/folders', { name: 'x', parentId: folder })).status).toBe(404)
    expect((await kid.patch(`/api/files/${file}`, { parentId: null })).status).toBe(404)
    expect((await kid.del(`/api/files/${file}`)).status).toBe(404)
    // In the recycle bin too.
    await client.del(`/api/files/${file}`)
    expect((await kid.get<{ items: unknown[] }>('/api/files/trash')).body.items).toEqual([])
    expect((await kid.post(`/api/files/${file}/restore`)).status).toBe(404)
    expect((await client.get<{ items: unknown[] }>('/api/files/trash')).body.items).toHaveLength(1)

    // The folder itself cannot be renamed, moved or deleted.
    expect((await client.patch(`/api/files/${folder}`, { name: 'Medical' })).status).toBe(400)
    expect((await client.del(`/api/files/${folder}`)).status).toBe(400)
  })
})
