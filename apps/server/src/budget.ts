/**
 * The budget (phase 6c, part 1): a zero-based monthly plan, planned
 * expenses, sinking funds, spending, debts paid off smallest balance first,
 * and the milestones. Sealed with the server key (docs/DATA-PROTECTION.md,
 * "Household admin"). Amounts are whole cents; months are "YYYY-MM".
 *
 * A month's plan is a list of lines (income, and an amount for each job the
 * money has). Starting a month fills it from last month, the bills due, the
 * planned expenses and the debt payments, so "every rand gets a job" starts
 * from what is already known.
 */
import type { Services } from './app.ts'
import { addDays, bad, cents, date, dueDates, int, list, obj, oneOf, readAll, text, type Bill } from './household.ts'
import type { ReminderItem } from './notifications.ts'
import { localNow } from './schedule.ts'

// ---- what is stored ----------------------------------------------------------------------------

export type Group = 'giving' | 'saving' | 'essentials' | 'debt' | 'lifestyle'
export const GROUPS: Group[] = ['giving', 'saving', 'essentials', 'debt', 'lifestyle']
export type Role = '' | 'emergency' | 'retirement' | 'education'

export interface Category {
  id: string
  name: string
  group: Group
  /** Saves up: what is not spent carries over to next month. */
  sinking: boolean
  role: Role
  /** A sinking fund's balance before the first month in the hub. */
  opening: number
}

export interface Line {
  id: string
  categoryId: string
  label: string
  amount: number
  /** Where it came from: manual, or bill:<id>, planned:<id>, saving:<id>, debt:<id>. */
  source: string
}

export interface MonthPlan {
  month: string
  income: { id: string; label: string; amount: number }[]
  lines: Line[]
  /** Money moved between categories to cover overspending. */
  moves: { date: string; from: string; to: string; amount: number; note: string }[]
  notes: string
}

export interface Planned {
  name: string
  amount: number
  /** The month it is spent in. */
  month: string
  categoryId: string | null
  /** Save towards it each month from this month (a sinking fund); null to plan it all in its month. */
  saveFrom: string | null
  /** Whose it is (a family profile), e.g. a child for a school cost. */
  profileId: string | null
  /** e.g. "school". */
  tag: string
  done: boolean
  notes: string
}

export type DebtKind = 'credit-card' | 'store-card' | 'car' | 'personal' | 'student' | 'family' | 'other'

export interface Debt {
  name: string
  kind: DebtKind
  balance: number
  balanceOn: string
  /** Interest, percent a year. */
  rate: number
  minimum: number
  history: { date: string; balance: number }[]
  paidOff: string | null
  notes: string
}

export interface Milestones {
  starterTarget: number
  /** The full emergency fund, in months of essential spending (3 to 6). */
  fundMonths: number
  /** Extra each month for the smallest debt, on top of the minimums. */
  extraDebt: number
  ticks: Record<string, { done: boolean; note: string }>
}

export interface Txn {
  date: string
  description: string
  /** Negative is money out. */
  amount: number
  accountId: string | null
  /** A category ID, "income", "transfer" (between the family's own accounts), or null. */
  categoryId: string | null
  note: string
}

// ---- checking what comes in ----------------------------------------------------------------------

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/
export const month = (v: unknown, label: string): string => (typeof v === 'string' && MONTH.test(v) ? v : bad(`${label} must be a month.`))
const optMonth = (v: unknown, label: string) => (v === undefined || v === null || v === '' ? null : month(v, label))
const key = (v: unknown, label: string) => (typeof v === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(v) ? v : bad(`${label} is not valid.`))
const signed = (v: unknown, label: string) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || Math.abs(v) > 100_000_000_00) return bad(`${label} must be an amount in cents.`)
  return v
}

export function cleanCategories(raw: unknown): Category[] {
  const items = list(raw, 100, 'Categories').map((c) => {
    const o = obj(c)
    return {
      id: key(o.id, 'A category'),
      name: text(o, 'name', 60, 'A category name', true),
      group: oneOf(o.group, GROUPS, 'A category group'),
      sinking: o.sinking === true,
      role: o.role ? oneOf(o.role, ['emergency', 'retirement', 'education'] as const, 'A category role') : ('' as Role),
      opening: o.opening === undefined || o.opening === null ? 0 : signed(o.opening, 'An opening balance'),
    }
  })
  if (new Set(items.map((c) => c.id)).size !== items.length) bad('Two categories have the same ID.')
  return items
}

