import { afterEach, describe, expect, it } from 'vitest'
import { addMonths, cleanBill, dueDates, monthlyCents, nextDue, noticeDeadline, overdue, rand, reviewDue, type Bill } from '../src/household.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

const bill = (over: Record<string, unknown> = {}): Bill => cleanBill({ name: 'Netflix', amount: 19900, unit: 'month', firstDue: '2026-01-31', ...over }, '2026-01-01')

describe('bill dates and money', () => {
  it('keep to the month end, and step by weeks, months and years', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28')
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29')
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28')
    expect(dueDates(bill(), '2026-01-01', '2026-04-30')).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30'])
    expect(dueDates(bill({ unit: 'week', every: 2, firstDue: '2026-11-02' }), '2026-11-01', '2026-11-30')).toEqual(['2026-11-02', '2026-11-16', '2026-11-30'])
    expect(nextDue(bill({ unit: 'year', firstDue: '2025-03-15' }), '2026-11-24')).toBe('2027-03-15')
    expect(nextDue(bill({ unit: 'once', firstDue: '2026-10-01' }), '2026-11-24')).toBeNull()
    expect(nextDue(bill({ status: 'cancelled', cancelledOn: '2026-11-01' }), '2026-11-24')).toBeNull()
  })

  it('work out the monthly cost and format rand', () => {
    expect(monthlyCents(bill({ unit: 'year', amount: 120000 }))).toBe(10000)
    expect(monthlyCents(bill({ unit: 'week', amount: 10000 }))).toBe(43333)
    expect(monthlyCents(bill({ unit: 'month', every: 2, amount: 50000 }))).toBe(25000)
    expect(monthlyCents(bill({ unit: 'once' }))).toBe(0)
    expect(rand(123456789)).toBe('R 1 234 567.89')
    expect(rand(5)).toBe('R 0.05')
  })

  it('find overdue bills: paid by hand only, since they were added', () => {
    const manual = bill({ method: 'eft', firstDue: '2025-06-15', payments: [{ due: '2026-10-15', paidOn: '2026-10-14', amount: 19900 }] })
    // Added 2026-01-01: earlier due dates never count. October was paid.
    expect(overdue(manual, '2026-11-24')).toEqual(['2026-11-15', '2026-09-15', '2026-08-15', '2026-07-15', '2026-06-15', '2026-05-15', '2026-04-15', '2026-03-15', '2026-02-15', '2026-01-15'])
    // A debit order is paid unless a problem is marked, and the problem clears once it is paid.
    expect(overdue(bill({ method: 'debit' }), '2026-11-24')).toEqual([])
    expect(overdue(bill({ method: 'card' }), '2026-11-24')).toEqual([])
    expect(overdue(bill({ method: 'debit', problems: [{ due: '2026-10-31', note: 'Bounced' }] }), '2026-11-24')).toEqual(['2026-10-31'])
    expect(overdue(bill({ method: 'debit', problems: [{ due: '2026-10-31', note: '' }], payments: [{ due: '2026-10-31', paidOn: '2026-11-02', amount: 19900 }] }), '2026-11-24')).toEqual([])
  })

  it('work out notice deadlines and reviews', () => {
    expect(noticeDeadline(bill({ contractEnd: '2027-02-28', noticeDays: 30 }))).toBe('2027-01-29')
    expect(noticeDeadline(bill({ contractEnd: '2027-02-28' }))).toBeNull()
    expect(reviewDue(bill({ type: 'subscription', reviewMonths: 12 }))).toBe('2027-01-01')
    expect(reviewDue(bill({ type: 'subscription', reviewMonths: 12, reviewedOn: '2026-06-01' }))).toBe('2027-06-01')
    expect(reviewDue(bill({ reviewMonths: 12 }))).toBeNull()
  })

  it('refuse what does not make sense', () => {
    for (const over of [{ name: '' }, { amount: 12.5 }, { amount: -1 }, { unit: 'fortnight' }, { firstDue: '2026-02-30' }, { method: 'cheque' }, { remind: [400] }, { users: ['../x'] }, { payeeId: 'a b' }]) {
      expect(() => bill(over)).toThrow()
    }
  })
})

async function family() {
  server = await startServer() // 2026-11-20 12:00 UTC: 14:00 in Johannesburg
  const { client } = await setUpAdmin(server)
  const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
  const kid = new Client(server.url)
  await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
  nextStep(server)
  await enrollTotp(server, kid)
  return { client, kid }
}

