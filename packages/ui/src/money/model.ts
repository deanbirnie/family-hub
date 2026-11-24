/**
 * Money (phase 6a): what the server sends and keeps, and how it reads. The
 * server works out due dates, overdue and monthly costs (household.ts); the
 * page only shows them.
 */

export interface Account {
  id: string
  version: number
  bank: string
  nickname: string
  notes: string
}

export type Unit = 'week' | 'month' | 'year' | 'once'
export type Method = 'debit' | 'eft' | 'card' | 'cash' | 'other'

export interface BillFields {
  type: 'bill' | 'subscription'
  name: string
  payeeId: string | null
  category: string
  amount: number
  every: number
  unit: Unit
  firstDue: string
  method: Method
  accountId: string | null
  policyId: string | null
  remind: number[]
  contractStart: string | null
  contractEnd: string | null
  noticeDays: number | null
  plan: string
  trialEnd: string | null
  reviewMonths: number | null
  reviewedOn: string | null
  users: string[]
  cancelHow: string
  status: 'active' | 'cancelled'
  cancelledOn: string | null
  prices: { from: string; amount: number }[]
  payments: { due: string; paidOn: string; amount: number; by: string; note: string }[]
  problems: { due: string; note: string }[]
  notes: string
  addedOn: string
}

export interface Bill extends BillFields {
  id: string
  version: number
  /** Worked out by the server. */
  nextDue: string | null
  /** The most recent due date before today. */
  lastDue: string | null
  overdue: string[]
  monthly: number
  noticeDeadline: string | null
  reviewDue: string | null
}

export type InvoiceStatus = 'unpaid' | 'paid' | 'disputed' | 'cancelled'

export interface Invoice {
  id: string
  version: number
  createdAt: number
  from: string
  payeeId: string | null
  number: string
  date: string
  due: string | null
  amount: number
  status: InvoiceStatus
  paidOn: string | null
  billId: string | null
  notes: string
  documents: { id: string; name: string }[]
}

export interface Money {
  today: string
  accounts: Account[]
  bills: Bill[]
  invoices: Invoice[]
}

export const BANKS = ['ABSA', 'Capitec', 'Discovery Bank', 'FNB', 'Investec', 'Nedbank', 'Standard Bank', 'TymeBank', 'African Bank', 'Old Mutual', 'Other']

export const CATEGORIES = [
  'Housing',
  'Utilities',
  'Insurance',
  'Transport',
  'Phone and internet',
  'School and education',
  'Medical',
  'Streaming and apps',
  'Memberships',
  'Giving',
  'Loans and credit',
  'Other',
]

export const METHODS: [Method, string][] = [
  ['debit', 'Debit order'],
  ['card', 'Card (charged automatically)'],
  ['eft', 'EFT (paid by hand)'],
  ['cash', 'Cash (paid by hand)'],
  ['other', 'Other (paid by hand)'],
]

/** Debit orders and card charges happen by themselves; the rest are paid by hand. */
export const automatic = (b: Pick<BillFields, 'method'>) => b.method === 'debit' || b.method === 'card'

/** "Debit order", "Card", "EFT": the short name of how it is paid. */
export const methodName = (m: Method) => METHODS.find(([v]) => v === m)?.[1].replace(/ \(.*\)$/, '') ?? m

export const STATUSES: [InvoiceStatus, string][] = [
  ['unpaid', 'Unpaid'],
  ['paid', 'Paid'],
  ['disputed', 'Disputed'],
  ['cancelled', 'Cancelled'],
]

/** "R 1 234.50" */
export function rand(cents: number): string {
  const sign = cents < 0 ? '-' : ''
  const abs = Math.abs(Math.round(cents))
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${sign}R ${whole}.${String(abs % 100).padStart(2, '0')}`
}

/** Reads "1 234,50", "R1234.5" or "1,234.50" as cents; null if it is not an amount. */
export function parseRand(text: string): number | null {
  let t = text.replace(/[R\s ]/gi, '')
  if (!t) return null
  // Whichever of comma and point comes last, followed by one or two digits, is the decimal mark; the other groups thousands.
  const comma = t.lastIndexOf(',')
  const point = t.lastIndexOf('.')
  if (comma > point && /,\d{1,2}$/.test(t)) t = t.replace(/\./g, '').replace(',', '.')
  else t = t.replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null
  return Math.round(Number(t) * 100)
}

/** Cents as the text in an amount field: "1234.50". */
export const amountText = (cents: number) => (cents / 100).toFixed(2)

/** "every month", "every 2 weeks", "every year", "once". */
export function howOften(b: Pick<BillFields, 'unit' | 'every'>): string {
  if (b.unit === 'once') return 'once'
  const word = { week: 'week', month: 'month', year: 'year' }[b.unit]
  return b.every === 1 ? `every ${word}` : `every ${b.every} ${word}s`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "25 Nov", or "25 Nov 2027" if not this year. */
export function shortDate(iso: string | null | undefined, today: string): string {
  if (!iso) return ''
  const d = `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`
  return iso.slice(0, 4) === today.slice(0, 4) ? d : `${d} ${iso.slice(0, 4)}`
}

/** Whole days from `today` to `iso`. */
export const daysFrom = (today: string, iso: string) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)

/** "today", "tomorrow", "in 5 days", "3 days ago". */
export function relative(today: string, iso: string): string {
  const n = daysFrom(today, iso)
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n === -1) return 'yesterday'
  return n > 0 ? `in ${n} days` : `${-n} days ago`
}

/** The change over the last year, from the price history: "+15% in a year", or null. */
export function yearlyChange(b: Pick<BillFields, 'prices' | 'amount'>, today: string): string | null {
  const yearAgo = `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`
  const before = [...b.prices].filter((p) => p.from <= yearAgo).pop()
  if (!before || before.amount === 0 || before.amount === b.amount) return null
  const pct = Math.round(((b.amount - before.amount) / before.amount) * 100)
  return `${pct > 0 ? '+' : ''}${pct}% in a year`
}

/** A new bill or subscription, ready for the form. */
export function blankBill(type: 'bill' | 'subscription', today: string): BillFields {
  return {
    type,
    name: '',
    payeeId: null,
    category: type === 'subscription' ? 'Streaming and apps' : 'Other',
    amount: 0,
    every: 1,
    unit: 'month',
    firstDue: today,
    method: type === 'subscription' ? 'card' : 'debit',
    accountId: null,
    policyId: null,
    remind: [],
    contractStart: null,
    contractEnd: null,
    noticeDays: null,
    plan: '',
    trialEnd: null,
    reviewMonths: type === 'subscription' ? 12 : null,
    reviewedOn: null,
    users: [],
    cancelHow: '',
    status: 'active',
    cancelledOn: null,
    prices: [],
    payments: [],
    problems: [],
    notes: '',
    addedOn: today,
  }
}

/** What goes back to the server: the stored fields only. */
export function billFields(b: Bill | BillFields): BillFields {
  const { type, name, payeeId, category, amount, every, unit, firstDue, method, accountId, policyId, remind, contractStart, contractEnd, noticeDays, plan, trialEnd, reviewMonths, reviewedOn, users, cancelHow, status, cancelledOn, prices, payments, problems, notes, addedOn } = b
  return { type, name, payeeId, category, amount, every, unit, firstDue, method, accountId, policyId, remind, contractStart, contractEnd, noticeDays, plan, trialEnd, reviewMonths, reviewedOn, users, cancelHow, status, cancelledOn, prices, payments, problems, notes, addedOn }
}
