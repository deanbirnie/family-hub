/**
 * Household admin (phase 6a): accounts, bills and subscriptions, invoices.
 *
 * Everything is sealed with the server key, which the owner chose so the
 * server can work out due dates, reminders and totals itself
 * (docs/DATA-PROTECTION.md, "Household admin"). Nothing here is an account
 * or card number: an account is a bank and a nickname.
 *
 * Amounts are whole cents (rand). Dates are local to the family
 * ("YYYY-MM-DD").
 */
import type { Services } from './app.ts'
import { HttpError } from './http.ts'
import { daysBetween, localNow, parseDate } from './schedule.ts'
import type { ReminderItem } from './notifications.ts'

// ---- what is stored ----------------------------------------------------------------------

export interface Account {
  bank: string
  nickname: string
  notes: string
}

export type Unit = 'week' | 'month' | 'year' | 'once'
export type Method = 'debit' | 'eft' | 'card' | 'cash' | 'other'

export interface Bill {
  type: 'bill' | 'subscription'
  name: string
  /** The payee in Contacts, if they are there. */
  payeeId: string | null
  category: string
  /** The current amount, in cents. */
  amount: number
  /** Every `every` weeks, months or years; or once. */
  every: number
  unit: Unit
  /** The first (or only) due date; later ones follow from it. */
  firstDue: string
  method: Method
  accountId: string | null
  /** An insurance policy in Quick Info, so the premium is not entered twice. */
  policyId: string | null
  /** Days before each due date to remind (for bills paid by hand); empty for none. */
  remind: number[]
  contractStart: string | null
  contractEnd: string | null
  /** Days of notice needed to cancel before the contract ends. */
  noticeDays: number | null
  // Subscriptions.
  plan: string
  trialEnd: string | null
  /** Ask "still using it?" this many months after the last review; null for never. */
  reviewMonths: number | null
  reviewedOn: string | null
  /** Who uses it (family profile IDs). */
  users: string[]
  cancelHow: string
  status: 'active' | 'cancelled'
  cancelledOn: string | null
  /** Each amount and the date it applied from, oldest first. */
  prices: { from: string; amount: number }[]
  /** Payments marked by hand, by the due date they were for. */
  payments: { due: string; paidOn: string; amount: number; by: string; note: string }[]
  /** Debit orders that did not go through, by due date. */
  problems: { due: string; note: string }[]
  notes: string
  /** The day it was added: earlier due dates are never "overdue". */
  addedOn: string
}

export type InvoiceStatus = 'unpaid' | 'paid' | 'disputed' | 'cancelled'

export interface Invoice {
  from: string
  payeeId: string | null
  number: string
  date: string
  due: string | null
  amount: number
  status: InvoiceStatus
  paidOn: string | null
  /** A bill it belongs to (a monthly statement), if any. */
  billId: string | null
  notes: string
  documents: { id: string; name: string }[]
}

export type Kind = 'account' | 'bill' | 'invoice'
export type Item = Account | Bill | Invoice

// ---- checking what comes in --------------------------------------------------------------

export const bad = (message: string): never => {
  throw new HttpError(400, message, 'invalid')
}

export const text = (o: Record<string, unknown>, key: string, max: number, label: string, required = false): string => {
  const v = o[key]
  if (v === undefined || v === null || v === '') return required ? bad(`${label} is needed.`) : ''
  if (typeof v !== 'string') return bad(`${label} must be text.`)
  const t = v.trim()
  if (required && !t) bad(`${label} is needed.`)
  if (t.length > max) bad(`${label} is too long (at most ${max} characters).`)
  return t
}

export const date = (o: Record<string, unknown>, key: string, label: string, required = false): string | null => {
  const v = o[key]
  if (v === undefined || v === null || v === '') return required ? bad(`${label} is needed.`) : null
  if (typeof v !== 'string' || v.length !== 10 || !parseDate(v)?.year) return bad(`${label} must be a date.`)
  return v
}

export const cents = (v: unknown, label: string): number => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 100_000_000_00) return bad(`${label} must be an amount in cents.`)
  return v
}

export const int = (v: unknown, label: string, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) return bad(`${label} must be a whole number from ${min} to ${max}.`)
  return v
}

export const id = (o: Record<string, unknown>, key: string): string | null => {
  const v = o[key]
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) return bad('A linked item is not valid.')
  return v
}

