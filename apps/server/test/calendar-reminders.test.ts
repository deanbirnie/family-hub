import { createECDH } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { dueMessagesFor, runReminders } from '../src/notifications.ts'
import { zonedToEpoch } from '../src/schedule.ts'
import type { PushFetch } from '../src/webpush.ts'
import { decryptAsReceiver } from './push-receiver.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

const MIN = 60_000

describe('local times', () => {
  it('turns a family-time-zone time into an instant, across daylight saving', () => {
    expect(zonedToEpoch('2026-11-20T14:00', 'Africa/Johannesburg')).toBe(Date.UTC(2026, 10, 20, 12, 0))
    expect(zonedToEpoch('2026-07-01T09:30', 'America/New_York')).toBe(Date.UTC(2026, 6, 1, 13, 30))
    expect(zonedToEpoch('2026-12-01T09:30', 'America/New_York')).toBe(Date.UTC(2026, 11, 1, 14, 30))
  })
})

/** Two parents (the first linked to a person), a teenager with an account and a person, and a young child without one. */
async function family(pushFetch?: PushFetch) {
  server = await startServer({}, { pushFetch })
  const { client: parent } = await setUpAdmin(server)
  const parentId = (await parent.get<{ user: { id: string } }>('/api/auth/session')).body.user.id
  const add = async (displayName: string, role: 'admin' | 'member') => {
    const invite = await parent.post<{ token: string }>('/api/invites', { displayName, role })
    const c = new Client(server.url)
    await c.post(`/api/invites/redeem/${invite.body.token}`, { username: displayName.toLowerCase(), displayName, password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, c)
    const id = (await c.get<{ user: { id: string } }>('/api/auth/session')).body.user.id
    return { client: c, id }
  }
  const other = await add('Partner', 'admin')
  const teen = await add('Teen', 'member')
  const person = async (displayName: string, userId?: string) => (await parent.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName, userId })).body.profile.id
  const people = {
    me: await person('Parent', parentId),
    teenP: await person('Teen', teen.id),
    toddler: await person('Toddler'),
  }
  // Signing up moved the clock on by a few 30-second steps: back to exactly 14:00 in Johannesburg.
  server.clock.now = Date.UTC(2026, 10, 20, 12, 0)
  return {
    ...people,
    parent,
    parentId,
    other,
    teen,
  }
}

function browser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = Buffer.alloc(16, 4)
  return {
    subscription: { kind: 'webpush', endpoint: `https://push.example.com/${Math.random()}`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') }, label: 'Browser' },
    read: (body: Buffer) => JSON.parse(decryptAsReceiver(body, ecdh.getPrivateKey(), auth).toString()) as { body: string; tag: string },
  }
}

const delivered = () => (server.services.db.prepare('SELECT user_id, occurrence FROM reminder_deliveries ORDER BY sent_at').all() as { user_id: string; occurrence: string }[])

