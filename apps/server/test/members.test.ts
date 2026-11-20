import { afterEach, describe, expect, it } from 'vitest'
import { totpAt } from '../src/totp.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, signIn, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

async function addMember(admin: Client, username: string, role: 'admin' | 'member' = 'member') {
  const invite = await admin.post<{ token: string }>('/api/invites', { displayName: username, role })
  const client = new Client(server.url)
  await client.post(`/api/invites/redeem/${invite.body.token}`, { username, displayName: username, password: PASSWORD })
  nextStep(server)
  const { secret } = await enrollTotp(server, client)
  const members = await admin.get<{ members: { id: string; username: string }[] }>('/api/members')
  const id = members.body.members.find((m) => m.username === username)!.id
  return { client, secret, id }
}

describe('invites', () => {
  it('works once and only within its time', async () => {
    server = await startServer()
    const { client: admin } = await setUpAdmin(server)
    const invite = await admin.post<{ token: string }>('/api/invites', { displayName: 'Gran' })
    expect((await new Client(server.url).get(`/api/invites/redeem/${invite.body.token}`)).body).toMatchObject({ displayName: 'Gran', familyName: 'The Tests' })

    const gran = new Client(server.url)
    expect((await gran.post(`/api/invites/redeem/${invite.body.token}`, { username: 'parent', displayName: 'Gran', password: PASSWORD })).status).toBe(409)
    expect((await gran.post(`/api/invites/redeem/${invite.body.token}`, { username: 'gran', displayName: 'Gran', password: PASSWORD })).status).toBe(200)
    expect((await new Client(server.url).post(`/api/invites/redeem/${invite.body.token}`, { username: 'gran2', displayName: 'Gran', password: PASSWORD })).status).toBe(404)

    const late = await admin.post<{ token: string }>('/api/invites', { displayName: 'Late' })
    server.clock.now += 8 * 24 * 60 * 60_000
    expect((await new Client(server.url).get(`/api/invites/redeem/${late.body.token}`)).status).toBe(404)
  })

  it('only admins create and see invites', async () => {
    server = await startServer()
    const { client: admin } = await setUpAdmin(server)
    const { client: kid } = await addMember(admin, 'kid')
    expect((await kid.post('/api/invites', { displayName: 'X' })).status).toBe(403)
    expect((await kid.get('/api/invites')).status).toBe(403)
    expect((await kid.get('/api/members')).status).toBe(200)
    const pending = await admin.post<{ id: string }>('/api/invites', { displayName: 'Y' })
    expect((await admin.get<{ invites: unknown[] }>('/api/invites')).body.invites).toHaveLength(1)
    expect((await admin.del(`/api/invites/${pending.body.id}`)).status).toBe(204)
    expect((await admin.get<{ invites: unknown[] }>('/api/invites')).body.invites).toHaveLength(0)
  })
})

describe('managing members', () => {
  it('keeps at least one admin', async () => {
    server = await startServer()
    const { client: admin } = await setUpAdmin(server)
    const self = (await admin.get<{ members: { id: string }[] }>('/api/members')).body.members[0]!.id
    expect((await admin.patch(`/api/members/${self}`, { role: 'member' })).body).toMatchObject({ error: 'last_admin' })
    const { id: other } = await addMember(admin, 'other', 'admin')
    expect((await admin.patch(`/api/members/${self}`, { role: 'member' })).status).toBe(204)
    expect((await admin.get('/api/invites')).status).toBe(403)
    void other
  })

  it('turning an account off signs it out and stops sign-in', async () => {
    server = await startServer()
    const { client: admin } = await setUpAdmin(server)
    const { client: kid, id, secret } = await addMember(admin, 'kid')
    expect((await admin.patch(`/api/members/${id}`, { disabled: true })).status).toBe(204)
    expect((await kid.get('/api/members')).status).toBe(401)
    const again = new Client(server.url)
    expect((await again.post('/api/auth/login', { username: 'kid', password: PASSWORD })).status).toBe(401)
    expect((await admin.patch(`/api/members/${id}`, { disabled: false })).status).toBe(204)
    await signIn(server, 'kid', secret)
  })

  it('an admin can reset a member’s two-factor sign-in after a lost phone', async () => {
    server = await startServer()
    const { client: admin } = await setUpAdmin(server)
    const { client: kid, id } = await addMember(admin, 'kid')
    expect((await admin.post(`/api/members/${id}/reset-two-factor`)).status).toBe(204)
    expect((await kid.get('/api/members')).status).toBe(401)
    const fresh = new Client(server.url)
    expect((await fresh.post('/api/auth/login', { username: 'kid', password: PASSWORD })).body).toMatchObject({ stage: 'enroll' })
    const self = (await admin.get<{ members: { id: string; self: boolean }[] }>('/api/members')).body.members.find((m) => m.self)!.id
    expect((await admin.post(`/api/members/${self}/reset-two-factor`)).status).toBe(409)
  })
})

describe('own account', () => {
  it('changing the password signs out other sessions and needs the current one', async () => {
    server = await startServer()
    const { client, secret } = await setUpAdmin(server)
    const other = await signIn(server, 'parent', secret)
    expect((await client.post('/api/account/password', { currentPassword: 'not it at all', newPassword: 'a brand new passphrase' })).status).toBe(400)
    expect((await client.post('/api/account/password', { currentPassword: PASSWORD, newPassword: 'a brand new passphrase' })).status).toBe(204)
    expect((await client.get('/api/account')).status).toBe(200)
    expect((await other.get('/api/account')).status).toBe(401)
    expect((await new Client(server.url).post('/api/auth/login', { username: 'parent', password: 'a brand new passphrase' })).status).toBe(200)
  })

  it('lists and ends sessions, and replaces recovery codes with a fresh code', async () => {
    server = await startServer()
    const { client, secret } = await setUpAdmin(server)
    const other = await signIn(server, 'parent', secret)
    const list = await client.get<{ sessions: { id: string; current: boolean }[] }>('/api/account/sessions')
    expect(list.body.sessions).toHaveLength(2)
    const otherId = list.body.sessions.find((s) => !s.current)!.id
    expect((await client.del(`/api/account/sessions/${otherId}`)).status).toBe(204)
    expect((await other.get('/api/account')).status).toBe(401)

    nextStep(server)
    const codes = await client.post<{ recoveryCodes: string[] }>('/api/account/recovery-codes', { code: totpAt(secret, server.clock.now) })
    expect(codes.body.recoveryCodes).toHaveLength(10)
    expect((await client.get('/api/account')).body).toMatchObject({ recoveryCodesLeft: 10 })
    const events = await client.get<{ events: { event: string }[] }>('/api/account/activity')
    expect(events.body.events.map((e) => e.event)).toContain('recovery_codes.replaced')
  })
})
