import { afterEach, describe, expect, it } from 'vitest'
import { runEmergency } from '../src/emergency-release.ts'
import type { Mailer, Message } from '../src/mail.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, signIn, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

const HOUR = 3_600_000
const DAY = 24 * HOUR

function fakeMailer(): Mailer & { sent: Message[] } {
  const sent: Message[] = []
  return { configured: true, from: 'hub@example.com', sent, send: async (m) => void sent.push(m) }
}

/** A family with a parent (with an email for warnings), a guardian, someone to inform, and a pack. */
async function family() {
  const mail = fakeMailer()
  server = await startServer({}, { mailer: mail })
  const { client: parent, secret: totp } = await setUpAdmin(server)
  await parent.call('PUT', '/api/emergency/my-email', { email: 'alex@example.com' })
  const mary = await parent.post<{ party: { id: string } }>('/api/emergency/parties', { party: { name: 'Aunt Mary', email: 'mary@example.org', role: 'guardian' } })
  await parent.post('/api/emergency/parties', { party: { name: 'Pastor John', email: 'john@example.net', role: 'inform' } })
  const letter = await parent.post<{ secret: string }>(`/api/emergency/parties/${mary.body.party.id}/letter`, {})
  const pdf = Buffer.from('%PDF-1.7\n1 0 obj\n<< /Filter /Standard /V 5 /R 6 >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 1 0 R >>\n%%EOF\n', 'latin1')
  await parent.call('PUT', '/api/emergency/pack', { pdf: pdf.toString('base64') })
  mail.sent.length = 0
  return { mail, parent, totp, secret: letter.body.secret, visitor: new Client(server.url) }
}

const to = (m: Message) => m.to.join(',')
const later = async (ms: number) => {
  server.clock.now += ms
  await runEmergency(server.services)
}

describe('releasing the pack on request', () => {
  it('tells the parents at once, checks again after the wait, then sends the pack to the guardians and tells those to inform', async () => {
    const { mail, visitor, secret } = await family()
    const look = await visitor.get<{ family: string; name: string; stage: string }>(`/api/emergency/link/${secret}`)
    expect(look.body).toMatchObject({ family: 'The Tests', name: 'Aunt Mary', stage: 'none' })
    expect((await visitor.get('/api/emergency/link/not-a-real-secret')).status).toBe(404)

    const req = await visitor.post<{ status: string; stage: string; sendAt: number }>(`/api/emergency/link/${secret}/request`, { note: 'There was an accident.' })
    expect(req.body).toMatchObject({ status: 'started', stage: 'requested' })
    expect(req.body.sendAt).toBe(server.clock.now + 3 * DAY + 24 * HOUR)
    expect(mail.sent.map(to)).toEqual(['alex@example.com'])
    expect(mail.sent[0]!.subject).toContain('Aunt Mary asked for the emergency pack')
    expect(mail.sent[0]!.text).toContain('There was an accident.')
    // Asking again changes nothing.
    expect((await visitor.post<{ status: string }>(`/api/emergency/link/${secret}/request`, {})).body.status).toBe('already')

    await later(2 * DAY)
    expect(mail.sent).toHaveLength(1)
    await later(DAY)
    expect(mail.sent[1]!.subject).toContain('will be sent unless you cancel')
    await later(23 * HOUR)
    expect(mail.sent).toHaveLength(2)
    await later(HOUR)
    const pack = mail.sent.find((m) => m.attachments?.length)!
    expect(pack.to).toEqual(['mary@example.org'])
    expect(pack.attachments![0]!.filename).toBe('emergency-pack.pdf')
    expect(pack.text).toContain('The password is in the letter they gave you.')
    expect(mail.sent.find((m) => to(m) === 'john@example.net')!.text).toContain('sent their emergency pack to the children’s guardians: Aunt Mary')
    expect(mail.sent.at(-1)!.subject).toBe('Family Hub: the emergency pack was sent')
    // Nothing more after that.
    const count = mail.sent.length
    await later(DAY)
    expect(mail.sent).toHaveLength(count)
  })

  it('stops when a parent says all is well, and tells whoever asked', async () => {
    const { mail, parent, visitor, secret } = await family()
    await visitor.post(`/api/emergency/link/${secret}/request`, {})
    const status = await parent.get<{ active: boolean; stage: string }>('/api/emergency/status')
    expect(status.body).toMatchObject({ active: true, stage: 'waiting' })
    const shown = await parent.get<{ release: { by: string; stage: string } }>('/api/emergency')
    expect(shown.body.release).toMatchObject({ by: 'Aunt Mary', stage: 'waiting' })
    expect((await parent.post('/api/emergency/release/cancel', {})).status).toBe(200)
    expect(mail.sent.at(-1)!.to).toEqual(['mary@example.org'])
    expect(mail.sent.at(-1)!.text).toContain('Parent has said all is well')
    expect((await parent.post('/api/emergency/release/cancel', {})).status).toBe(409)
    await later(5 * DAY)
    expect(mail.sent.some((m) => m.attachments?.length)).toBe(false)
    expect((await visitor.get<{ stage: string }>(`/api/emergency/link/${secret}`)).body.stage).toBe('none')
  })
})

