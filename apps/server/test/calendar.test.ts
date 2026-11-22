import { afterEach, describe, expect, it } from 'vitest'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

interface Occurrence {
  eventId: string
  version: number
  day: string
  title: string
  allDay: boolean
  start: string
  end: string
  tags: string[]
  contactId: string | null
  changed: boolean
}

async function family() {
  server = await startServer()
  const { client } = await setUpAdmin(server)
  const self = (await client.get<{ user: { id: string } }>('/api/auth/session')).body.user
  const me = await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Parent', userId: self.id })
  const sam = await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })
  // A member (a teenager with an account): sees, adds and edits everything too.
  const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
  const kid = new Client(server.url)
  await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
  nextStep(server)
  await enrollTotp(server, kid)
  return { client, kid, me: me.body.profile.id, sam: sam.body.profile.id }
}

const list = async (c: Client, from: string, to: string) => (await c.get<{ events: Occurrence[] }>(`/api/calendar/events?from=${from}&to=${to}`)).body.events

describe('family calendar', () => {
  it('keeps events tagged by person or Family, sealed, and visible to everyone', async () => {
    const { client, kid, me, sam } = await family()
    const dentist = await client.post<{ id: string }>('/api/calendar/events', { title: 'Dentist', start: '2026-11-24T09:30', end: '2026-11-24T10:00', tags: [sam], location: 'Ballito' })
    expect(dentist.status).toBe(200)
    await kid.post('/api/calendar/events', { title: 'Braai at Gran’s', allDay: true, start: '2026-11-28', end: '2026-11-29', tags: ['family'] })
    await client.post('/api/calendar/events', { title: 'Book club', start: '2026-11-25T19:00', tags: [me] })

    const events = await list(kid, '2026-11-01', '2026-11-30')
    expect(events.map((e) => [e.title, e.tags])).toEqual([
      ['Dentist', [sam]],
      ['Book club', [me]],
      ['Braai at Gran’s', ['family']],
    ])
    // A two-day event shows on a range that starts on its second day.
    expect((await list(kid, '2026-11-29', '2026-11-29')).map((e) => e.title)).toEqual(['Braai at Gran’s'])
    // Nothing about events is readable in the database.
    const raw = JSON.stringify(server.services.db.prepare('SELECT * FROM events').all())
    expect(raw).not.toContain('Dentist')
    expect(raw).not.toContain('2026-11-24')

    // People and colours.
    const people = await kid.get<{ people: { id: string; displayName: string; colour: string | null }[]; me: string | null }>('/api/calendar/people')
    expect(people.body.people.map((p) => p.displayName)).toEqual(['Parent', 'Sam'])
    expect(people.body.me).toBeNull()
    expect((await kid.call('PUT', `/api/calendar/people/${sam}/colour`, { colour: '#e07a5f' })).status).toBe(403)
    expect((await client.call('PUT', `/api/calendar/people/${sam}/colour`, { colour: '#e07a5f' })).status).toBe(204)
    expect((await client.call('PUT', `/api/calendar/people/${sam}/colour`, { colour: 'red' })).status).toBe(400)
  })

  it('checks events', async () => {
    const { client, sam } = await family()
    const bad = async (body: Record<string, unknown>) => (await client.post('/api/calendar/events', { title: 'X', start: '2026-11-24T09:00', tags: [sam], ...body })).status
    expect(await bad({ tags: [] })).toBe(400)
    expect(await bad({ tags: ['someone-else'] })).toBe(400)
    expect(await bad({ start: '2026-11-31T09:00' })).toBe(400)
    expect(await bad({ start: '2026-11-24T25:00' })).toBe(400)
    expect(await bad({ end: '2026-11-23T09:00' })).toBe(400)
    expect(await bad({ allDay: true, start: '2026-11-24', end: '2028-01-01' })).toBe(400)
    expect(await bad({ repeat: { freq: 'hourly' } })).toBe(400)
    expect(await bad({ repeat: { freq: 'weekly', byDay: ['XX'] } })).toBe(400)
    expect(await bad({ repeat: { freq: 'daily', until: '2026-11-01' } })).toBe(400)
    expect(await bad({ contactId: 'gone' })).toBe(400)
    expect(await bad({})).toBe(200)
  })

  it('repeats, and changes one day, the days that follow, or the whole series', async () => {
    const { client, kid, sam } = await family()
    // Swimming every Tuesday and Thursday from 17 November 2026.
    const { body } = await client.post<{ id: string }>('/api/calendar/events', {
      title: 'Swimming',
      start: '2026-11-17T16:00',
      end: '2026-11-17T17:00',
      tags: [sam],
      repeat: { freq: 'weekly', byDay: ['TU', 'TH'] },
    })
    const days = async () => (await list(kid, '2026-11-01', '2026-12-10')).map((e) => `${e.day} ${e.start.slice(11)} ${e.title}`)
    expect(await days()).toEqual([
      '2026-11-17 16:00 Swimming',
      '2026-11-19 16:00 Swimming',
      '2026-11-24 16:00 Swimming',
      '2026-11-26 16:00 Swimming',
      '2026-12-01 16:00 Swimming',
      '2026-12-03 16:00 Swimming',
      '2026-12-08 16:00 Swimming',
      '2026-12-10 16:00 Swimming',
    ])
    // Just one day: later on 24 November.
    const change = (version: number, extra: Record<string, unknown>) =>
      kid.call('PUT', `/api/calendar/events/${body.id}`, { title: 'Swimming', start: '2026-11-24T17:30', end: '2026-11-24T18:30', tags: [sam], baseVersion: version, ...extra })
    expect((await change(1, { scope: 'one', day: '2026-11-24' })).status).toBe(204)
    // Someone editing from the old version is told.
    expect((await change(1, { scope: 'one', day: '2026-11-24' })).status).toBe(409)
    // Cancel 26 November.
    expect((await kid.del(`/api/calendar/events/${body.id}?scope=one&day=2026-11-26`)).status).toBe(204)
    // From 1 December, Wednesdays instead.
    expect(
      (
        await kid.call('PUT', `/api/calendar/events/${body.id}`, {
          title: 'Swimming (new times)',
          start: '2026-12-02T15:00',
          end: '2026-12-02T16:00',
          tags: [sam],
          repeat: { freq: 'weekly', byDay: ['WE'] },
          baseVersion: 3,
          scope: 'following',
          day: '2026-12-01',
        })
      ).status,
    ).toBe(204)
    expect(await days()).toEqual([
      '2026-11-17 16:00 Swimming',
      '2026-11-19 16:00 Swimming',
      '2026-11-24 17:30 Swimming',
      '2026-12-02 15:00 Swimming (new times)',
      '2026-12-09 15:00 Swimming (new times)',
    ])
    // Deleting from a day on ends the series there.
    const all = await list(kid, '2026-12-01', '2026-12-31')
    await kid.del(`/api/calendar/events/${all[0]!.eventId}?scope=following&day=2026-12-09`)
    expect((await list(kid, '2026-12-01', '2026-12-31')).map((e) => e.day)).toEqual(['2026-12-02'])
  })

  it('sends one event or a selection out as .ics, notes only when chosen', async () => {
    const { client, me, sam } = await family()
    const { body } = await client.post<{ id: string }>('/api/calendar/events', {
      title: 'Swimming',
      start: '2026-11-17T16:00',
      end: '2026-11-17T17:00',
      tags: [sam],
      notes: 'Bring goggles',
      repeat: { freq: 'weekly', byDay: ['TU'], count: 4 },
    })
    await client.del(`/api/calendar/events/${body.id}?scope=one&day=2026-11-24`)
    await client.post('/api/calendar/events', { title: 'Holiday', allDay: true, start: '2026-12-14', end: '2026-12-18', tags: ['family'] })
    await client.post('/api/calendar/events', { title: 'Work trip', allDay: true, start: '2026-12-01', tags: [me] })
    const get = (file: string) => fetch(`${server.url}/api/calendar/export/${file}`, { headers: { cookie: client.cookie } })

    const one = await (await get(`event-${body.id}.ics`)).text()
    expect(one).toContain('DTSTART;TZID=Africa/Johannesburg:20261117T160000\r\n')
    expect(one).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4\r\n')
    expect(one).toContain('EXDATE;TZID=Africa/Johannesburg:20261124T160000\r\n')
    expect(one).not.toContain('goggles')
    expect(await (await get(`event-${body.id}-notes.ics`)).text()).toContain('DESCRIPTION:Bring goggles')

    // Sam's events (and Family ones) for December: the holiday ends the day after, as iCalendar expects.
    const sams = await (await get(`range-20261201-20261231-${sam}.ics`)).text()
    expect(sams.match(/BEGIN:VEVENT/g)).toHaveLength(3) // swimming on 1 and 8 December, and the holiday
    expect(sams).toContain('DTSTART;VALUE=DATE:20261214\r\nDTEND;VALUE=DATE:20261219\r\n')
    expect(sams).not.toContain('Work trip')
    expect((await get('range-20261201-20281231-all.ics')).status).toBe(400)
    expect((await get('../etc.ics')).status).toBe(404)
  })

  it('shows a contact link to parents only', async () => {
    const { client, kid, sam } = await family()
    const dr = await client.post<{ contact: { id: string } }>('/api/contacts', { name: 'Dr Naidoo', category: 'health' })
    await client.post('/api/calendar/events', { title: 'Check-up', start: '2026-11-24T09:00', tags: [sam], contactId: dr.body.contact.id })
    expect((await list(client, '2026-11-24', '2026-11-24'))[0]!.contactId).toBe(dr.body.contact.id)
    expect((await list(kid, '2026-11-24', '2026-11-24'))[0]!.contactId).toBeNull()
    expect((await kid.get('/api/calendar/events?from=2026-01-01&to=2027-12-31')).status).toBe(400)
  })
})
