import { afterEach, describe, expect, it } from 'vitest'
import { cleanSchool } from '../src/school.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

describe('school records', () => {
  it('refuse what does not make sense', () => {
    expect(() => cleanSchool('year', { year: 2027, school: 'Little Acorns', terms: [{ name: 'Term 1', start: '2027-03-01', end: '2027-01-15' }] })).toThrow()
    expect(() => cleanSchool('activity', { name: 'Swimming', from: '2027-01-15', to: '2027-03-28', sessions: [{ day: 'TU', start: '15:00', end: '14:00' }] })).toThrow()
    expect(() => cleanSchool('activity', { name: 'Swimming', from: '2027-01-15', to: '2027-03-28', sessions: [{ day: 'XX', start: '14:00', end: '15:00' }] })).toThrow()
    expect(() => cleanSchool('contact', { role: 'teacher' })).toThrow()
    expect(cleanSchool('reminder', { what: 'Costume for the concert', date: '2027-06-10', leads: [1, 7, 1] })).toMatchObject({ leads: [7, 1], done: false })
  })
})

describe('the School API', () => {
  it('keeps each child’s school sealed, for parents only, with generic reminders and a folder', async () => {
    server = await startServer() // 2026-11-20
    const { client } = await setUpAdmin(server)
    const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    const sam = (await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })).body.profile.id

    await client.post('/api/school/years', { profileId: sam, item: { year: 2027, school: 'Little Acorns', grade: 'Butterflies', terms: [{ name: 'Term 1', start: '2027-01-15', end: '2027-03-28' }] } })
    const swim = await client.post<{ item: { id: string; version: number } }>('/api/school/activities', {
      profileId: sam,
      item: { name: 'Swimming', who: 'Aqua Kids', location: 'Sea Point pool', sessions: [{ day: 'TU', start: '14:30', end: '15:15' }], from: '2027-01-15', to: '2027-03-28', term: 'Term 1', cancelPhone: '082 555 0123', cost: 95000, costPer: 'term' },
    })
    expect(swim.status).toBe(200)
    // A reminder for every child, and one for Sam.
    await client.post('/api/school/reminders', { profileId: null, item: { what: 'Pyjama day: R10 for charity', date: '2026-11-25', leads: [1, 0] } })
    await client.post('/api/school/reminders', { profileId: sam, item: { what: 'Nativity costume', date: '2026-12-01', leads: [7, 1] } })

    const raw = JSON.stringify(server.services.db.prepare('SELECT * FROM school').all())
    for (const w of ['Acorns', 'Swimming', 'Aqua', 'Pyjama', 'costume', '082']) expect(raw).not.toContain(w)

    const all = await client.get<{ items: { kind: string; profileId: string | null }[] }>('/api/school')
    expect(all.body.items.map((i) => i.kind).sort()).toEqual(['activity', 'reminder', 'reminder', 'year'])

    const up = await client.get<{ items: { title: string; whose: string | null; category: string }[] }>('/api/reminders/upcoming')
    expect(up.body.items.filter((i) => i.category === 'school').map((i) => [i.title, i.whose])).toEqual([
      ['Pyjama day: R10 for charity', null],
      ['Nativity costume', 'Sam'],
    ])
    const parent = (await client.get<{ user: { id: string } }>('/api/auth/session')).body.user.id
    const { dueMessagesFor } = await import('../src/notifications.ts')
    expect(dueMessagesFor(server.services, parent, '2026-11-24').map((m) => m.body)).toContain('A school reminder is due. Tap to see.')

    // Editing checks the version; deleting works.
    const id = swim.body.item.id
    expect((await client.call('PUT', `/api/school/activities/${id}`, { baseVersion: 2, item: { name: 'x', from: '2027-01-15', to: '2027-03-28' } })).status).toBe(409)
    expect((await client.del(`/api/school/activities/${id}`)).status).toBe(204)

    // The child's folder: inside a parents-only School folder, the same each time.
    const folder = (await client.get<{ folderId: string }>(`/api/school/folder/${sam}`)).body.folderId
    expect((await client.get<{ folderId: string }>(`/api/school/folder/${sam}`)).body.folderId).toBe(folder)
    const kidFiles = await kid.get<{ items: { name: string }[] }>('/api/files')
    expect(kidFiles.body.items.map((i) => i.name)).not.toContain('School')

    for (const r of [kid.get('/api/school'), kid.post('/api/school/reminders', { profileId: null, item: {} }), kid.get(`/api/school/folder/${sam}`)]) expect((await r).status).toBe(403)
    expect((await client.post('/api/school/years', { profileId: 'nobody', item: { year: 2027, school: 'x' } })).status).toBe(400)
  })

  it('keeps forms (reminded until done) and lists (what to bring by day)', async () => {
    server = await startServer() // 2026-11-20
    const { client } = await setUpAdmin(server)
    const sam = (await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })).body.profile.id
    const form = await client.post<{ item: { id: string; version: number } }>('/api/school/forms', { profileId: sam, item: { what: 'Zoo outing', needs: 'sign and pay', amount: 15000, due: '2026-11-23' } })
    expect(form.status).toBe(200)
    const up = await client.get<{ items: { title: string; category: string }[] }>('/api/reminders/upcoming')
    expect(up.body.items.filter((i) => i.category === 'school').map((i) => i.title)).toEqual(['Zoo outing (sign and pay R 150.00)'])
    const parent = (await client.get<{ user: { id: string } }>('/api/auth/session')).body.user.id
    const { dueMessagesFor } = await import('../src/notifications.ts')
    expect(dueMessagesFor(server.services, parent, '2026-11-20').map((m) => m.body)).toContain('A school form is due. Tap to see.')
    // Done: no more reminders.
    await client.call('PUT', `/api/school/forms/${form.body.item.id}`, { baseVersion: 1, item: { what: 'Zoo outing', needs: 'sign and pay', amount: 15000, due: '2026-11-23', done: true, doneOn: '2026-11-20' } })
    expect((await client.get<{ items: { category: string }[] }>('/api/reminders/upcoming')).body.items.filter((i) => i.category === 'school')).toEqual([])

    const bring = await client.post('/api/school/lists', {
      profileId: sam,
      item: { type: 'bring', name: 'What to bring', year: 2027, items: [{ text: 'Swimming bag', day: 'TU' }, { text: 'Library book', day: 'FR' }] },
    })
    expect(bring.status).toBe(200)
    // Items on a "what to bring" list need a day; a stationery list's do not.
    expect((await client.post('/api/school/lists', { profileId: sam, item: { type: 'bring', name: 'x', year: 2027, items: [{ text: 'Hat' }] } })).status).toBe(400)
    const stationery = await client.post<{ item: { items: { day: string | null }[] } }>('/api/school/lists', { profileId: sam, item: { type: 'stationery', name: 'Stationery', year: 2027, items: [{ text: 'Crayons', qty: '1 box', day: 'MO' }] } })
    expect(stationery.body.item.items[0]!.day).toBeNull()
    const raw = JSON.stringify(server.services.db.prepare('SELECT * FROM school').all())
    for (const w of ['Zoo', 'Swimming', 'Crayons']) expect(raw).not.toContain(w)
  })
})
