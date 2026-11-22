import { afterEach, describe, expect, it } from 'vitest'
import { runReminders } from '../src/notifications.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, signIn, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

const DAY = 86_400_000

interface Timeline {
  notes: { id: string; date: string; kind: string; lifeEvent: string | null; text: string }[]
  gifts: { id: string; idea: string; status: string; date: string | null }[]
}

async function contact(client: Client, extra: Record<string, unknown> = {}) {
  const r = await client.post<{ contact: { id: string; version: number; keepInTouch: Record<string, unknown> } }>('/api/contacts', { name: 'Old Friend', category: 'friend', ...extra })
  expect(r.status).toBe(200)
  return r.body.contact
}

describe('notes, timeline and gifts', () => {
  it('keeps dated notes and life events, newest first, sealed and bound to the person', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const c = await contact(client)
    await client.post(`/api/contacts/${c.id}/notes`, { date: '2026-03-01', text: 'Lunch at the Waterfront' })
    const t = await client.post<Timeline>(`/api/contacts/${c.id}/notes`, { date: '2026-10-10', kind: 'event', lifeEvent: 'new_job', text: 'Started at the hospital' })
    expect(t.body.notes.map((n) => n.text)).toEqual(['Started at the hospital', 'Lunch at the Waterfront'])
    expect(t.body.notes[0]).toMatchObject({ kind: 'event', lifeEvent: 'new_job' })
    // Today by default; checked input.
    const today = await client.post<Timeline>(`/api/contacts/${c.id}/notes`, { text: 'Called about the braai' })
    expect(today.body.notes[0]!.date).toBe('2026-11-20')
    expect((await client.post(`/api/contacts/${c.id}/notes`, { text: '' })).status).toBe(400)
    expect((await client.post(`/api/contacts/${c.id}/notes`, { text: 'x', date: '--01-01' })).status).toBe(400)
    expect((await client.post(`/api/contacts/${c.id}/notes`, { kind: 'event', lifeEvent: 'won_lottery', text: 'x' })).status).toBe(400)

    const raw = JSON.stringify(server.services.db.prepare('SELECT * FROM contact_notes').all())
    expect(raw).not.toContain('Waterfront')
    // A note cannot be moved to another person: it is bound to its contact.
    const other = await contact(client, { name: 'Someone else' })
    const noteId = t.body.notes[0]!.id
    server.services.db.prepare('UPDATE contact_notes SET contact_id = ? WHERE id = ?').run(other.id, noteId)
    expect((await client.get(`/api/contacts/${other.id}/timeline`)).status).toBe(500)
    server.services.db.prepare('UPDATE contact_notes SET contact_id = ? WHERE id = ?').run(c.id, noteId)

    // Edit and delete; deleting the person deletes their notes.
    const edited = await client.call<Timeline>('PUT', `/api/contacts/notes/${noteId}`, { date: '2026-10-10', kind: 'event', lifeEvent: 'new_job', text: 'Started as head nurse' })
    expect(edited.body.notes.find((n) => n.id === noteId)!.text).toBe('Started as head nurse')
    expect((await client.del<Timeline>(`/api/contacts/notes/${noteId}`)).body.notes).toHaveLength(2)
    await client.del(`/api/contacts/${c.id}`)
    expect((server.services.db.prepare('SELECT COUNT(*) AS n FROM contact_notes WHERE contact_id = ?').get(c.id) as { n: number }).n).toBe(0)
  })

  it('keeps gift ideas and gifts given', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const c = await contact(client)
    const t = await client.post<Timeline>(`/api/contacts/${c.id}/gifts`, { idea: 'Hiking boots', occasion: 'Birthday', link: 'https://example.com/boots' })
    expect(t.body.gifts[0]).toMatchObject({ idea: 'Hiking boots', status: 'idea', date: null })
    const given = await client.call<Timeline>('PUT', `/api/contacts/gifts/${t.body.gifts[0]!.id}`, { idea: 'Hiking boots', occasion: 'Birthday', status: 'given', date: '2026-11-01' })
    expect(given.body.gifts[0]).toMatchObject({ status: 'given', date: '2026-11-01' })
    expect((await client.post(`/api/contacts/${c.id}/gifts`, { idea: 'x', link: 'javascript:alert(1)' })).status).toBe(400)
    expect((await client.post(`/api/contacts/${c.id}/gifts`, { idea: '' })).status).toBe(400)
    expect(JSON.stringify(server.services.db.prepare('SELECT * FROM contact_gifts').all())).not.toContain('boots')
  })

  it('reminds to catch up a set time after you last spoke, once, and "We spoke" resets it', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    // Set up today (20 November): every 30 days.
    const c = await contact(client, { keepInTouch: { everyDays: 30 } })
    expect(c.keepInTouch).toMatchObject({ everyDays: 30, since: '2026-11-20', lastContact: null })
    expect((await client.post('/api/contacts', { name: 'X', keepInTouch: { everyDays: 3 } })).status).toBe(400)

    server.clock.now += 29 * DAY
    expect(await runReminders(server.services)).toBe(0)
    server.clock.now += 1 * DAY
    expect(await runReminders(server.services)).toBe(1)
    expect(await runReminders(server.services)).toBe(0)
    // Nothing more until someone says "We spoke" (next test).
    server.clock.now += 10 * DAY
    expect(await runReminders(server.services)).toBe(0)
  })

  it('"We spoke" records the date and a timeline entry, and moves the next catch-up', async () => {
    server = await startServer()
    const { client, secret } = await setUpAdmin(server)
    const c = await contact(client, { keepInTouch: { everyDays: 14 } })
    const spoke = await client.post<{ contact: { version: number; keepInTouch: { lastContact: string } } } & Timeline>(`/api/contacts/${c.id}/spoke`, { text: 'Coffee' })
    expect(spoke.body.contact.keepInTouch.lastContact).toBe('2026-11-20')
    expect(spoke.body.contact.version).toBe(2)
    expect(spoke.body.notes[0]).toMatchObject({ kind: 'contact', text: 'Coffee', date: '2026-11-20' })
    const up = await client.get<{ items: { title: string; date: string }[] }>('/api/reminders/upcoming')
    expect(up.body.items).toEqual([])
    // An earlier date does not move the last contact backwards.
    await client.post(`/api/contacts/${c.id}/spoke`, { date: '2026-11-01' })
    const listed = await client.get<{ contacts: { keepInTouch: { lastContact: string } }[] }>('/api/contacts')
    expect(listed.body.contacts[0]!.keepInTouch.lastContact).toBe('2026-11-20')
    // A week before it is due, it shows as coming up.
    server.clock.now += 8 * DAY
    const again = await signIn(server, 'parent', secret)
    const soon = await again.get<{ items: { title: string; date: string }[] }>('/api/reminders/upcoming')
    expect(soon.body.items).toEqual([expect.objectContaining({ title: 'Catch up with Old Friend', date: '2026-12-04' })])
  })

  it('reminds once about a catch-up that was already overdue, and not for members', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    await contact(client, { keepInTouch: { everyDays: 30, lastContact: '2026-01-01' } })
    expect(await runReminders(server.services)).toBe(1)
    expect(await runReminders(server.services)).toBe(0)
    const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    const c = (await client.get<{ contacts: { id: string }[] }>('/api/contacts')).body.contacts[0]!
    expect((await kid.get(`/api/contacts/${c.id}/timeline`)).status).toBe(403)
    expect((await kid.post(`/api/contacts/${c.id}/spoke`)).status).toBe(403)
  })
})