describe('calendar reminders', () => {
  it('reminds to the minute, once, with generic text, whatever the sending hour', async () => {
    const sent: Buffer[] = []
    const f = await family(async (_url, init) => (sent.push(init.body), { status: 201 }))
    const b = browser()
    await f.parent.post('/api/notifications/subscriptions', b.subscription)
    await f.parent.call('PUT', '/api/notifications/settings', { sendHour: 23 })
    // It is 14:00 in Johannesburg; the dentist is at 15:00, with reminders an hour before and at the time.
    const ev = await f.parent.post('/api/calendar/events', { title: 'Dentist', start: '2026-11-20T15:00', end: '2026-11-20T15:30', tags: [f.me], reminders: [60, 0] })
    expect(ev.status).toBe(200)
    expect(await runReminders(server.services)).toBe(1)
    expect(await runReminders(server.services)).toBe(0)
    expect(b.read(sent[0]!).body).toBe('An event starts in 1 hour. Tap to see.')
    expect(JSON.stringify(b.read(sent[0]!))).not.toContain('Dentist')
    server.clock.now += 59 * MIN
    expect(await runReminders(server.services)).toBe(0)
    server.clock.now += 1 * MIN
    expect(await runReminders(server.services)).toBe(1)
    expect(b.read(sent[1]!).body).toBe('An event is starting now. Tap to see.')
    // Only the parent it was for.
    expect(new Set(delivered().map((d) => d.user_id))).toEqual(new Set([f.parentId]))
    expect((await f.parent.post('/api/calendar/events', { title: 'X', start: '2026-11-20T15:00', tags: [f.me], reminders: [5] })).status).toBe(400)
  })

  it('goes to the person tagged if they have an account, else to every parent; Family goes to every parent', async () => {
    const f = await family()
    await f.parent.post('/api/calendar/events', { title: 'Match', start: '2026-11-20T15:00', tags: [f.teenP], reminders: [60] })
    await f.parent.post('/api/calendar/events', { title: 'Clinic', start: '2026-11-20T15:00', tags: [f.toddler], reminders: [60] })
    await f.parent.post('/api/calendar/events', { title: 'Braai', allDay: true, start: '2026-11-21', tags: ['family'], reminders: [1440] })
    await runReminders(server.services)
    const who = (prefix: string) => delivered().filter((d) => d.occurrence.startsWith(prefix))
    const all = delivered()
    expect(all.filter((d) => d.user_id === f.teen.id)).toHaveLength(1)
    expect(all.filter((d) => d.user_id === f.parentId)).toHaveLength(2) // clinic and braai
    expect(all.filter((d) => d.user_id === f.other.id)).toHaveLength(2)
    expect(who('e:')).toHaveLength(5)
  })

  it('respects the events switch, and skips reminders that are hours late or for events that have begun', async () => {
    const f = await family()
    await f.parent.call('PUT', '/api/notifications/settings', { events: false })
    await f.parent.post('/api/calendar/events', { title: 'A', start: '2026-11-20T15:00', tags: [f.me], reminders: [60] })
    expect(await runReminders(server.services)).toBe(0)
    await f.parent.call('PUT', '/api/notifications/settings', { events: true })
    // Already begun (13:00) and an hour-before reminder that was 7 hours ago.
    await f.parent.post('/api/calendar/events', { title: 'B', start: '2026-11-20T13:00', tags: [f.me], reminders: [0] })
    await f.parent.post('/api/calendar/events', { title: 'C', start: '2026-11-20T08:00', end: '2026-11-20T23:00', tags: [f.me], reminders: [60] })
    expect(await runReminders(server.services)).toBe(1) // only A
  })

  it('lets a phone’s daily check pick up due event reminders, for members too', async () => {
    const f = await family()
    await f.parent.post('/api/calendar/events', { title: 'Match', start: '2026-11-20T18:00', tags: [f.teenP], reminders: [1440, 60] })
    // "A day before" (18:00 yesterday) is already due; "an hour before" (17:00 today) is not yet.
    const msgs = dueMessagesFor(server.services, f.teen.id, '2026-11-20')
    expect(msgs.map((m) => m.body)).toEqual(['An event is tomorrow. Tap to see.'])
    expect(dueMessagesFor(server.services, f.other.id, '2026-11-20')).toEqual([])
  })
})