export const oneOf = <T extends string>(v: unknown, options: readonly T[], label: string, fallback?: T): T => {
  if ((v === undefined || v === null || v === '') && fallback) return fallback
  if (typeof v !== 'string' || !options.includes(v as T)) return bad(`${label} is not one of the choices.`)
  return v as T
}

export const list = (v: unknown, max: number, label: string): unknown[] => {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v) || v.length > max) return bad(`${label} must be a list of at most ${max}.`)
  return v
}

export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : bad('Each entry must be an object.'))

export function cleanAccount(raw: unknown): Account {
  const o = obj(raw)
  return { bank: text(o, 'bank', 60, 'The bank', true), nickname: text(o, 'nickname', 60, 'The nickname', true), notes: text(o, 'notes', 1000, 'Notes') }
}

export function cleanBill(raw: unknown, addedOn: string): Bill {
  const o = obj(raw)
  const unit = oneOf(o.unit, ['week', 'month', 'year', 'once'] as const, 'How often')
  const contractEnd = date(o, 'contractEnd', 'The contract end')
  const prices = list(o.prices, 200, 'The price history').map((p) => {
    const e = obj(p)
    return { from: date(e, 'from', 'A price change date', true)!, amount: cents(e.amount, 'A price') }
  })
  const amount = cents(o.amount, 'The amount')
  return {
    type: oneOf(o.type, ['bill', 'subscription'] as const, 'The kind', 'bill'),
    name: text(o, 'name', 120, 'The name', true),
    payeeId: id(o, 'payeeId'),
    category: text(o, 'category', 60, 'The category'),
    amount,
    every: unit === 'once' ? 1 : int(o.every ?? 1, 'Every', 1, 60),
    unit,
    firstDue: date(o, 'firstDue', 'The first due date', true)!,
    method: oneOf(o.method, ['debit', 'eft', 'card', 'cash', 'other'] as const, 'How it is paid', 'debit'),
    accountId: id(o, 'accountId'),
    policyId: id(o, 'policyId'),
    remind: [...new Set(list(o.remind, 5, 'Reminders').map((n) => int(n, 'A reminder', 0, 60)))].sort((a, b) => b - a),
    contractStart: date(o, 'contractStart', 'The contract start'),
    contractEnd,
    noticeDays: o.noticeDays === undefined || o.noticeDays === null || o.noticeDays === '' ? null : int(o.noticeDays, 'The notice period', 0, 365),
    plan: text(o, 'plan', 80, 'The plan'),
    trialEnd: date(o, 'trialEnd', 'The trial end'),
    reviewMonths: o.reviewMonths === undefined || o.reviewMonths === null || o.reviewMonths === '' ? null : int(o.reviewMonths, 'How often to review', 1, 60),
    reviewedOn: date(o, 'reviewedOn', 'The last review'),
    users: list(o.users, 20, 'Who uses it').map((u) => (typeof u === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(u) ? u : bad('Who uses it is not valid.'))),
    cancelHow: text(o, 'cancelHow', 500, 'How to cancel'),
    status: oneOf(o.status, ['active', 'cancelled'] as const, 'The status', 'active'),
    cancelledOn: date(o, 'cancelledOn', 'The cancellation date'),
    prices: prices.length ? prices.sort((a, b) => a.from.localeCompare(b.from)) : [{ from: date(o, 'firstDue', 'The first due date', true)!, amount }],
    payments: list(o.payments, 2000, 'Payments').map((p) => {
      const e = obj(p)
      return { due: date(e, 'due', 'A payment’s due date', true)!, paidOn: date(e, 'paidOn', 'The date paid', true)!, amount: cents(e.amount, 'A payment'), by: text(e, 'by', 60, 'Who paid'), note: text(e, 'note', 300, 'A payment note') }
    }),
    problems: list(o.problems, 500, 'Problems').map((p) => {
      const e = obj(p)
      return { due: date(e, 'due', 'A problem’s due date', true)!, note: text(e, 'note', 300, 'A problem note') }
    }),
    notes: text(o, 'notes', 2000, 'Notes'),
    addedOn: date(o, 'addedOn', 'The day added') ?? addedOn,
  }
}

