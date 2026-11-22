import { afterEach, describe, expect, it } from 'vitest'
import { normalise } from '../src/routes/contacts.ts'
import { parseVCards, readVCardDate, toICS, toLabelsCsv, toVCard } from '../src/vcard.ts'
import { setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

// A Google Contacts export, an Apple one (year-less birthday, related names,
// an anniversary), and an old Android vCard 2.1 with quoted-printable text.
const GOOGLE = `BEGIN:VCARD\r
VERSION:3.0\r
FN:Thandi Dlamini\r
N:Dlamini;Thandi;;;\r
EMAIL;TYPE=INTERNET:thandi@example.com\r
TEL;TYPE=CELL:+27 82 555 0199\r
ADR;TYPE=HOME:;;12 Oak Ave;Durban;KZN;4001;South Africa\r
BDAY:1986-04-03\r
item1.X-ABDATE:2012-12-15\r
item1.X-ABLabel:_$!<Anniversary>!$_\r
item2.X-ABRELATEDNAMES:Lwazi Dlamini\r
item2.X-ABLabel:_$!<Child>!$_\r
NOTE:Met at varsity\\, 2005\r
END:VCARD\r
`
const APPLE = `BEGIN:VCARD
VERSION:3.0
N:Dlamini;Lwazi;;;
FN:Lwazi Dlamini
BDAY;X-APPLE-OMIT-YEAR=1604:1604-07-09
item1.X-ABRELATEDNAMES:Thandi Dlamini
item1.X-ABLabel:_$!<Mother>!$_
END:VCARD
`
const ANDROID = `BEGIN:VCARD
VERSION:2.1
N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=5A=6F=C3=AB;;;;
FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Zo=C3=
=AB
TEL;CELL:082-555-0123
TEL;HOME:not a number
BDAY:--0229
END:VCARD
`

describe('vCard import', () => {
  it('reads Google, Apple and old Android exports', () => {
    const [t, l, z] = parseVCards(GOOGLE + APPLE + ANDROID)
    expect(t).toMatchObject({
      name: 'Thandi Dlamini',
      emails: ['thandi@example.com'],
      phones: [{ label: 'mobile', number: '+27 82 555 0199' }],
      address: '12 Oak Ave\nDurban\nKZN\n4001\nSouth Africa',
      note: 'Met at varsity, 2005',
      dates: [
        { kind: 'birthday', date: '1986-04-03' },
        { kind: 'anniversary', date: '2012-12-15' },
      ],
      related: [{ name: 'Lwazi Dlamini', kind: 'child' }],
    })
    expect(l).toMatchObject({ name: 'Lwazi Dlamini', dates: [{ kind: 'birthday', date: '--07-09' }], related: [{ name: 'Thandi Dlamini', kind: 'parent' }] })
    expect(z).toMatchObject({ name: 'Zoë', phones: [{ label: 'mobile', number: '082-555-0123' }], dates: [{ kind: 'birthday', date: '--02-29' }] })
  })

  it('reads the date forms apps write, and refuses impossible ones', () => {
    expect(readVCardDate('19860403')).toBe('1986-04-03')
    expect(readVCardDate('1986-04-03T00:00:00Z')).toBe('1986-04-03')
    expect(readVCardDate('--0403')).toBe('--04-03')
    expect(readVCardDate('1604-04-03', { 'X-APPLE-OMIT-YEAR': ['1604'] })).toBe('--04-03')
    expect(readVCardDate('1986-02-30')).toBeNull()
    expect(readVCardDate('April 3')).toBeNull()
  })
})

describe('exports', () => {
  it('writes dates and related names the way contacts apps read them, and reads its own output back', () => {
    const c = normalise({
      name: 'Gran',
      dates: [
        { id: 'a', kind: 'birthday', label: '', date: '--11-27', remind: 'week', remindFor: 'all' },
        { id: 'b', kind: 'anniversary', label: '', date: '1970-06-01', remind: 'off', remindFor: 'all' },
      ],
    })
    const card = toVCard(c, false, [{ name: 'Thandi', kind: 'child', label: '' }])
    expect(card).toContain('BDAY:--11-27\r\n')
    expect(card).toContain('item1.X-ABDATE:1970-06-01\r\nitem1.X-ABLabel:_$!<Anniversary>!$_\r\n')
    expect(card).toContain('item2.X-ABRELATEDNAMES:Thandi\r\nitem2.X-ABLabel:_$!<Child>!$_\r\n')
    const [back] = parseVCards(card)
    expect(back).toMatchObject({ name: 'Gran', dates: [{ kind: 'birthday', date: '--11-27' }, { kind: 'anniversary', date: '1970-06-01' }], related: [{ name: 'Thandi', kind: 'child' }] })
  })

  it('writes yearly calendar events, with 29 February on the last day of February', () => {
    const ics = toICS(
      [
        { uid: 'x@family-hub', summary: 'Gran’s birthday', date: '1946-11-27' },
        { uid: 'y@family-hub', summary: 'Leap birthday', date: '--02-29' },
      ],
      Date.UTC(2026, 10, 20),
      2026,
    )
    expect(ics).toContain('BEGIN:VCALENDAR\r\n')
    expect(ics).toContain('DTSTART;VALUE=DATE:19461127\r\nRRULE:FREQ=YEARLY\r\n')
    expect(ics).toContain('DTSTART;VALUE=DATE:20260229\r\nRRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1\r\n')
    expect(ics).toContain('DTSTAMP:20261120T000000Z')
  })

  it('writes address labels that cannot run as spreadsheet formulas', () => {
    const csv = toLabelsCsv([
      { name: 'Gran', address: '1 Beach Rd\nBallito' },
      { name: '=HYPERLINK("x")', address: '2 Main St' },
      { name: 'No address', address: '' },
    ])
    expect(csv).toBe('﻿"Name","Address"\r\n"Gran","1 Beach Rd\nBallito"\r\n"\'=HYPERLINK(""x"")","2 Main St"\r\n')
  })
})

describe('import, export and groups through the API', () => {
  it('previews an import without storing it, marks look-alikes, then adds the chosen people and links them', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    await client.post('/api/contacts', { name: 'Someone', phones: [{ label: 'mobile', number: '082 555 0123' }] })
    const preview = await client.post<{ contacts: { name: string; duplicateOf: string | null }[] }>('/api/contacts/import/preview', { vcf: GOOGLE + APPLE + ANDROID })
    expect(preview.status).toBe(200)
    expect(preview.body.contacts.map((c) => [c.name, Boolean(c.duplicateOf)])).toEqual([
      ['Thandi Dlamini', false],
      ['Lwazi Dlamini', false],
      ['Zoë', true], // same phone number as "Someone"
    ])
    expect((server.services.db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n).toBe(1)
    expect((await client.post('/api/contacts/import/preview', { vcf: 'hello' })).status).toBe(400)

    const done = await client.post<{ added: number; links: number; skipped: unknown[] }>('/api/contacts/import', { contacts: preview.body.contacts.slice(0, 2), category: 'family' })
    expect(done.body).toEqual({ added: 2, links: 1, skipped: [] })
    const list = await client.get<{ contacts: { name: string; category: string; dates: { kind: string; remind: string }[] }[]; relations: { kind: string }[] }>('/api/contacts')
    const thandi = list.body.contacts.find((c) => c.name === 'Thandi Dlamini')!
    expect(thandi.category).toBe('family')
    // Birthdays remind a week before; other dates are kept without reminders.
    expect(thandi.dates.map((d) => [d.kind, d.remind])).toEqual([
      ['birthday', 'week'],
      ['anniversary', 'off'],
    ])
    expect(list.body.relations).toHaveLength(1)
  })

  it('exports everyone or a group as vCards, calendar dates and address labels', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const group = await client.post<{ group: { id: string } }>('/api/contacts/groups', { name: 'Christmas cards' })
    expect((await client.post('/api/contacts/groups', { name: 'christmas cards' })).status).toBe(409)
    const gran = await client.post<{ contact: { id: string; groups: string[] } }>('/api/contacts', {
      name: 'Gran',
      address: '1 Beach Rd',
      groups: [group.body.group.id, 'not-a-group'],
      dates: [{ kind: 'birthday', date: '1946-11-27' }],
    })
    expect(gran.body.contact.groups).toEqual([group.body.group.id])
    await client.post('/api/contacts', { name: 'Plumber', address: '3 Pipe St', note: 'Secret note' })

    const get = (file: string) => fetch(`${server.url}/api/contacts/export/${file}`, { headers: { cookie: client.cookie } })
    const vcf = await get(`group-${group.body.group.id}.vcf`)
    expect(vcf.headers.get('content-type')).toBe('text/vcard; charset=utf-8')
    expect((await vcf.text()).match(/BEGIN:VCARD/g)).toHaveLength(1)
    const all = await get('all.vcf')
    const allText = await all.text()
    expect(allText.match(/BEGIN:VCARD/g)).toHaveLength(2)
    expect(allText).not.toContain('Secret note')
    expect(allText).toContain('BDAY:1946-11-27')
    const ics = await get('all-dates.ics')
    expect(ics.headers.get('content-type')).toBe('text/calendar; charset=utf-8')
    expect(await ics.text()).toContain('SUMMARY:Gran’s birthday')
    const csv = await get(`group-${group.body.group.id}-labels.csv`)
    expect(csv.headers.get('content-disposition')).toContain('Christmas%20cards%20addresses.csv')
    expect(await csv.text()).not.toContain('Pipe St')
    expect((await get('all-dates.vcf')).status).toBe(404)
    expect((await get(`${gran.body.contact.id}-labels.csv`)).status).toBe(404)
    expect((await get('group-AAAAAAAAAAAAAAAA.vcf')).status).toBe(404)

    // Deleting the group takes people out of it, not the people.
    await client.del(`/api/contacts/groups/${group.body.group.id}`)
    const after = await client.get<{ contacts: { groups: string[] }[]; groups: unknown[] }>('/api/contacts')
    expect(after.body.groups).toEqual([])
    expect(after.body.contacts.every((c) => c.groups.length === 0)).toBe(true)
    expect(JSON.stringify(server.services.db.prepare('SELECT * FROM contact_groups').all())).not.toContain('Christmas')
  })
})