export function cleanPlan(raw: unknown, m: string): MonthPlan {
  const o = obj(raw)
  return {
    month: m,
    income: list(o.income, 30, 'Income').map((i) => {
      const e = obj(i)
      return { id: key(e.id, 'An income line'), label: text(e, 'label', 80, 'An income name', true), amount: cents(e.amount, 'An income amount') }
    }),
    lines: list(o.lines, 300, 'Lines').map((l) => {
      const e = obj(l)
      return { id: key(e.id, 'A line'), categoryId: key(e.categoryId, 'A line’s category'), label: text(e, 'label', 120, 'A line’s name'), amount: cents(e.amount, 'A line amount'), source: e.source ? key(e.source, 'A line’s source') : 'manual' }
    }),
    moves: list(o.moves, 300, 'Moves').map((mv) => {
      const e = obj(mv)
      return { date: date(e, 'date', 'A move date', true)!, from: key(e.from, 'Where it came from'), to: key(e.to, 'Where it went'), amount: cents(e.amount, 'A move amount'), note: text(e, 'note', 200, 'A note') }
    }),
    notes: text(o, 'notes', 2000, 'Notes'),
  }
}

export function cleanPlanned(raw: unknown): Planned {
  const o = obj(raw)
  const m = month(o.month, 'The month')
  const saveFrom = optMonth(o.saveFrom, 'Saving from')
  if (saveFrom && saveFrom > m) bad('Saving must start before the month it is spent.')
  return {
    name: text(o, 'name', 120, 'What it is', true),
    amount: cents(o.amount, 'The amount'),
    month: m,
    categoryId: o.categoryId ? key(o.categoryId, 'The category') : null,
    saveFrom,
    profileId: o.profileId ? key(o.profileId, 'Whose it is') : null,
    tag: text(o, 'tag', 30, 'The tag'),
    done: o.done === true,
    notes: text(o, 'notes', 2000, 'Notes'),
  }
}

export function cleanDebt(raw: unknown): Debt {
  const o = obj(raw)
  const rate = typeof o.rate === 'number' && Number.isFinite(o.rate) && o.rate >= 0 && o.rate <= 100 ? Math.round(o.rate * 100) / 100 : bad('The interest rate must be a percentage from 0 to 100.')
  return {
    name: text(o, 'name', 80, 'The name', true),
    kind: oneOf(o.kind, ['credit-card', 'store-card', 'car', 'personal', 'student', 'family', 'other'] as const, 'The kind of debt', 'other'),
    balance: cents(o.balance, 'The balance'),
    balanceOn: date(o, 'balanceOn', 'The date of the balance', true)!,
    rate,
    minimum: cents(o.minimum, 'The minimum payment'),
    history: list(o.history, 600, 'The history')
      .map((h) => {
        const e = obj(h)
        return { date: date(e, 'date', 'A balance date', true)!, balance: cents(e.balance, 'A balance') }
      })
      .sort((a, b) => a.date.localeCompare(b.date)),
    paidOff: date(o, 'paidOff', 'The day it was paid off'),
    notes: text(o, 'notes', 2000, 'Notes'),
  }
}

export function cleanMilestones(raw: unknown): Milestones {
  const o = obj(raw)
  const ticks: Milestones['ticks'] = {}
  const t = o.ticks && typeof o.ticks === 'object' ? (o.ticks as Record<string, unknown>) : {}
  for (const step of ['4', '5', '6', '7']) {
    if (!t[step]) continue
    const e = obj(t[step])
    ticks[step] = { done: e.done === true, note: text(e, 'note', 500, 'A note') }
  }
  return {
    starterTarget: cents(o.starterTarget ?? 1000000, 'The starter emergency fund'),
    fundMonths: int(o.fundMonths ?? 3, 'Months of expenses', 3, 6),
    extraDebt: cents(o.extraDebt ?? 0, 'The extra for debt'),
    ticks,
  }
}

export function cleanTxn(raw: unknown): Txn {
  const o = obj(raw)
  return {
    date: date(o, 'date', 'The date', true)!,
    description: text(o, 'description', 200, 'The description', true),
    amount: signed(o.amount, 'The amount'),
    accountId: o.accountId ? key(o.accountId, 'The account') : null,
    categoryId: o.categoryId ? key(o.categoryId, 'The category') : null,
    note: text(o, 'note', 500, 'A note'),
  }
}

// ---- defaults ----------------------------------------------------------------------------------

const cat = (id: string, name: string, group: Group, extra: Partial<Category> = {}): Category => ({ id, name, group, sinking: false, role: '', opening: 0, ...extra })

