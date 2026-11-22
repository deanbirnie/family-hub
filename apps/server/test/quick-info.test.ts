import { afterEach, describe, expect, it } from 'vitest'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

// The server only ever sees ciphertext (encrypted on the device); any base64url will do here.
const ct = (tag: string) => Buffer.from(`ciphertext-${tag}`).toString('base64url')

interface Rec { id: string; profileId: string | null; kind: string; ciphertext: string; version: number }

describe('Quick Info', () => {
  it('keeps people and their encrypted records', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const self = (await client.get<{ user: { id: string } }>('/api/auth/session')).body.user
    const me = await client.post<{ profile: { id: string; userId: string } }>('/api/quick-info/profiles', { displayName: 'Parent', userId: self.id })
    expect(me.body.profile.userId).toBe(self.id)
    const kid = await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam (no account)' })

    const personal = await client.post<{ record: Rec }>('/api/quick-info/records', { profileId: kid.body.profile.id, kind: 'personal', ciphertext: ct('id') })
    expect(personal.body.record).toMatchObject({ kind: 'personal', version: 1, ciphertext: ct('id') })
    await client.post('/api/quick-info/records', { profileId: kid.body.profile.id, kind: 'vehicle', ciphertext: ct('car1') })
    await client.post('/api/quick-info/records', { profileId: kid.body.profile.id, kind: 'vehicle', ciphertext: ct('car2') })
    await client.post('/api/quick-info/records', { kind: 'household', ciphertext: ct('address') })

    const all = await client.get<{ profiles: unknown[]; records: Rec[] }>('/api/quick-info')
    expect(all.body.profiles).toHaveLength(2)
    expect(all.body.records.map((r) => r.kind).sort()).toEqual(['household', 'personal', 'vehicle', 'vehicle'])
    expect(all.body.records.find((r) => r.kind === 'household')!.profileId).toBeNull()

    // Removing a person removes their records.
    expect((await client.del(`/api/quick-info/profiles/${kid.body.profile.id}`)).status).toBe(204)
    expect((await client.get<{ records: Rec[] }>('/api/quick-info')).body.records.map((r) => r.kind)).toEqual(['household'])
  })

  it('refuses plain text, unknown kinds and a second single record', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const p = (await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })).body.profile.id
    expect((await client.post('/api/quick-info/records', { profileId: p, kind: 'personal', ciphertext: 'ID 8001015009087' })).status).toBe(400)
    expect((await client.post('/api/quick-info/records', { profileId: p, kind: 'bank', ciphertext: ct('x') })).status).toBe(400)
    expect((await client.post('/api/quick-info/records', { profileId: p, kind: 'passport', ciphertext: ct('p') })).status).toBe(200)
    expect((await client.post('/api/quick-info/records', { profileId: p, kind: 'passport', ciphertext: ct('p2') })).body).toMatchObject({ error: 'record_exists' })
    expect((await client.post('/api/quick-info/records', { kind: 'household', ciphertext: ct('a') })).status).toBe(200)
    expect((await client.post('/api/quick-info/records', { kind: 'household', ciphertext: ct('b') })).body).toMatchObject({ error: 'record_exists' })
    expect((await client.post('/api/quick-info/records', { profileId: 'nobody', kind: 'vehicle', ciphertext: ct('v') })).status).toBe(404)
  })

  it('does not let two parents overwrite each other', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const p = (await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })).body.profile.id
    const r = (await client.post<{ record: Rec }>('/api/quick-info/records', { profileId: p, kind: 'medical', ciphertext: ct('v1') })).body.record
    const first = await client.call<{ record: Rec }>('PUT', `/api/quick-info/records/${r.id}`, { ciphertext: ct('v2'), baseVersion: 1 })
    expect(first.body.record).toMatchObject({ version: 2, ciphertext: ct('v2') })
    const stale = await client.call('PUT', `/api/quick-info/records/${r.id}`, { ciphertext: ct('other'), baseVersion: 1 })
    expect(stale.body).toMatchObject({ error: 'edit_conflict' })
    expect((await client.get<{ records: Rec[] }>('/api/quick-info')).body.records[0]!.ciphertext).toBe(ct('v2'))
  })

  it('links a family member to one profile only', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const self = (await client.get<{ user: { id: string } }>('/api/auth/session')).body.user
    await client.post('/api/quick-info/profiles', { displayName: 'Me', userId: self.id })
    expect((await client.post('/api/quick-info/profiles', { displayName: 'Me again', userId: self.id })).body).toMatchObject({ error: 'profile_exists' })
  })

  it('is for parents only', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    expect((await kid.get('/api/quick-info')).status).toBe(403)
    expect((await kid.post('/api/quick-info/profiles', { displayName: 'X' })).status).toBe(403)
    expect((await kid.post('/api/quick-info/records', { kind: 'household', ciphertext: ct('a') })).status).toBe(403)
  })
})
