import { afterEach, describe, expect, it } from 'vitest'
import type { Mailer, Message } from '../src/mail.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

interface Party {
  id: string
  version: number
  name: string
  email: string
  role: string
  letterAt: number | null
}

/** A mailer that keeps what it is given; `fail` makes it refuse. */
function fakeMailer(fail = false): Mailer & { sent: Message[] } {
  const sent: Message[] = []
  return { configured: true, from: 'hub@example.com', sent, send: async (m) => (fail ? Promise.reject(new Error('535 not accepted')) : void sent.push(m)) }
}

describe('in case of emergency: trusted parties and letters', () => {
  it('keeps the trusted parties sealed, for parents only, with a request link per letter kept as a hash', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const add = await client.post<{ party: Party }>('/api/emergency/parties', { party: { name: 'Aunt Mary', email: 'Mary@Example.org', role: 'guardian', relationship: 'Sister', phone: '082 555 0100' } })
    expect(add.status).toBe(200)
    expect(add.body.party).toMatchObject({ email: 'mary@example.org', role: 'guardian', letterAt: null })
    await client.post('/api/emergency/parties', { party: { name: 'Pastor John', email: 'john@example.net', role: 'inform' } })
    for (const bad of [{ name: 'x', email: 'not-an-email', role: 'guardian' }, { name: 'x', email: 'a@example.com', role: 'boss' }, { email: 'a@example.com', role: 'guardian' }]) {
      expect((await client.post('/api/emergency/parties', { party: bad })).status).toBe(400)
    }

    const listing = await client.get<{ family: string; mail: { configured: boolean }; parties: Party[] }>('/api/emergency')
    expect(listing.body.mail.configured).toBe(false)
    expect(listing.body.parties.map((p) => p.name)).toEqual(['Aunt Mary', 'Pastor John'])

    // A letter: a new request link each time, shown once and kept only as a hash.
    const id = add.body.party.id
    const first = await client.post<{ secret: string; letterAt: number }>(`/api/emergency/parties/${id}/letter`, {})
    expect(first.body.secret.length).toBeGreaterThan(30)
    const second = await client.post<{ secret: string }>(`/api/emergency/parties/${id}/letter`, {})
    expect(second.body.secret).not.toBe(first.body.secret)
    const stored = JSON.stringify(server.services.db.prepare('SELECT * FROM trusted_parties').all())
    for (const w of ['Mary', 'example.org', 'Sister', '082', 'Pastor', first.body.secret, second.body.secret]) expect(stored).not.toContain(w)
    expect((await client.get<{ parties: Party[] }>('/api/emergency')).body.parties[0]!.letterAt).toBe(first.body.letterAt)

    // Editing checks the version; deleting works.
    expect((await client.call('PUT', `/api/emergency/parties/${id}`, { baseVersion: 3, party: { name: 'Mary', email: 'mary@example.org', role: 'guardian' } })).status).toBe(409)
    expect((await client.call('PUT', `/api/emergency/parties/${id}`, { baseVersion: 1, party: { name: 'Mary Smith', email: 'mary@example.org', role: 'guardian' } })).status).toBe(200)
    expect((await client.del(`/api/emergency/parties/${id}`)).status).toBe(204)

    // Members cannot see or change any of it.
    const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    for (const r of [kid.get('/api/emergency'), kid.post('/api/emergency/parties', { party: {} }), kid.post('/api/emergency/test-email', { to: 'a@example.com' })]) expect((await r).status).toBe(403)
  })

  it('sends a test email when email is set up, and says so plainly when it is not or fails', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    expect((await client.post('/api/emergency/test-email', { to: 'us@example.com' })).status).toBe(400)
    await server.close()

    const mailer = fakeMailer()
    server = await startServer({}, { mailer })
    const parent = (await setUpAdmin(server)).client
    expect((await parent.get<{ mail: { configured: boolean; from: string } }>('/api/emergency')).body.mail).toEqual({ configured: true, from: 'hub@example.com' })
    expect((await parent.post('/api/emergency/test-email', { to: 'nope' })).status).toBe(400)
    expect((await parent.post('/api/emergency/test-email', { to: 'Us@Example.com' })).status).toBe(200)
    expect(mailer.sent).toHaveLength(1)
    expect(mailer.sent[0]!.to).toEqual(['us@example.com'])
    expect(mailer.sent[0]!.text).toContain('the hub can send email')
    await server.close()

    server = await startServer({}, { mailer: fakeMailer(true) })
    const third = (await setUpAdmin(server)).client
    const failed = await third.post<{ message: string }>('/api/emergency/test-email', { to: 'us@example.com' })
    expect(failed.status).toBe(502)
    expect(failed.body.message).toContain('535 not accepted')
  })
})