/** A starting set of categories, in order of priority; the parents change them as they like. */
export const DEFAULT_CATEGORIES: Category[] = [
  cat('giving', 'Giving', 'giving'),
  cat('emergency', 'Emergency fund', 'saving', { sinking: true, role: 'emergency' }),
  cat('retirement', 'Retirement', 'saving', { role: 'retirement' }),
  cat('education', 'Children’s education', 'saving', { sinking: true, role: 'education' }),
  cat('housing', 'Housing', 'essentials'),
  cat('utilities', 'Utilities', 'essentials'),
  cat('groceries', 'Groceries', 'essentials'),
  cat('transport', 'Transport', 'essentials'),
  cat('debt', 'Debt payments', 'debt'),
  cat('insurance', 'Insurance', 'lifestyle'),
  cat('medical', 'Medical', 'lifestyle'),
  cat('school', 'School', 'lifestyle', { sinking: true }),
  cat('clothing', 'Clothing', 'lifestyle'),
  cat('eating-out', 'Eating out', 'lifestyle'),
  cat('entertainment', 'Entertainment and subscriptions', 'lifestyle'),
  cat('gifts', 'Gifts and Christmas', 'lifestyle', { sinking: true }),
  cat('holidays', 'Holidays', 'lifestyle', { sinking: true }),
  cat('car-upkeep', 'Car upkeep', 'lifestyle', { sinking: true }),
  cat('misc', 'Miscellaneous', 'lifestyle'),
]

/** Which budget category a bill's category goes in, by name. */
const BILL_TO_BUDGET: Record<string, string> = {
  housing: 'housing',
  utilities: 'utilities',
  'phone and internet': 'utilities',
  insurance: 'insurance',
  transport: 'transport',
  'school and education': 'school',
  medical: 'medical',
  'streaming and apps': 'entertainment',
  memberships: 'entertainment',
  giving: 'giving',
  'loans and credit': 'debt',
}

export function categoryForBill(categories: Category[], billCategory: string): string {
  const name = billCategory.trim().toLowerCase()
  const byName = categories.find((c) => c.name.toLowerCase() === name)
  if (byName) return byName.id
  const mapped = BILL_TO_BUDGET[name]
  if (mapped && categories.some((c) => c.id === mapped)) return mapped
  return categories.find((c) => c.id === 'misc')?.id ?? categories[categories.length - 1]?.id ?? 'misc'
}

// ---- months ------------------------------------------------------------------------------------

export const monthOf = (day: string) => day.slice(0, 7)
export function addMonthsTo(m: string, n: number): string {
  const y = Number(m.slice(0, 4))
  const i = Number(m.slice(5, 7)) - 1 + n
  return `${y + Math.floor(i / 12)}-${String((((i % 12) + 12) % 12) + 1).padStart(2, '0')}`
}
export const monthsBetween = (a: string, b: string) => (Number(b.slice(0, 4)) - Number(a.slice(0, 4))) * 12 + Number(b.slice(5, 7)) - Number(a.slice(5, 7))
const lastDay = (m: string) => addDays(`${addMonthsTo(m, 1)}-01`, -1)

/** What a planned expense puts in a month: the saving towards it, or the whole amount in its month. */
export function plannedShare(p: Planned, m: string): number {
  if (p.done) return 0
  if (!p.saveFrom) return m === p.month ? p.amount : 0
  if (m < p.saveFrom || m > p.month) return 0
  const n = monthsBetween(p.saveFrom, p.month) + 1
  const each = Math.floor(p.amount / n)
  return m === p.month ? p.amount - each * (n - 1) : each
}

// ---- debts: smallest balance first -------------------------------------------------------------

export interface Snowball {
  /** In the order they are paid off. */
  order: { id: string; payment: number; payoffMonth: string | null }[]
  debtFree: string | null
}

/**
 * Pays the minimum on every debt and everything extra on the smallest
 * balance; when one is paid off, its payment rolls into the next. Months
 * from `start`. Null when the payments never catch up with the interest.
 */
