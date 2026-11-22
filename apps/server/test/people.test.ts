import { afterEach, describe, expect, it } from 'vitest'
import { DATE_NOTICES, runReminders } from '../src/notifications.ts'
import type { PushFetch } from '../src/webpush.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, signIn, startServer, type TestServer } from './helpers.ts'
import { createECDH } from 'node:crypto'
import { decryptAsReceiver } from './push-receiver.ts'

let server: TestServer
afterEach(async () => server?.close())

const DAY = 86_400_000

interface Listed {
  id: string
  version: number
  name: string
  dates: { id: string; kind: string; date: string; remind: string; remindFor: string }[]
  deceased: boolean
  profileId: string | null
}
interface Relation {
  id: string
  a: string
  b: string
  kind: string
}

async function addParent(admin: Client): Promise<{ client: Client; id: string }> {
  const invite = await admin.post<{ token: string }>('/api/invites', { displayName: 'Second', role: 'admin' })
  const client = new Client(server.url)
  await client.post(`/api/invites/redeem/${invite.body.token}`, { username: 'second', displayName: 'Second', password: PASSWORD })
  nextStep(server)
  await enrollTotp(server, client)
  const me = await client.get<{ user: { id: string } }>('/api/auth/session')
  return { client, id: me.body.user.id }
}

function browser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = Buffer.alloc(16, 9)
  return {
    subscription: { kind: 'webpush', endpoint: `https://push.example.com/${Math.random()}`, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') }, label: 'Browser' },
    read: (body: Buffer) => JSON.parse(decryptAsReceiver(body, ecdh.getPrivateKey(), auth).toString()) as { body: string },
  }
}