describe('releasing the pack when nobody is there', () => {
  it('checks in daily after a quiet week, then asks the trusted parties, and a parent coming back stops it', async () => {
    const { mail, totp } = await family()
    await later(6 * DAY)
    expect(mail.sent).toHaveLength(0)
    await later(DAY)
    expect(mail.sent.map((m) => m.subject)).toEqual(['Family Hub: are you all right?'])
    await later(DAY)
    await later(DAY)
    expect(mail.sent.filter((m) => m.subject === 'Family Hub: are you all right?')).toHaveLength(3)
    await later(DAY)
    const asks = mail.sent.filter((m) => m.subject === 'The Tests: is all well?')
    expect(asks.map(to).sort()).toEqual(['john@example.net', 'mary@example.org'])
    expect(asks[0]!.text).toMatch(/https:\/\/hub\.example\.com\/emergency\/[\w-]{30,}/)
    expect(asks[0]!.text).not.toContain('password')

    // A parent signs in: it stops, and the trusted parties are told.
    nextStep(server)
    await signIn(server, 'parent', totp)
    await later(60_000)
    expect(mail.sent.filter((m) => m.subject === 'The Tests: all is well').map(to).sort()).toEqual(['john@example.net', 'mary@example.org'])
    await later(5 * DAY)
    expect(mail.sent.some((m) => m.attachments?.length)).toBe(false)
  })

  it('stops when a trusted party says all is well', async () => {
    const { mail, visitor } = await family()
    await later(7 * DAY)
    for (let i = 0; i < 3; i++) await later(DAY)
    const ask = mail.sent.find((m) => m.subject === 'The Tests: is all well?' && to(m) === 'john@example.net')!
    const token = /\/emergency\/([\w-]+)/.exec(ask.text)![1]!
    expect((await visitor.get<{ stage: string; name: string }>(`/api/emergency/link/${token}`)).body).toMatchObject({ stage: 'asking', name: 'Pastor John' })
    expect((await visitor.post(`/api/emergency/link/${token}/well`, {})).status).toBe(200)
    expect(mail.sent.some((m) => m.subject === 'Family Hub: all is well')).toBe(true)
    await later(5 * DAY)
    expect(mail.sent.some((m) => m.attachments?.length)).toBe(false)
    // Not again for the same quiet spell.
    await later(10 * DAY)
    expect(mail.sent.filter((m) => m.subject === 'Family Hub: are you all right?')).toHaveLength(3)
  })

  it('sends the pack when nobody answers, or at once if a trusted party asks for it then', async () => {
    const { mail } = await family()
    await later(7 * DAY)
    for (let i = 0; i < 3; i++) await later(DAY)
    await later(3 * DAY)
    expect(mail.sent.find((m) => m.attachments?.length)!.to).toEqual(['mary@example.org'])
    await server.close()

    const second = await family()
    await later(7 * DAY)
    for (let i = 0; i < 3; i++) await later(DAY)
    const ask = second.mail.sent.find((m) => m.subject === 'The Tests: is all well?' && to(m) === 'mary@example.org')!
    const token = /\/emergency\/([\w-]+)/.exec(ask.text)![1]!
    const r = await second.visitor.post<{ status: string }>(`/api/emergency/link/${token}/request`, {})
    expect(r.body.status).toBe('sending')
    expect(second.mail.sent.find((m) => m.attachments?.length)!.to).toEqual(['mary@example.org'])
  })

  it('a parent using the hub stops the check-ins', async () => {
    const { mail, totp } = await family()
    await later(7 * DAY)
    expect(mail.sent).toHaveLength(1)
    // Signing in (and using the hub) is activity.
    nextStep(server)
    const back = await signIn(server, 'parent', totp)
    await later(DAY)
    expect(mail.sent).toHaveLength(1)
    expect((await back.get<{ active: boolean }>('/api/emergency/status')).body.active).toBe(false)
  })
})

describe('the release settings', () => {
  it('are the parents’ to choose, within sensible limits', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    expect((await client.get<{ settings: Record<string, unknown> }>('/api/emergency')).body.settings).toEqual({ requestWaitDays: 3, confirmHours: 24, backstop: true, inactiveDays: 7, checkinDays: 3, partyWaitDays: 3 })
    expect((await client.call('PUT', '/api/emergency/settings', { settings: { requestWaitDays: 5, backstop: false } })).status).toBe(200)
    expect((await client.call('PUT', '/api/emergency/settings', { settings: { inactiveDays: 1 } })).status).toBe(400)
    expect((await client.get<{ settings: { requestWaitDays: number; backstop: boolean } }>('/api/emergency')).body.settings).toMatchObject({ requestWaitDays: 5, backstop: false })
    expect((await client.call('PUT', '/api/emergency/my-email', { email: 'nope' })).status).toBe(400)
    expect((await client.call('PUT', '/api/emergency/my-email', { email: 'Me@Example.com' })).status).toBe(200)
    expect((await client.get<{ myEmail: string }>('/api/emergency')).body.myEmail).toBe('me@example.com')
    expect(JSON.stringify(server.services.db.prepare('SELECT * FROM emergency_parent_email').all())).not.toContain('example.com')

    const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    for (const r of [kid.get('/api/emergency/status'), kid.post('/api/emergency/release/cancel', {}), kid.call('PUT', '/api/emergency/settings', { settings: {} })]) expect((await r).status).toBe(403)
  })
})