export function snowball(debts: { id: string; balance: number; rate: number; minimum: number }[], extra: number, start: string): Snowball {
  const live = debts.filter((d) => d.balance > 0).map((d) => ({ ...d, left: d.balance, payoff: null as string | null }))
  live.sort((a, b) => a.balance - b.balance || a.rate - b.rate)
  const order = live.map((d, i) => ({ id: d.id, payment: d.minimum + (i === 0 ? extra : 0), payoffMonth: null as string | null }))
  const budget = live.reduce((n, d) => n + d.minimum, 0) + extra
  for (let k = 0; k < 600 && live.some((d) => d.left > 0); k++) {
    const m = addMonthsTo(start, k)
    for (const d of live) if (d.left > 0) d.left += Math.round((d.left * d.rate) / 100 / 12)
    let money = budget
    for (const d of live) {
      if (d.left <= 0) continue
      const pay = Math.min(d.minimum, d.left, money)
      d.left -= pay
      money -= pay
    }
    for (const d of live) {
      if (d.left <= 0 || money <= 0) continue
      const pay = Math.min(d.left, money)
      d.left -= pay
      money -= pay
    }
    for (const d of live) if (d.left <= 0 && !d.payoff) d.payoff = m
  }
  const finalOrder = order.map((o) => ({ ...o, payoffMonth: live.find((d) => d.id === o.id)!.payoff }))
  // Debt-free when every debt is paid off within 50 years; never, if the payments cannot catch up.
  const debtFree = finalOrder.length > 0 && finalOrder.every((o) => o.payoffMonth) ? finalOrder.map((o) => o.payoffMonth!).sort().pop()! : null
  return { order: finalOrder, debtFree }
}

// ---- reading and working out -------------------------------------------------------------------

interface Row {
  id: string
  kind: string
  key: string | null
  sealed: string
  version: number
}

export const sealBudget = (s: Services, kind: string, id: string, item: unknown) => s.serverKey.seal(JSON.stringify(item), 'budget', `${kind}:${id}`)
export const openBudget = <T>(s: Services, r: Pick<Row, 'id' | 'kind' | 'sealed'>) => JSON.parse(s.serverKey.open(r.sealed, 'budget', `${r.kind}:${r.id}`)) as T
export const sealTxn = (s: Services, id: string, t: Txn) => s.serverKey.seal(JSON.stringify(t), 'transaction', id)
export const openTxn = (s: Services, r: { id: string; sealed: string }) => JSON.parse(s.serverKey.open(r.sealed, 'transaction', r.id)) as Txn

export function readBudget<T>(s: Services, kind: string): { id: string; key: string | null; version: number; item: T }[] {
  return (s.db.prepare('SELECT id, kind, key, sealed, version FROM budget WHERE kind = ? ORDER BY key, created_at, id').all(kind) as unknown as Row[]).map((r) => ({
    id: r.id,
    key: r.key,
    version: r.version,
    item: openBudget<T>(s, r),
  }))
}

export function readOne<T>(s: Services, kind: string, k: string | null): { id: string; version: number; item: T } | null {
  const r = s.db.prepare(`SELECT id, kind, key, sealed, version FROM budget WHERE kind = ? AND key ${k === null ? 'IS NULL' : '= ?'}`).get(...(k === null ? [kind] : [kind, k])) as Row | undefined
  return r ? { id: r.id, version: r.version, item: openBudget<T>(s, r) } : null
}

export function categories(s: Services): { version: number; list: Category[] } {
  const r = readOne<Category[]>(s, 'categories', null)
  return r ? { version: r.version, list: r.item } : { version: 0, list: DEFAULT_CATEGORIES }
}

export function milestones(s: Services): { version: number; item: Milestones } {
  const r = readOne<Milestones>(s, 'milestones', null)
  return r ? { version: r.version, item: r.item } : { version: 0, item: cleanMilestones({}) }
}

/** Every transaction (or one month's), opened. */
export function readTxns(s: Services, m?: string): { id: string; version: number; month: string; item: Txn }[] {
  const rows = (m ? s.db.prepare('SELECT id, month, sealed, version FROM transactions WHERE month = ?').all(m) : s.db.prepare('SELECT id, month, sealed, version FROM transactions').all()) as {
    id: string
    month: string
    sealed: string
    version: number
  }[]
  return rows.map((r) => ({ id: r.id, version: r.version, month: r.month, item: openTxn(s, r) })).sort((a, b) => b.item.date.localeCompare(a.item.date))
}

/** Spending per category, per month: money out counts, refunds (money in on a category) take it back. */
export function spending(txns: { month: string; item: Txn }[]): Map<string, Map<string, number>> {
  const out = new Map<string, Map<string, number>>()
  for (const t of txns) {
    const c = t.item.categoryId
    if (!c || c === 'transfer') continue
    const m = out.get(t.month) ?? new Map<string, number>()
    m.set(c, (m.get(c) ?? 0) - t.item.amount)
    out.set(t.month, m)
  }
  return out
}

/** What a category has to spend in a month: its lines, plus money moved in, less money moved out. */
export function plannedFor(plan: MonthPlan | null | undefined, categoryId: string): number {
  if (!plan) return 0
  const lines = plan.lines.filter((l) => l.categoryId === categoryId).reduce((n, l) => n + l.amount, 0)
  const moved = plan.moves.reduce((n, m) => n + (m.to === categoryId ? m.amount : 0) - (m.from === categoryId ? m.amount : 0), 0)
  return lines + moved
}