describe('people and dates', () => {
  it('keeps birthdays (with or without the year) and checks them', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const ok = await client.post<{ contact: Listed }>('/api/contacts', {
      name: 'Gran Tester',
      category: 'family',
      dates: [
        { kind: 'birthday', date: '1946-11-27', remind: 'week' },
        { kind: 'other', label: 'Name day', date: '--06-24', remind: 'day' },
      ],
      about: { howWeMet: 'She is Mum’s mum', food: 'No shellfish' },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.contact.dates).toEqual([
      expect.objectContaining({ kind: 'birthday', date: '1946-11-27', remind: 'week', remindFor: 'all' }),
      expect.objectContaining({ kind: 'other', date: '--06-24', remind: 'day' }),
    ])
    const bad = async (dates: unknown) => (await client.post('/api/contacts', { name: 'X', dates })).status
    expect(await bad([{ kind: 'birthday', date: '--02-30' }])).toBe(400)
    expect(await bad([{ kind: 'birthday', date: '1946-13-01' }])).toBe(400)
    expect(await bad([{ kind: 'other', date: '--01-01' }])).toBe(400) // needs a name
    expect(await bad([{ kind: 'birthday', date: '--01-01', remind: 'hourly' }])).toBe(400)
    expect(await bad([{ kind: 'birthday', date: '--01-01', remindFor: 'someone-else' }])).toBe(400)
    expect(await bad(Array.from({ length: 11 }, () => ({ kind: 'birthday', date: '--01-01' })))).toBe(400)
    // Sealed with the server key: no names or dates in the database.
    const raw = JSON.stringify(server.services.db.prepare('SELECT * FROM contacts').all())
    expect(raw).not.toContain('1946')
    expect(raw).not.toContain('shellfish')
  })

  it('reminds of birthdays with generic text, shows them coming up, and stops for someone who has died', async () => {
    const sent: Buffer[] = []
    const pushFetch: PushFetch = async (_url, init) => {
      sent.push(init.body)
      return { status: 201 }
    }
    server = await startServer({}, { pushFetch })
    const { client, secret } = await setUpAdmin(server)
    const b = browser()
    await client.post('/api/notifications/subscriptions', b.subscription)
    // Today is 20 November 2026; Gran turns 80 in a week.
    const gran = await client.post<{ contact: Listed }>('/api/contacts', { name: 'Gran Tester', category: 'family', dates: [{ kind: 'birthday', date: '1946-11-27', remind: 'week' }] })

    const up = await client.get<{ items: { title: string; detail: string | null; daysLeft: number }[] }>('/api/reminders/upcoming')
    expect(up.body.items).toEqual([expect.objectContaining({ title: 'Gran Tester’s birthday', detail: 'turns 80', daysLeft: 7 })])

    expect(await runReminders(server.services)).toBe(1)
    const text = b.read(sent[0]!).body
    expect(DATE_NOTICES.birthday.before).toContain(text)
    expect(text).not.toContain('Gran')
    server.clock.now += 7 * DAY
    expect(await runReminders(server.services)).toBe(1)
    expect(DATE_NOTICES.birthday.today).toContain(b.read(sent[1]!).body)

    // Next year it comes round again.
    server.clock.now += 358 * DAY
    expect(await runReminders(server.services)).toBe(1)

    // Marking someone as deceased stops their birthday reminders. (Sign in again: a year has passed.)
    const fresh = await signIn(server, 'parent', secret)
    const marked = await fresh.call('PUT', `/api/contacts/${gran.body.contact.id}`, { name: 'Gran Tester', category: 'family', deceased: true, dates: gran.body.contact.dates, baseVersion: 1 })
    expect(marked.status).toBe(200)
    server.clock.now += 366 * DAY // 20 November 2028 (a leap year): a week before her birthday again
    expect(await runReminders(server.services)).toBe(0)
  })

  it('sends a date only to the parent it is for, and respects the dates setting', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const other = await addParent(client)
    await client.post('/api/contacts', { name: 'Old Friend', category: 'friend', dates: [{ kind: 'birthday', date: '--11-21', remind: 'day', remindFor: other.id }] })
    await client.post('/api/contacts', { name: 'Cousin', category: 'family', dates: [{ kind: 'birthday', date: '--11-22', remind: 'day' }] })
    const titles = async (c: Client) => (await c.get<{ items: { title: string }[] }>('/api/reminders/upcoming')).body.items.map((i) => i.title)
    expect(await titles(client)).toEqual(['Cousin’s birthday'])
    expect(await titles(other.client)).toEqual(['Old Friend’s birthday', 'Cousin’s birthday'])
    await other.client.call('PUT', '/api/notifications/settings', { dates: false })
    // Coming up still lists them; notifications follow the setting (checked through the delivery records).
    server.clock.now += 2 * DAY
    await runReminders(server.services)
    const deliveries = server.services.db.prepare('SELECT user_id FROM reminder_deliveries').all() as { user_id: string }[]
    expect(deliveries.every((d) => d.user_id !== other.id)).toBe(true)
    expect(deliveries.length).toBe(1)
  })

  it('links people both ways, sealed, and forgets links to someone deleted', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const add = async (name: string) => (await client.post<{ contact: Listed }>('/api/contacts', { name, category: 'friend' })).body.contact.id
    const thandi = await add('Thandi')
    const sipho = await add('Sipho')
    const lwazi = await add('Lwazi')
    expect((await client.post('/api/contacts/relations', { a: sipho, b: thandi, kind: 'partner' })).status).toBe(200)
    expect((await client.post('/api/contacts/relations', { a: lwazi, b: thandi, kind: 'child' })).status).toBe(200)
    // One relationship per pair, either way round; sensible input only.
    expect((await client.post('/api/contacts/relations', { a: thandi, b: lwazi, kind: 'parent' })).status).toBe(409)
    expect((await client.post('/api/contacts/relations', { a: thandi, b: thandi, kind: 'friend' })).status).toBe(400)
    expect((await client.post('/api/contacts/relations', { a: thandi, b: sipho, kind: 'boss' })).status).toBe(400)
    expect((await client.post('/api/contacts/relations', { a: lwazi, b: sipho, kind: 'other' })).status).toBe(400)
    const list = await client.get<{ relations: Relation[] }>('/api/contacts')
    expect(list.body.relations).toHaveLength(2)
    expect(JSON.stringify(server.services.db.prepare('SELECT * FROM contact_relations').all())).not.toContain(thandi)

    await client.del(`/api/contacts/${lwazi}`)
    expect((await client.get<{ relations: Relation[] }>('/api/contacts')).body.relations).toEqual([expect.objectContaining({ a: sipho, b: thandi, kind: 'partner' })])
    const rel = (await client.get<{ relations: Relation[] }>('/api/contacts')).body.relations[0]!
    expect((await client.del(`/api/contacts/relations/${rel.id}`)).status).toBe(204)
    expect((await client.del(`/api/contacts/relations/${rel.id}`)).status).toBe(404)
  })

  it('links a contact to one of the family’s Quick Info people, once', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const sam = await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })
    const a = await client.post<{ contact: Listed }>('/api/contacts', { name: 'Sam Tester', category: 'family', profileId: sam.body.profile.id })
    expect(a.body.contact.profileId).toBe(sam.body.profile.id)
    expect((await client.post('/api/contacts', { name: 'Sam again', profileId: sam.body.profile.id })).status).toBe(409)
    expect((await client.post('/api/contacts', { name: 'Nobody', profileId: 'no-such-person' })).status).toBe(400)
    // Saving the same contact keeps its link; removing the person clears it.
    expect((await client.call('PUT', `/api/contacts/${a.body.contact.id}`, { name: 'Sam T', profileId: sam.body.profile.id, baseVersion: 1 })).status).toBe(200)
    await client.del(`/api/quick-info/profiles/${sam.body.profile.id}`)
    const after = await client.get<{ contacts: Listed[] }>('/api/contacts')
    expect(after.body.contacts[0]!.profileId).toBeNull()
  })
})
