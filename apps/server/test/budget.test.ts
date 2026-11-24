import { afterEach, describe, expect, it } from 'vitest'
import { addMonthsTo, categoryForBill, plannedFor, cleanPlanned, DEFAULT_CATEGORIES, plannedShare, sinkingBalances, snowball, spending, type MonthPlan } from '../src/budget.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

describe('budget arithmetic', () => {
  it('steps through months', () => {
    expect(addMonthsTo('2026-11', 2)).toBe('2027-01')
    expect(addMonthsTo('2026-01', -1)).toBe('2025-12')
  })

  it('spreads a planned expense over the months saving for it, the rest in its month', () => {
    const camp = cleanPlanned({ name: 'Camp', amount: 120000, month: '2027-07', saveFrom: '2027-02' })
    const months = ['2027-01', '2027-02', '2027-03', '2027-06', '2027-07', '2027-08']
    expect(months.map((m) => plannedShare(camp, m))).toEqual([0, 20000, 20000, 20000, 20000, 0])
    const odd = cleanPlanned({ name: 'Uniform', amount: 100000, month: '2027-01', saveFrom: '2026-11' })
    expect(['2026-11', '2026-12', '2027-01'].map((m) => plannedShare(odd, m))).toEqual([33333, 33333, 33334])
    expect(plannedShare(cleanPlanned({ name: 'Tour', amount: 5000, month: '2027-03' }), '2027-03')).toBe(5000)
    expect(plannedShare({ ...camp, done: true }, '2027-03')).toBe(0)
    expect(() => cleanPlanned({ name: 'x', amount: 1, month: '2027-01', saveFrom: '2027-05' })).toThrow()
  })

  it('pays debts off smallest balance first, rolling each payment into the next', () => {
    const plan = snowball(
      [
        { id: 'car', balance: 5_000_000, rate: 0, minimum: 300_000 },
        { id: 'store', balance: 300_000, rate: 0, minimum: 50_000 },
        { id: 'card', balance: 1_200_000, rate: 0, minimum: 100_000 },
      ],
      100_000,
      '2027-01',
    )
    // R5 500 a month in all. The store card first (R1 500 a month: done in February), then the card
    // (R2 500 a month from March: done in June), then the car gets everything (done in December).
    expect(plan.order.map((o) => [o.id, o.payment, o.payoffMonth])).toEqual([
      ['store', 150_000, '2027-02'],
      ['card', 100_000, '2027-06'],
      ['car', 300_000, '2027-12'],
    ])
    expect(plan.debtFree).toBe('2027-12')
    // Payments that never catch up with the interest: never debt-free.
    expect(snowball([{ id: 'x', balance: 1_000_000, rate: 30, minimum: 10_000 }], 0, '2027-01').debtFree).toBeNull()
  })

  it('carries sinking funds over from month to month', () => {
    const cats = DEFAULT_CATEGORIES.map((c) => (c.id === 'holidays' ? { ...c, opening: 50_000 } : c))
    const plan = (month: string, amount: number): MonthPlan => ({ month, income: [], lines: [{ id: 'l', categoryId: 'holidays', label: '', amount, source: 'manual' }], moves: [], notes: '' })
    const spent = spending([
      { month: '2027-02', item: { date: '2027-02-10', description: 'Flights', amount: -120_000, accountId: null, categoryId: 'holidays', note: '' } },
      { month: '2027-02', item: { date: '2027-02-11', description: 'Refund', amount: 20_000, accountId: null, categoryId: 'holidays', note: '' } },
      { month: '2027-02', item: { date: '2027-02-12', description: 'To savings', amount: -999_999, accountId: null, categoryId: 'transfer', note: '' } },
    ])
    expect(spent.get('2027-02')!.get('holidays')).toBe(100_000)
    expect(sinkingBalances(cats, [plan('2027-01', 100_000), plan('2027-02', 100_000)], spent, '2027-02').holidays).toBe(50_000 + 200_000 - 100_000)
  })

  it('moves money between categories to cover overspending, and the plan still adds up', () => {
    const plan: MonthPlan = {
      month: '2027-01',
      income: [],
      lines: [
        { id: 'a', categoryId: 'groceries', label: '', amount: 500_000, source: 'manual' },
        { id: 'b', categoryId: 'eating-out', label: '', amount: 100_000, source: 'manual' },
      ],
      moves: [{ date: '2027-01-20', from: 'eating-out', to: 'groceries', amount: 40_000, note: 'Big shop' }],
      notes: '',
    }
    expect([plannedFor(plan, 'groceries'), plannedFor(plan, 'eating-out')]).toEqual([540_000, 60_000])
  })

  it('puts bills in budget categories by name', () => {
    expect(categoryForBill(DEFAULT_CATEGORIES, 'Phone and internet')).toBe('utilities')
    expect(categoryForBill(DEFAULT_CATEGORIES, 'Insurance')).toBe('insurance')
    expect(categoryForBill(DEFAULT_CATEGORIES, 'Something new')).toBe('misc')
  })
})

