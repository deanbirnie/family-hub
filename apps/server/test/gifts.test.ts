import { afterEach, describe, expect, it } from 'vitest'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

interface Planner {
  today: string
  occasions: { key: string; contactId: string | null; title: string; kind: string; date: string }[]
  contacts: { id: string; name: string }[]
  gifts: { id: string; contactId: string; idea: string; status: string; amount: number | null; forDate: string | null; plannedId: string | null }[]
}
interface Timeline {
  gifts: { id: string; idea: string; status: string; amount: number | null; forDate: string | null; plannedId: string | null }[]
}

describe('the gift planner', () => {
  it('shows the occasions of the people who matter, and Christmas, with each gift on its way', async () => {
    server = await startServer() // 2026-11-20
    const { client } = await setUpAdmin(server)
    const gran = (await client.post<{ contact: { id: string } }>('/api/contacts', { name: 'Gran', dates: [{ kind: 'birthday', date: '1946-11-27' }, { kind: 'memorial', date: '--12-02', label: 'Grandpa' }] })).body.contact.id
    // Someone who does not matter (yet): no gift ideas, so not among the people, but their days are there to choose.
    await client.post('/api/contacts', { name: 'Colleague', dates: [{ kind: 'birthday', date: '--12-01' }] })

    // An idea for Gran's birthday, with an amount; an idea for Christmas.
    const t = await client.post<Timeline>(`/api/contacts/${gran}/gifts`, { idea: 'Scarf', amount: 45000, forDate: '2026-11-27' })
    expect(t.body.gifts[0]).toMatchObject({ status: 'idea', amount: 45000, forDate: '2026-11-27', plannedId: null })
    await client.post(`/api/contacts/${gran}/gifts`, { idea: 'Puzzle', amount: 30000, forDate: '2026-12-25' })

    const p = await client.get<Planner>('/api/gifts/planner')
    expect(p.status).toBe(200)
    expect(p.body.occasions.map((o) => [o.title, o.date])).toEqual([
      ['Gran’s birthday', '2026-11-27'],
      ['Colleague’s birthday', '2026-12-01'],
      ['Christmas', '2026-12-25'],
    ])
    expect(p.body.contacts.map((c) => c.name)).toEqual(['Gran'])
    expect(p.body.gifts.map((g) => g.idea).sort()).toEqual(['Puzzle', 'Scarf'])

    // Idea → bought → wrapped → given, and into the budget.
    const scarf = p.body.gifts.find((g) => g.idea === 'Scarf')!
    const planned = await client.post<{ item: { id: string } }>('/api/budget/planned', { item: { name: 'Gifts: Gran’s birthday', amount: 45000, month: '2026-11', categoryId: 'gifts', tag: 'gifts' } })
    expect(planned.status).toBe(200)
    for (const status of ['bought', 'wrapped']) {
      const r = await client.call<Timeline>('PUT', `/api/contacts/gifts/${scarf.id}`, { idea: 'Scarf', amount: 45000, forDate: '2026-11-27', status, plannedId: planned.body.item.id })
      expect(r.status).toBe(200)
    }
    const after = await client.get<Planner>('/api/gifts/planner')
    expect(after.body.gifts.find((g) => g.id === scarf.id)).toMatchObject({ status: 'wrapped', plannedId: planned.body.item.id })

    // Given: still shown for a while, then gone.
    await client.call('PUT', `/api/contacts/gifts/${scarf.id}`, { idea: 'Scarf', status: 'given', date: '2026-11-20' })
    expect((await client.get<Planner>('/api/gifts/planner')).body.gifts.some((g) => g.id === scarf.id)).toBe(true)
    await client.call('PUT', `/api/contacts/gifts/${scarf.id}`, { idea: 'Scarf', status: 'given', date: '2026-08-01' })
    expect((await client.get<Planner>('/api/gifts/planner')).body.gifts.some((g) => g.id === scarf.id)).toBe(false)

    // What does not make sense is refused.
    for (const bad of [{ status: 'lost' }, { amount: -1 }, { amount: 12.5 }, { forDate: '--12-25' }, { forDate: '2026-02-30' }]) {
      expect((await client.post(`/api/contacts/${gran}/gifts`, { idea: 'x', ...bad })).status).toBe(400)
    }
    // A planned expense deleted from the budget drops away instead of blocking edits.
    await client.del(`/api/budget/planned/${planned.body.item.id}`)
    const kept = await client.call<Timeline>('PUT', `/api/contacts/gifts/${scarf.id}`, { idea: 'Scarf', status: 'wrapped', plannedId: planned.body.item.id })
    expect(kept.body.gifts.find((g) => g.id === scarf.id)!.plannedId).toBeNull()
    const raw = JSON.stringify(server.services.db.prepare('SELECT * FROM contact_gifts').all())
    for (const w of ['Scarf', 'Puzzle', '45000']) expect(raw).not.toContain(w)
  })

  it('reads gift ideas made before the planner', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const c = (await client.post<{ contact: { id: string } }>('/api/contacts', { name: 'Old Friend' })).body.contact.id
    const id = 'oldgift000000000'
    const sealed = server.services.serverKey.seal(JSON.stringify({ idea: 'Book', occasion: 'Birthday', status: 'idea', date: null, link: '', note: '' }), 'contact-gift', `${c}/${id}`)
    server.services.db.prepare('INSERT INTO contact_gifts (id, contact_id, sealed, created_at, updated_at) VALUES (?, ?, ?, 1, 1)').run(id, c, sealed)
    expect((await client.get<Planner>('/api/gifts/planner')).body.gifts).toMatchObject([{ idea: 'Book', amount: null, forDate: null, plannedId: null }])
    expect((await client.get<Timeline>(`/api/contacts/${c}/timeline`)).body.gifts).toMatchObject([{ idea: 'Book', amount: null }])
  })

  it('is for parents', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    expect((await kid.get('/api/gifts/planner')).status).toBe(403)
  })
})