export function cleanInvoice(raw: unknown): Invoice {
  const o = obj(raw)
  const status = oneOf(o.status, ['unpaid', 'paid', 'disputed', 'cancelled'] as const, 'The status', 'unpaid')
  return {
    from: text(o, 'from', 120, 'Who it is from', true),
    payeeId: id(o, 'payeeId'),
    number: text(o, 'number', 60, 'The invoice number'),
    date: date(o, 'date', 'The invoice date', true)!,
    due: date(o, 'due', 'The due date'),
    amount: cents(o.amount, 'The amount'),
    status,
    paidOn: status === 'paid' ? date(o, 'paidOn', 'The date paid') : null,
    billId: id(o, 'billId'),
    notes: text(o, 'notes', 2000, 'Notes'),
    documents: list(o.documents, 20, 'Documents').map((d) => {
      const e = obj(d)
      return { id: (id(e, 'id') ?? bad('A document is not valid.'))!, name: text(e, 'name', 240, 'A document name', true) }
    }),
  }
}

// ---- dates and money -----------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** The same day `n` months later, or the month's last day ("31 Jan" + 1 month = "28 Feb"). */
export function addMonths(day: string, n: number): string {
  const y = Number(day.slice(0, 4))
  const m = Number(day.slice(5, 7)) - 1 + n
  const ty = y + Math.floor(m / 12)
  const tm = ((m % 12) + 12) % 12
  return `${ty}-${pad(tm + 1)}-${pad(Math.min(Number(day.slice(8, 10)), daysIn(ty, tm + 1)))}`
}

/** The i-th due date (0 is the first), or null if there is none. */
export function occurrence(b: Pick<Bill, 'unit' | 'every' | 'firstDue'>, i: number): string | null {
  if (i < 0) return null
  if (b.unit === 'once') return i === 0 ? b.firstDue : null
  if (b.unit === 'week') return addDays(b.firstDue, 7 * b.every * i)
  return addMonths(b.firstDue, (b.unit === 'year' ? 12 : 1) * b.every * i)
}

/** Due dates from `from` to `to` (inclusive), while the bill is active. */
export function dueDates(b: Bill, from: string, to: string): string[] {
  const out: string[] = []
  const end = b.status === 'cancelled' && b.cancelledOn && b.cancelledOn < to ? b.cancelledOn : to
  for (let i = 0; i < 5000; i++) {
    const d = occurrence(b, i)
    if (!d || d > end) break
    if (d >= from) out.push(d)
  }
  return out
}

/** The next due date on or after `today`. */
export function nextDue(b: Bill, today: string): string | null {
  if (b.status === 'cancelled') return null
  for (let i = 0; i < 5000; i++) {
    const d = occurrence(b, i)
    if (!d) return null
    if (d >= today) return d
  }
  return null
}

/** Debit orders and card charges happen by themselves; the rest are paid by hand. */
export const automatic = (b: Pick<Bill, 'method'>) => b.method === 'debit' || b.method === 'card'

/**
 * Due dates that passed without being marked paid: bills paid by hand only
 * (a debit order or card charge counts as paid unless a problem is marked),
 * and only since the bill was added. Newest first.
 */
export function overdue(b: Bill, today: string): string[] {
  const problems = b.problems.map((p) => p.due).filter((d) => !b.payments.some((p) => p.due === d))
  if (automatic(b)) return problems.sort().reverse()
  const paid = new Set(b.payments.map((p) => p.due))
  const from = b.addedOn > b.firstDue ? b.addedOn : b.firstDue
  return dueDates(b, from, addDays(today, -1))
    .filter((d) => !paid.has(d))
    .reverse()
    .slice(0, 24)
}

/** What it costs per month, on average (cents); nothing for a one-off. */
export function monthlyCents(b: Pick<Bill, 'amount' | 'unit' | 'every'>): number {
  if (b.unit === 'once') return 0
  if (b.unit === 'week') return Math.round((b.amount * 52) / 12 / b.every)
  if (b.unit === 'year') return Math.round(b.amount / (12 * b.every))
  return Math.round(b.amount / b.every)
}

/** The last day to give notice, if the contract says how much notice. */
export const noticeDeadline = (b: Bill) => (b.contractEnd && b.noticeDays !== null ? addDays(b.contractEnd, -b.noticeDays) : null)

/** When the next "still using it?" review is due. */
export const reviewDue = (b: Bill) => (b.type === 'subscription' && b.status === 'active' && b.reviewMonths ? addMonths(b.reviewedOn ?? b.addedOn, b.reviewMonths) : null)