describe('birthdays on the calendar, and children kept on a contact', () => {
  it('shows Contacts dates (and children kept on a contact) to everyone, under the right tag', async () => {
    const f = await family()
    const gran = await f.parent.post<{ contact: { id: string } }>('/api/contacts', { name: 'Gran', dates: [{ kind: 'birthday', date: '1946-11-27' }] })
    const wade = await f.parent.post<{ contact: { id: string; version: number } }>('/api/contacts', {
      name: 'Wade',
      dates: [{ kind: 'birthday', date: '--11-25', remindFor: f.parentId }],
    })
    const wife = await f.parent.post<{ contact: { id: string } }>('/api/contacts', { name: 'Wade’s wife' })
    const isla = await f.parent.post<{ contact: { members: { id: string; name: string }[]; version: number } }>(`/api/contacts/${wade.body.contact.id}/members`, {
      name: 'Isla',
      date: '2022-11-30',
      alsoOf: wife.body.contact.id,
    })
    expect(isla.body.contact.members).toEqual([expect.objectContaining({ name: 'Isla', date: '2022-11-30', remind: 'week', alsoOf: wife.body.contact.id })])
    expect(gran.status).toBe(200)

    type Ev = { title: string; day: string; tags: string[]; readOnly?: boolean; detail: string | null }
    const events = (await f.teen.client.get<{ events: Ev[] }>('/api/calendar/events?from=2026-11-01&to=2026-11-30')).body.events
    expect(events.map((e) => [e.title, e.day, e.tags, e.detail])).toEqual([
      ['Wade’s birthday', '2026-11-25', [f.me], null],
      ['Gran’s birthday', '2026-11-27', ['family'], 'turns 80'],
      ['Isla’s birthday', '2026-11-30', ['family'], 'Wade’s · turns 4'],
    ])
    expect(events.every((e) => e.readOnly)).toBe(true)
    // Not a contact of her own.
    expect((await f.parent.get<{ contacts: { name: string }[] }>('/api/contacts')).body.contacts.map((c) => c.name)).not.toContain('Isla')
  })

  it('keeps children through contact edits, reminds of their birthdays, exports them as family, and tidies up', async () => {
    const f = await family()
    const wade = await f.parent.post<{ contact: { id: string } }>('/api/contacts', { name: 'Wade' })
    const wife = await f.parent.post<{ contact: { id: string } }>('/api/contacts', { name: 'Kim' })
    const added = await f.parent.post<{ contact: { members: { id: string }[]; version: number } }>(`/api/contacts/${wade.body.contact.id}/members`, {
      name: 'Isla',
      date: '--11-27',
      alsoOf: wife.body.contact.id,
    })
    const member = added.body.contact.members[0]!.id
    // Checked input.
    expect((await f.parent.post(`/api/contacts/${wade.body.contact.id}/members`, { name: 'X', date: '--02-30' })).status).toBe(400)
    expect((await f.parent.post(`/api/contacts/${wade.body.contact.id}/members`, { name: 'X', alsoOf: wade.body.contact.id })).status).toBe(400)
    expect((await f.teen.client.post(`/api/contacts/${wade.body.contact.id}/members`, { name: 'X' })).status).toBe(403)
    // A normal edit of Wade keeps Isla.
    await f.parent.call('PUT', `/api/contacts/${wade.body.contact.id}`, { name: 'Wade B', baseVersion: added.body.contact.version })
    const list = async () => (await f.parent.get<{ contacts: { id: string; members: { name: string; alsoOf: string | null }[] }[] }>('/api/contacts')).body.contacts
    expect((await list()).find((c) => c.id === wade.body.contact.id)!.members.map((m) => m.name)).toEqual(['Isla'])
    // Her birthday reminds a week before (each parent).
    expect(await runReminders(server.services)).toBe(2)
    // Kim's vCard names Isla as her child too.
    const vcf = await (await fetch(`${server.url}/api/contacts/export/${wife.body.contact.id}.vcf`, { headers: { cookie: f.parent.cookie } })).text()
    expect(vcf).toContain('X-ABRELATEDNAMES:Isla')
    // Editing her, then deleting Kim: Isla stays on Wade, shown only there.
    expect((await f.parent.call('PUT', `/api/contacts/${wade.body.contact.id}/members/${member}`, { name: 'Isla B', date: '--11-27', alsoOf: wife.body.contact.id })).status).toBe(200)
    await f.parent.del(`/api/contacts/${wife.body.contact.id}`)
    expect((await list())[0]!.members).toEqual([expect.objectContaining({ name: 'Isla B', alsoOf: null })])
    expect((await f.parent.del(`/api/contacts/${wade.body.contact.id}/members/${member}`)).status).toBe(200)
    expect((await list())[0]!.members).toEqual([])
    expect(JSON.stringify(server.services.db.prepare('SELECT * FROM contacts').all())).not.toContain('Isla')
  })
})
