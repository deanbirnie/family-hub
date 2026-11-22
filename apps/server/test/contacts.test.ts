import { afterEach, describe, expect, it } from 'vitest'
import { toVCard, type Contact } from '../src/routes/contacts.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

const gran = {
  name: 'Gran Tester',
  category: 'family',
  phones: [
    { label: 'mobile', number: '+27 82 555 0101' },
    { label: 'home', number: '' },
  ],
  emails: ['gran@example.com'],
  address: '1 Beach Rd, Ballito',
  note: 'Spare key is with her',
}

interface Listed extends Contact {
  id: string
  version: number
}

describe('Family Contacts', () => {
  it('keeps contacts sealed with the server key, and lists them by name', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const a = await client.post<{ contact: Listed }>('/api/contacts', gran)
    expect(a.body.contact).toMatchObject({ name: 'Gran Tester', category: 'family', phones: [{ label: 'mobile', number: '+27 82 555 0101' }], version: 1 })
    await client.post('/api/contacts', { name: 'ballito plumbing', organisation: 'Ballito Plumbing', category: 'services' })
    expect((await client.get<{ contacts: Listed[] }>('/api/contacts')).body.contacts.map((c) => c.name)).toEqual(['ballito plumbing', 'Gran Tester'])

    // In the database: neither the name nor the number.
    const row = server.services.db.prepare('SELECT sealed FROM contacts WHERE id = ?').get(a.body.contact.id) as { sealed: string }
    expect(row.sealed.startsWith('s1.')).toBe(true)
    expect(row.sealed).not.toContain('Gran')
    expect(JSON.stringify(server.services.db.prepare('SELECT * FROM contacts').all())).not.toContain('555')
  })

  it('checks what it is given', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    expect((await client.post('/api/contacts', { ...gran, name: '' })).status).toBe(400)
    expect((await client.post('/api/contacts', { ...gran, category: 'enemies' })).status).toBe(400)
    expect((await client.post('/api/contacts', { ...gran, phones: [{ label: 'mobile', number: 'call me' }] })).status).toBe(400)
    expect((await client.post('/api/contacts', { ...gran, emails: ['not-an-email'] })).status).toBe(400)
  })

  it('does not let two parents overwrite each other', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const c = (await client.post<{ contact: Listed }>('/api/contacts', gran)).body.contact
    expect((await client.call('PUT', `/api/contacts/${c.id}`, { ...gran, role: 'Granny', baseVersion: 1 })).status).toBe(200)
    expect((await client.call('PUT', `/api/contacts/${c.id}`, { ...gran, role: 'Other', baseVersion: 1 })).body).toMatchObject({ error: 'edit_conflict' })
  })

  it('sets emergency contacts for a person, and forgets a deleted contact', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const g = (await client.post<{ contact: Listed }>('/api/contacts', gran)).body.contact
    const n = (await client.post<{ contact: Listed }>('/api/contacts', { name: 'Neighbour', category: 'friend' })).body.contact
    const kid = (await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })).body.profile
    expect((await client.call('PUT', `/api/quick-info/profiles/${kid.id}/emergency`, { primary: g.id, backup: g.id })).status).toBe(400)
    await client.call('PUT', `/api/quick-info/profiles/${kid.id}/emergency`, { primary: g.id, backup: n.id })
    const profile = () => client.get<{ profiles: { id: string; emergency: { primary: string | null; backup: string | null } }[] }>('/api/quick-info').then((r) => r.body.profiles[0]!)
    expect((await profile()).emergency).toEqual({ primary: g.id, backup: n.id })
    const stored = server.services.db.prepare('SELECT emergency FROM family_profiles').get() as { emergency: string }
    expect(stored.emergency.startsWith('s1.')).toBe(true)
    await client.del(`/api/contacts/${g.id}`)
    expect((await profile()).emergency).toEqual({ primary: null, backup: n.id })
  })

  it('exports vCards, without notes unless asked', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const g = (await client.post<{ contact: Listed }>('/api/contacts', gran)).body.contact
    await client.post('/api/contacts', { name: 'School office', organisation: 'Ballito Primary; Junior', category: 'school' })
    const get = (path: string) => fetch(`${server.url}${path}`, { headers: { cookie: client.cookie } })
    const all = await get('/api/contacts/export/all.vcf')
    expect(all.headers.get('content-type')).toBe('text/vcard; charset=utf-8')
    expect(all.headers.get('content-disposition')).toContain('attachment')
    const text = await all.text()
    expect(text.match(/BEGIN:VCARD/g)).toHaveLength(2)
    expect(text).toContain('TEL;TYPE=CELL:+27 82 555 0101')
    expect(text).toContain('ORG:Ballito Primary\\; Junior')
    expect(text).not.toContain('NOTE:')
    expect(await (await get(`/api/contacts/export/${g.id}-notes.vcf`)).text()).toContain('NOTE:Spare key is with her')
    expect((await get('/api/contacts/export/../../etc.vcf')).status).toBe(404)
  })

  it('is for parents only', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    expect((await kid.get('/api/contacts')).status).toBe(403)
    expect((await kid.post('/api/contacts', gran)).status).toBe(403)
    expect((await kid.get('/api/contacts/export/all.vcf')).status).toBe(403)
  })
})

describe('vCard lines', () => {
  it('escape special characters and fold long lines at 75 octets', () => {
    const card = toVCard(
      { name: 'Zoë, the "Plumber"', organisation: '', role: '', category: 'services', phones: [], emails: [], address: 'é'.repeat(60), note: 'line one\nline two' },
      true,
    )
    expect(card).toContain('FN:Zoë\\, the "Plumber"')
    expect(card).toContain('NOTE:line one\\nline two')
    for (const line of card.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
    expect(card.endsWith('END:VCARD\r\n')).toBe(true)
  })
})
