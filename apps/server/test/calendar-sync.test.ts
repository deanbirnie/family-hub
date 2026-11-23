import { afterEach, describe, expect, it } from 'vitest'
import { checkLink, fetchIcs, FetchProblem, isPrivateAddress } from '../src/fetch-ics.ts'
import { syncDue } from '../src/routes/calendar-sync.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

describe('fetching outside calendars safely', () => {
  it('refuses private and local addresses, and anything but https', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.10', '172.20.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fd00::1', '::ffff:192.168.0.1']) expect(isPrivateAddress(ip)).toBe(true)
    for (const ip of ['8.8.8.8', '41.0.0.1', '2001:4860:4860::8888']) expect(isPrivateAddress(ip)).toBe(false)
    expect(checkLink('webcal://calendar.google.com/x.ics').protocol).toBe('https:')
    for (const bad of ['http://example.com/x.ics', 'https://192.168.1.5/x.ics', 'https://localhost/x.ics', 'https://nas.local/x.ics', 'https://user:pw@example.com/x', 'file:///etc/passwd']) {
      expect(() => checkLink(bad)).toThrow(FetchProblem)
    }
    await expect(fetchIcs(new URL('https://127.0.0.1/x.ics'))).rejects.toThrow('private network')
  })
})

const ics = (events: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events}END:VCALENDAR\r\n`
const vevent = (uid: string, start: string, title: string, extra = '') => `BEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;VALUE=DATE:${start}\r\nSUMMARY:${title}\r\n${extra}END:VEVENT\r\n`

interface Item {
  id: string
  source: string
  status: string
  defaultTags: string[]
  event: { title: string; start: string }
}

async function setUp() {
  let feed = ics(vevent('t1', '20261201', 'Term ends') + vevent('s1', '20261205', 'Sports day') + vevent('old', '20260101', 'Long ago'))
  let fail = false
  server = await startServer({}, {
    icsFetch: async () => {
      if (fail) throw new FetchProblem('The calendar answered 503.')
      return feed
    },
  })
  const { client } = await setUpAdmin(server)
  const sam = (await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })).body.profile.id
  return {
    client,
    sam,
    setFeed: (text: string) => (feed = text),
    setFail: (v: boolean) => (fail = v),
    inbox: async () => (await client.get<{ items: Item[] }>('/api/calendar/inbox')).body.items,
    events: async () =>
      (await client.get<{ events: { title: string; day: string; tags: string[]; readOnly?: boolean }[] }>('/api/calendar/events?from=2026-11-01&to=2026-12-31')).body.events.filter((e) => !e.readOnly),
  }
}

describe('subscriptions and the inbox', () => {
  it('puts new events in the inbox, to accept (with tags) or ignore; nothing goes straight in', async () => {
    const t = await setUp()
    const subbed = await t.client.post<{ subscription: { id: string; host: string; lastOkAt: number }; added: number }>('/api/calendar/subscriptions', {
      name: 'School',
      url: 'https://school.example.com/calendar.ics?token=SECRET123',
      tags: [t.sam],
    })
    expect(subbed.status).toBe(200)
    expect(subbed.body.added).toBe(2) // the past event is left out
    expect(subbed.body.subscription.host).toBe('school.example.com')
    // The link (and its secret token) is sealed.
    expect(JSON.stringify(server.services.db.prepare('SELECT * FROM calendar_subscriptions').all())).not.toContain('SECRET123')
    expect(JSON.stringify(server.services.db.prepare('SELECT * FROM calendar_inbox').all())).not.toContain('Sports day')
    expect(await t.events()).toEqual([])

    const items = await t.inbox()
    expect(items.map((i) => [i.source, i.status, i.event.title, i.defaultTags])).toEqual([
      ['School', 'new', 'Term ends', [t.sam]],
      ['School', 'new', 'Sports day', [t.sam]],
    ])
    await t.client.post(`/api/calendar/inbox/${items[0]!.id}/accept`, {})
    await t.client.post(`/api/calendar/inbox/${items[1]!.id}/ignore`)
    expect((await t.events()).map((e) => [e.title, e.tags])).toEqual([['Term ends', [t.sam]]])
    // Refreshing brings nothing back.
    const sub = subbed.body.subscription.id
    expect((await t.client.post<{ added: number }>(`/api/calendar/subscriptions/${sub}/refresh`)).body.added).toBe(0)
    expect(await t.inbox()).toEqual([])
  })

  it('brings changed, cancelled and removed events back for review', async () => {
    const t = await setUp()
    const sub = (await t.client.post<{ subscription: { id: string } }>('/api/calendar/subscriptions', { name: 'School', url: 'https://school.example.com/c.ics' })).body.subscription.id
    await t.client.post('/api/calendar/inbox/all', { action: 'accept' })
    expect((await t.events()).map((e) => e.title)).toEqual(['Term ends', 'Sports day'])
    // Tagged by a parent afterwards; the change keeps the tag.
    const refresh = () => t.client.post<{ added: number }>(`/api/calendar/subscriptions/${sub}/refresh`)

    // Sports day moves; term end is cancelled.
    t.setFeed(ics(vevent('t1', '20261201', 'Term ends', 'STATUS:CANCELLED\r\n') + vevent('s1', '20261206', 'Sports day')))
    expect((await refresh()).body.added).toBe(2)
    const items = await t.inbox()
    expect(items.map((i) => [i.status, i.event.title, i.event.start])).toEqual([
      ['cancelled', 'Term ends', '2026-12-01'],
      ['changed', 'Sports day', '2026-12-06'],
    ])
    await t.client.post('/api/calendar/inbox/all', { action: 'accept' })
    expect((await t.events()).map((e) => [e.title, e.day])).toEqual([['Sports day', '2026-12-06']])

    // Removed from the feed altogether: cancelled; keeping ours means it stays and is not asked about again.
    t.setFeed(ics(''))
    expect((await refresh()).body.added).toBe(1)
    const [gone] = await t.inbox()
    expect(gone).toMatchObject({ status: 'cancelled' })
    await t.client.post(`/api/calendar/inbox/${gone!.id}/ignore`)
    expect((await refresh()).body.added).toBe(0)
    expect((await t.events()).map((e) => e.title)).toEqual(['Sports day'])
  })

  it('always accepts from a trusted calendar, shows fetch problems, and removes its events on request', async () => {
    const t = await setUp()
    const sub = (await t.client.post<{ subscription: { id: string } }>('/api/calendar/subscriptions', { name: 'Fixtures', url: 'https://club.example.com/f.ics', autoAccept: true, tags: ['family'] })).body.subscription.id
    expect(await t.inbox()).toEqual([])
    expect((await t.events()).map((e) => e.title)).toEqual(['Term ends', 'Sports day'])

    t.setFail(true)
    const r = await t.client.post<{ subscription: { lastError: string } }>(`/api/calendar/subscriptions/${sub}/refresh`)
    expect(r.body.subscription.lastError).toBe('The calendar answered 503.')

    expect((await t.client.del(`/api/calendar/subscriptions/${sub}?removeEvents=1`)).status).toBe(204)
    expect(await t.events()).toEqual([])
    expect((await t.client.post('/api/calendar/subscriptions', { name: 'Bad', url: 'http://club.example.com/f.ics' })).status).toBe(400)
    expect((await t.client.post('/api/calendar/subscriptions', { name: 'Bad', url: 'https://10.0.0.5/f.ics' })).status).toBe(400)
  })

  it('refreshes every 6 hours and clears inbox items after 30 days', async () => {
    const t = await setUp()
    await t.client.post('/api/calendar/subscriptions', { name: 'School', url: 'https://school.example.com/c.ics' })
    t.setFeed(ics(vevent('t1', '20261201', 'Term ends') + vevent('s1', '20261205', 'Sports day') + vevent('n1', '20261210', 'Prize giving')))
    await syncDue(server.services)
    expect(await t.inbox()).toHaveLength(2) // not yet 6 hours
    server.clock.now += 6 * 3_600_000 + 1000
    await syncDue(server.services)
    server.clock.now += 31 * 86_400_000
    t.setFeed(ics(''))
    await syncDue(server.services)
    expect(server.services.db.prepare('SELECT COUNT(*) AS n FROM calendar_inbox').get()).toEqual({ n: 0 })
  })

  it('imports an .ics file into the inbox once; parents only', async () => {
    const t = await setUp()
    const file = ics(vevent('g1', '20261212', 'Year-end party') + vevent('g0', '20250101', 'Past'))
    expect((await t.client.post<{ added: number; skipped: number }>('/api/calendar/import', { ics: file })).body).toEqual({ added: 1, skipped: 1 })
    const [item] = await t.inbox()
    expect(item).toMatchObject({ source: 'Imported file', defaultTags: ['family'] })
    await t.client.post(`/api/calendar/inbox/${item!.id}/accept`, { tags: [t.sam] })
    expect((await t.events()).map((e) => [e.title, e.tags])).toEqual([['Year-end party', [t.sam]]])
    expect((await t.client.post<{ added: number }>('/api/calendar/import', { ics: file })).body.added).toBe(0)
    expect((await t.client.post('/api/calendar/import', { ics: 'not a calendar' })).status).toBe(400)

    const invite = await t.client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    expect((await kid.get('/api/calendar/inbox')).status).toBe(403)
    expect((await kid.post('/api/calendar/import', { ics: file })).status).toBe(403)
    expect((await kid.call('PUT', '/api/calendar/settings', { holidays: false })).status).toBe(403)
  })
})

describe('public holidays', () => {
  it('shows South African public holidays, unless switched off', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const dec = async () => (await client.get<{ events: { title: string; day: string; readOnly?: boolean }[] }>('/api/calendar/events?from=2026-12-01&to=2026-12-31')).body.events
    expect((await dec()).map((e) => `${e.day} ${e.title}`)).toEqual(['2026-12-16 Day of Reconciliation', '2026-12-25 Christmas Day', '2026-12-26 Day of Goodwill'])
    await client.call('PUT', '/api/calendar/settings', { holidays: false })
    expect(await dec()).toEqual([])
    expect((await client.get('/api/calendar/settings')).body).toEqual({ holidays: false })
  })
})