describe('the budget API', () => {
  it('starts a month from bills, planned expenses and debts; for parents only; sealed', async () => {
    server = await startServer() // 2026-11-20
    const { client } = await setUpAdmin(server)
    const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)

    await client.post('/api/money/bills', { item: { name: 'Cellphone', category: 'Phone and internet', amount: 59900, unit: 'month', firstDue: '2026-10-25', method: 'debit' } })
    await client.post('/api/budget/planned', { item: { name: 'School camp', amount: 120000, month: '2027-02', saveFrom: '2026-12', categoryId: 'school', tag: 'school' } })
    await client.post('/api/budget/debts', { item: { name: 'Store card', balance: 300000, balanceOn: '2026-11-01', rate: 0, minimum: 50000 } })

    const started = await client.post<{ plan: MonthPlan }>('/api/budget/months/2026-12/start')
    expect(started.status).toBe(200)
    expect(started.body.plan.lines.map((l) => [l.label, l.categoryId, l.amount])).toEqual([
      ['Cellphone', 'utilities', 59900],
      ['Saving for School camp', 'school', 40000],
      ['Store card', 'debt', 50000],
    ])
    expect((await client.post('/api/budget/months/2026-12/start')).status).toBe(409)

    // Every rand gets a job: add income and save the plan.
    const plan = { ...started.body.plan, income: [{ id: 'i1', label: 'Salary', amount: 2_000_000 }] }
    expect((await client.call('PUT', '/api/budget/months/2026-12', { plan, baseVersion: 1 })).status).toBe(200)
    expect((await client.call('PUT', '/api/budget/months/2026-12', { plan, baseVersion: 1 })).status).toBe(409)

    // Spending typed in, against the plan.
    await client.post('/api/budget-transactions', { item: { date: '2026-12-03', description: 'Woolworths', amount: -85000, categoryId: 'groceries' } })
    await client.post('/api/budget-transactions', { item: { date: '2026-12-25', description: 'Salary', amount: 2_000_000, categoryId: 'income' } })
    const dec = await client.get<{ spent: Record<string, number>; incomeActual: number; sinking: Record<string, number>; snowball: { debtFree: string } }>('/api/budget?month=2026-12')
    expect(dec.body.spent.groceries).toBe(85000)
    expect(dec.body.incomeActual).toBe(2_000_000)
    expect(dec.body.sinking.school).toBe(40000)
    // R3 000 at R500 a month from November: paid off in April.
    expect(dec.body.snowball.debtFree).toBe('2027-04')

    const raw = JSON.stringify([server.services.db.prepare('SELECT * FROM budget').all(), server.services.db.prepare('SELECT * FROM transactions').all()])
    for (const w of ['Woolworths', 'camp', 'Store card', 'Salary', '2000000']) expect(raw).not.toContain(w)

    const summary = await client.get<{ months: { month: string; byCategory: Record<string, { planned: number; spent: number }> }[] }>('/api/budget/summary?month=2026-12')
    expect(summary.body.months).toHaveLength(12)
    expect(summary.body.months[11]!.byCategory.groceries).toEqual({ planned: 0, spent: 85000 })

    for (const r of [kid.get('/api/budget'), kid.post('/api/budget/planned', { item: {} }), kid.post('/api/budget-transactions', { item: {} })]) expect((await r).status).toBe(403)
  })

  it('reminds to plan next month from the 25th, once the budget is in use', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const { allItems } = await import('../src/notifications.ts')
    expect(allItems(server.services).filter((i) => i.key.startsWith('bp:'))).toEqual([])
    await client.post('/api/budget/months/2026-11/start')
    expect(allItems(server.services).find((i) => i.key === 'bp:2026-12')).toMatchObject({ title: 'Plan next month’s budget', due: { date: '2026-11-25' } })
    await client.post('/api/budget/months/2026-12/start')
    expect(allItems(server.services).filter((i) => i.key.startsWith('bp:'))).toEqual([])
  })
})