/** "R 1 234.50" */
export function rand(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(cents)
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${sign}R ${whole}.${pad(abs % 100)}`
}

// ---- reading the sealed items ----------------------------------------------------------------

interface Row {
  id: string
  kind: Kind
  sealed: string
  version: number
  created_at: number
  updated_at: number
}

export const sealItem = (s: Services, kind: Kind, id: string, item: Item) => s.serverKey.seal(JSON.stringify(item), 'household', `${kind}:${id}`)
export const openItem = <T extends Item>(s: Services, row: Pick<Row, 'id' | 'kind' | 'sealed'>): T => JSON.parse(s.serverKey.open(row.sealed, 'household', `${row.kind}:${row.id}`)) as T

export function readAll<T extends Item>(s: Services, kind: Kind): { id: string; version: number; createdAt: number; updatedAt: number; item: T }[] {
  const rows = s.db.prepare('SELECT id, kind, sealed, version, created_at, updated_at FROM household WHERE kind = ? ORDER BY created_at, id').all(kind) as unknown as Row[]
  return rows.map((r) => ({ id: r.id, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, item: openItem<T>(s, r) }))
}

// ---- reminders -------------------------------------------------------------------------------

const MONEY_URL = '/money'

/**
 * Reminders for bills, subscriptions and invoices, worked out from the
 * sealed items each time. Notification text is generic; the titles show only
 * in the app (parents only).
 */
export function householdItems(s: Services): ReminderItem[] {
  if (!s.db.prepare("SELECT 1 FROM household WHERE kind != 'account' LIMIT 1").get()) return []
  const today = localNow(s.now(), s.config.timeZone).date
  const out: ReminderItem[] = []
  const item = (key: string, title: string, date: string, leads: number[], notice: string, horizon: number, detail: string | null, catchUp = false): ReminderItem => ({
    key,
    category: 'household',
    title,
    whose: null,
    due: { date, yearly: false },
    leads,
    notice: () => notice,
    url: MONEY_URL,
    audience: 'all',
    horizon,
    detail: () => detail,
    catchUp,
  })
  for (const { id, item: b } of readAll<Bill>(s, 'bill')) {
    if (b.status !== 'active') continue
    const what = b.type === 'subscription' ? 'A subscription' : 'A bill'
    const next = nextDue(b, today)
    if (next && b.remind.length) out.push(item(`hb:${id}:due`, b.name, next, b.remind, `${what} is due. Tap to see.`, 14, rand(b.amount)))
    // Automatic payments show in "coming up" a few days ahead, without a notification.
    else if (next && automatic(b) && daysBetween(today, next) <= 3) out.push(item(`hb:${id}:debit`, `${b.name} (${b.method === 'debit' ? 'debit order' : 'card'})`, next, [], '', 3, rand(b.amount)))
    const late = overdue(b, today)[0]
    if (late) out.push(item(`hb:${id}:late`, `${b.name}: ${automatic(b) ? 'payment problem' : 'not marked paid'}`, late, [], `${what} is overdue. Tap to see.`, 0, rand(b.amount), true))
    const deadline = noticeDeadline(b)
    if (deadline && deadline >= today) out.push(item(`hb:${id}:notice`, `${b.name}: last day to give notice`, deadline, [30, 7, 1], 'A renewal deadline is coming up. Tap to see.', 60, b.contractEnd ? `contract ends ${b.contractEnd}` : null))
    if (b.trialEnd && b.trialEnd >= today) out.push(item(`hb:${id}:trial`, `${b.name}: free trial ends`, b.trialEnd, [3, 1], 'A free trial ends soon. Tap to see.', 14, `then ${rand(b.amount)}`))
    const review = reviewDue(b)
    if (review) out.push(item(`hb:${id}:review`, `${b.name}: still using it?`, review, [0], 'Time to review a subscription. Tap to see.', 14, rand(monthlyCents(b)) + ' a month', true))
  }
  for (const { id, item: inv } of readAll<Invoice>(s, 'invoice')) {
    if (inv.status !== 'unpaid' || !inv.due) continue
    const title = `Invoice: ${inv.from}${inv.number ? ` (${inv.number})` : ''}`
    if (inv.due >= today) out.push(item(`hi:${id}:due`, title, inv.due, [3, 0], 'An invoice is due. Tap to see.', 14, rand(inv.amount)))
    else out.push(item(`hi:${id}:late`, `${title}: overdue`, inv.due, [], 'An invoice is overdue. Tap to see.', 0, rand(inv.amount), true))
  }
  return out
}