/**
 * Sinking funds' balances at the end of `upTo`: the opening balance, plus
 * what was planned, less what was spent, month by month.
 */
export function sinkingBalances(cats: Category[], plans: MonthPlan[], spent: Map<string, Map<string, number>>, upTo: string): Record<string, number> {
  const out: Record<string, number> = {}
  const months = [...new Set([...plans.map((p) => p.month), ...spent.keys()])].filter((m) => m <= upTo).sort()
  for (const c of cats.filter((x) => x.sinking)) {
    let bal = c.opening
    for (const m of months) bal += plannedFor(plans.find((p) => p.month === m), c.id) - (spent.get(m)?.get(c.id) ?? 0)
    out[c.id] = bal
  }
  return out
}

const lineId = (source: string) => `l-${source.replace(/[^A-Za-z0-9_-]/g, '-')}`.slice(0, 80)

/** The lines a month should have from bills, planned expenses and debts. */
export function generatedLines(s: Services, cats: Category[], m: string, today: string): Line[] {
  const lines: Line[] = []
  for (const { id, item: b } of readAll<Bill>(s, 'bill')) {
    if (b.status !== 'active') continue
    const n = dueDates(b, `${m}-01`, lastDay(m)).length
    if (n > 0) lines.push({ id: lineId(`bill:${id}`), categoryId: categoryForBill(cats, b.category), label: b.name, amount: b.amount * n, source: `bill:${id}` })
  }
  for (const { id, item: p } of readBudget<Planned>(s, 'planned')) {
    const share = plannedShare(p, m)
    if (share <= 0) continue
    const saving = p.saveFrom && m < p.month
    const categoryId = p.categoryId && cats.some((c) => c.id === p.categoryId) ? p.categoryId : categoryForBill(cats, 'misc')
    lines.push({ id: lineId(`${saving ? 'saving' : 'planned'}:${id}`), categoryId, label: saving ? `Saving for ${p.name}` : p.name, amount: share, source: `${saving ? 'saving' : 'planned'}:${id}` })
  }
  const debts = readBudget<Debt>(s, 'debt').filter((d) => !d.item.paidOff && d.item.balance > 0)
  if (debts.length) {
    const debtCat = cats.find((c) => c.group === 'debt')?.id ?? categoryForBill(cats, 'misc')
    const plan = snowball(
      debts.map((d) => ({ id: d.id, balance: d.item.balance, rate: d.item.rate, minimum: d.item.minimum })),
      milestones(s).item.extraDebt,
      m < monthOf(today) ? monthOf(today) : m,
    )
    for (const o of plan.order) {
      const d = debts.find((x) => x.id === o.id)!
      lines.push({ id: lineId(`debt:${o.id}`), categoryId: debtCat, label: o.payment > d.item.minimum ? `${d.item.name} (smallest: minimum plus extra)` : d.item.name, amount: o.payment, source: `debt:${o.id}` })
    }
  }
  return lines
}

/** A new month's plan: last month's income and own lines, plus what bills, plans and debts call for. */
export function startMonth(s: Services, m: string, today: string): MonthPlan {
  const cats = categories(s).list
  const before = readBudget<MonthPlan>(s, 'month')
    .filter((p) => p.key! < m)
    .pop()?.item
  return {
    month: m,
    income: before?.income.map((i) => ({ ...i })) ?? [],
    lines: [...(before?.lines.filter((l) => l.source === 'manual') ?? []), ...generatedLines(s, cats, m, today)],
    moves: [],
    notes: '',
  }
}

// ---- reminders ---------------------------------------------------------------------------------

/** From the 25th: plan next month before it starts (once the budget is in use). */
export function budgetItems(s: Services): ReminderItem[] {
  if (!s.db.prepare("SELECT 1 FROM budget WHERE kind = 'month' LIMIT 1").get()) return []
  const today = localNow(s.now(), s.config.timeZone).date
  const next = addMonthsTo(monthOf(today), 1)
  if (s.db.prepare("SELECT 1 FROM budget WHERE kind = 'month' AND key = ?").get(next)) return []
  return [
    {
      key: `bp:${next}`,
      category: 'household',
      title: 'Plan next month’s budget',
      whose: null,
      due: { date: `${monthOf(today)}-25`, yearly: false },
      leads: [0],
      notice: () => 'Time to plan next month’s budget. Tap to see.',
      url: '/money',
      audience: 'all',
      horizon: 6,
      detail: () => null,
      catchUp: true,
    },
  ]
}