describe('importing a bank export', () => {
  it('skips what was already imported, keeps real repeats, and categorises by the rules', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const account = await client.post<{ item: { id: string } }>('/api/money/accounts', { item: { bank: 'Capitec', nickname: 'Joint' } })
    await client.post('/api/budget/rules', { item: { match: 'Woolworths', categoryId: 'groceries' } })
    await client.post('/api/budget/rules', { item: { match: 'woolworths food', categoryId: 'eating-out' } })
    const week1 = [
      { date: '2026-11-02', description: 'WOOLWORTHS SEA POINT', amount: -45000 },
      { date: '2026-11-02', description: 'SEATTLE COFFEE', amount: -4500 },
      { date: '2026-11-02', description: 'SEATTLE COFFEE', amount: -4500 }, // two coffees: both count
      { date: '2026-11-03', description: 'Woolworths Food Cafe', amount: -12000 },
    ]
    const first = await client.post<{ added: number; skipped: number; uncategorised: number }>('/api/budget-import', { accountId: account.body.item.id, rows: week1 })
    expect(first.body).toEqual({ added: 4, skipped: 0, uncategorised: 2 })
    // An overlapping export: the first four again, and one new.
    const again = await client.post<{ added: number; skipped: number }>('/api/budget-import', {
      accountId: account.body.item.id,
      rows: [...week1, { date: '2026-11-05', description: 'SALARY', amount: 2_500_000 }],
    })
    expect(again.body).toMatchObject({ added: 1, skipped: 4 })
    const nov = await client.get<{ transactions: { description: string; categoryId: string | null }[]; rules: unknown[] }>('/api/budget?month=2026-11')
    expect(nov.body.transactions).toHaveLength(5)
    expect(nov.body.transactions.find((t) => t.description === 'WOOLWORTHS SEA POINT')!.categoryId).toBe('groceries')
    // The longer match wins.
    expect(nov.body.transactions.find((t) => t.description === 'Woolworths Food Cafe')!.categoryId).toBe('eating-out')
    expect(nov.body.rules).toHaveLength(2)
    // A new rule, applied to what is still uncategorised.
    await client.post('/api/budget/rules', { item: { match: 'seattle', categoryId: 'eating-out' } })
    expect((await client.post<{ changed: number }>('/api/budget-rules/apply')).body.changed).toBe(2)
    // Nothing readable, and no plain fingerprint input.
    const raw = JSON.stringify(server.services.db.prepare('SELECT * FROM transactions').all())
    for (const w of ['WOOLWORTHS', 'SEATTLE', 'SALARY', '45000']) expect(raw).not.toContain(w)
    expect((await client.post('/api/budget-import', { accountId: 'nope', rows: week1 })).status).toBe(400)
    expect((await client.post('/api/budget-import', { rows: [] })).status).toBe(400)
  })

  it('keeps one saved format per header row', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const mapping = { headerRow: 0, date: 0, dateStyle: 'ymd', description: [1], amount: 2, decimal: '.' }
    await client.post('/api/budget-formats', { name: 'Capitec', signature: 'date|description|amount', mapping })
    await client.post('/api/budget-formats', { name: 'Capitec (new layout)', signature: 'date|description|amount', mapping: { ...mapping, dateStyle: 'dmy' } })
    const list = await client.get<{ formats: { name: string; mapping: { dateStyle: string } }[] }>('/api/budget-formats')
    expect(list.body.formats).toEqual([expect.objectContaining({ name: 'Capitec (new layout)', mapping: expect.objectContaining({ dateStyle: 'dmy' }) })])
    expect((await client.post('/api/budget-formats', { name: 'x', signature: 'a', mapping: { ...mapping, amount: null } })).status).toBe(400)
  })
})