describe('the Money API', () => {
  it('keeps accounts, bills and invoices sealed, for parents only', async () => {
    const { client, kid } = await family()
    const account = await client.post<{ item: { id: string } }>('/api/money/accounts', { item: { bank: 'Capitec', nickname: 'Joint' } })
    expect(account.status).toBe(200)
    const added = await client.post<{ item: { id: string; version: number; addedOn: string } }>('/api/money/bills', {
      item: { name: 'Municipal rates', amount: 245000, unit: 'month', firstDue: '2026-11-25', method: 'eft', accountId: account.body.item.id, remind: [3, 0] },
    })
    expect(added.body.item.addedOn).toBe('2026-11-20')
    await client.post('/api/money/invoices', { item: { from: 'Plumber Joe', number: 'INV-17', date: '2026-11-10', due: '2026-11-19', amount: 85000 } })

    // Nothing readable in the database: only the kind of item.
    const raw = JSON.stringify(server.services.db.prepare('SELECT * FROM household').all())
    for (const word of ['Capitec', 'Municipal', 'Plumber', '245000']) expect(raw).not.toContain(word)

    const money = await client.get<{ today: string; bills: { name: string; nextDue: string; monthly: number; overdue: string[] }[]; accounts: unknown[]; invoices: unknown[] }>('/api/money')
    expect(money.body.today).toBe('2026-11-20')
    expect(money.body.bills[0]).toMatchObject({ name: 'Municipal rates', nextDue: '2026-11-25', monthly: 245000, overdue: [] })

    // Coming up, for parents: the bill and the overdue invoice, with amounts.
    const up = await client.get<{ items: { title: string; detail: string; daysLeft: number; category: string }[] }>('/api/reminders/upcoming')
    expect(up.body.items).toEqual([
      expect.objectContaining({ title: 'Invoice: Plumber Joe (INV-17): overdue', detail: 'R 850.00', daysLeft: -1, category: 'household' }),
      expect.objectContaining({ title: 'Municipal rates', detail: 'R 2 450.00', daysLeft: 5 }),
    ])

    // Members get nothing.
    for (const r of [kid.get('/api/money'), kid.post('/api/money/bills', { item: {} }), kid.get('/api/money/folder')]) expect((await r).status).toBe(403)
    expect((await kid.get<{ items: unknown[] }>('/api/reminders/upcoming')).body.items).toEqual([])

    // Editing needs the version it was based on; the day added never changes.
    const id = added.body.item.id
    const changed = await client.call('PUT', `/api/money/bills/${id}`, { baseVersion: 1, item: { ...added.body.item, amount: 255000, addedOn: '2020-01-01' } })
    expect(changed.status).toBe(200)
    expect((changed.body as { item: { addedOn: string } }).item.addedOn).toBe('2026-11-20')
    expect((await client.call('PUT', `/api/money/bills/${id}`, { baseVersion: 1, item: added.body.item })).status).toBe(409)

    // Removing the account unlinks the bill.
    expect((await client.del(`/api/money/accounts/${account.body.item.id}`)).status).toBe(204)
    expect((await client.get<{ bills: { accountId: string | null }[] }>('/api/money')).body.bills[0]!.accountId).toBeNull()
    expect((await client.post('/api/money/bills', { item: { name: 'x', amount: 1, unit: 'month' } })).status).toBe(400)
    expect((await client.post('/api/money/cars', { item: {} })).status).toBe(404)
  })

  it('reminds with generic text: due, overdue, notice deadlines and trials', async () => {
    const { client } = await family()
    const { dueMessagesFor, runReminders } = await import('../src/notifications.ts')
    await client.post('/api/money/bills', { item: { name: 'School fees', amount: 300000, unit: 'month', firstDue: '2026-11-23', method: 'eft', remind: [3, 0] } })
    await client.post('/api/money/bills', { item: { type: 'subscription', name: 'Showmax', amount: 9900, unit: 'month', firstDue: '2026-12-01', method: 'card', trialEnd: '2026-11-22' } })
    await client.post('/api/money/bills', { item: { name: 'Cellphone contract', amount: 59900, unit: 'month', firstDue: '2026-12-01', method: 'debit', contractEnd: '2026-12-31', noticeDays: 30 } })
    const parent = (await client.get<{ user: { id: string } }>('/api/auth/session')).body.user.id
    const bodies = dueMessagesFor(server.services, parent, '2026-11-20').map((m) => m.body)
    expect(bodies).toEqual(expect.arrayContaining(['A bill is due. Tap to see.', 'A free trial ends soon. Tap to see.', 'A renewal deadline is coming up. Tap to see.']))
    for (const b of bodies) expect(b).not.toMatch(/School|Showmax|Cellphone|R /)
    // Sent once, from the sending hour.
    expect(await runReminders(server.services)).toBe(3)
    expect(await runReminders(server.services)).toBe(0)

    // Not marked paid by the day after: overdue, once.
    server.clock.now += 4 * 86_400_000 // 24 November
    expect(dueMessagesFor(server.services, parent, '2026-11-24').map((m) => m.body)).toContain('A bill is overdue. Tap to see.')
  })

  it('keeps a parents-only Household folder', async () => {
    const { client, kid } = await family()
    const folder = (await client.get<{ folderId: string }>('/api/money/folder')).body.folderId
    expect((await client.get<{ folderId: string }>('/api/money/folder')).body.folderId).toBe(folder)
    const files = await kid.get<{ items: { id: string }[] }>('/api/files')
    expect(files.body.items.map((i) => i.id)).not.toContain(folder)
    expect((await client.call('PATCH', `/api/files/${folder}`, { name: 'Other' })).status).toBe(400)
    expect((await client.del(`/api/files/${folder}`)).status).toBe(400)
  })
})
