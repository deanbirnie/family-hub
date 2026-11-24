/** The budget (phase 6c): what the server sends, and small helpers for the page. */

export type Group = 'giving' | 'saving' | 'essentials' | 'debt' | 'lifestyle'
export const GROUP_NAMES: [Group, string][] = [
  ['giving', 'Giving'],
  ['saving', 'Saving'],
  ['essentials', 'Essentials (food, utilities, housing, transport)'],
  ['debt', 'Debt'],
  ['lifestyle', 'Everything else'],
]
export type Role = '' | 'emergency' | 'retirement' | 'education'

export interface Category {
  id: string
  name: string
  group: Group
  sinking: boolean
  role: Role
  opening: number
}
export interface Line {
  id: string
  categoryId: string
  label: string
  amount: number
  source: string
}
export interface MonthPlan {
  month: string
  income: { id: string; label: string; amount: number }[]
  lines: Line[]
  moves: { date: string; from: string; to: string; amount: number; note: string }[]
  notes: string
}
export interface Planned {
  id: string
  version: number
  name: string
  amount: number
  month: string
  categoryId: string | null
  saveFrom: string | null
  profileId: string | null
  tag: string
  done: boolean
  notes: string
}
export type DebtKind = 'credit-card' | 'store-card' | 'car' | 'personal' | 'student' | 'family' | 'other'
export const DEBT_KINDS: [DebtKind, string][] = [
  ['credit-card', 'Credit card'],
  ['store-card', 'Store card'],
  ['car', 'Car finance'],
  ['personal', 'Personal loan'],
  ['student', 'Student loan'],
  ['family', 'Owed to family or friends'],
  ['other', 'Other'],
]
export interface Debt {
  id: string
  version: number
  name: string
  kind: DebtKind
  balance: number
  balanceOn: string
  rate: number
  minimum: number
  history: { date: string; balance: number }[]
  paidOff: string | null
  notes: string
}
export interface Milestones {
  starterTarget: number
  fundMonths: number
  extraDebt: number
  ticks: Record<string, { done: boolean; note: string }>
}
export interface Txn {
  id: string
  version: number
  date: string
  description: string
  amount: number
  accountId: string | null
  categoryId: string | null
  note: string
}

export interface BudgetView {
  today: string
  month: string
  categories: Category[]
  categoriesVersion: number
  plan: MonthPlan | null
  planVersion: number
  months: string[]
  transactions: Txn[]
  spent: Record<string, number>
  incomeActual: number
  uncategorised: number
  sinking: Record<string, number>
  suggested: Line[]
  planned: Planned[]
  debts: Debt[]
  snowball: { order: { id: string; payment: number; payoffMonth: string | null }[]; debtFree: string | null }
  milestones: Milestones
  milestonesVersion: number
  progress: { emergency: number | null; essentialMonth: number; debtLeft: number; retirementPlanned: number | null; income: number }
  accounts: { id: string; bank: string; nickname: string }[]
}

export interface Summary {
  categories: Category[]
  months: { month: string; incomePlanned: number; incomeActual: number; byCategory: Record<string, { planned: number; spent: number }> }[]
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "December 2026" */
export const monthName = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`
/** "Dec" or "Dec 27" */
export const monthShort = (m: string, thisYear?: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]!.slice(0, 3)}${thisYear && m.slice(0, 4) !== thisYear ? ` ${m.slice(2, 4)}` : ''}`

export function addMonths(m: string, n: number): string {
  const y = Number(m.slice(0, 4))
  const i = Number(m.slice(5, 7)) - 1 + n
  return `${y + Math.floor(i / 12)}-${String((((i % 12) + 12) % 12) + 1).padStart(2, '0')}`
}

/** A category's planned amount: its lines, plus money moved in, less money moved out. */
export function plannedFor(plan: MonthPlan | null, categoryId: string): number {
  if (!plan) return 0
  return (
    plan.lines.filter((l) => l.categoryId === categoryId).reduce((n, l) => n + l.amount, 0) +
    plan.moves.reduce((n, m) => n + (m.to === categoryId ? m.amount : 0) - (m.from === categoryId ? m.amount : 0), 0)
  )
}

export const incomeTotal = (plan: MonthPlan | null) => (plan ? plan.income.reduce((n, i) => n + i.amount, 0) : 0)
export const linesTotal = (plan: MonthPlan | null) => (plan ? plan.lines.reduce((n, l) => n + l.amount, 0) : 0)

/** A new random ID for a line. */
export const newLineId = () => `l-${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`

/**
 * When income comes in bits: the categories in order of priority (as listed),
 * each covered once the income so far reaches it.
 */
export function coverage(categories: Category[], plan: MonthPlan, received: number): { id: string; planned: number; covered: 'yes' | 'part' | 'no' }[] {
  let left = received
  return categories
    .map((c) => ({ id: c.id, planned: plannedFor(plan, c.id) }))
    .filter((c) => c.planned > 0)
    .map((c) => {
      const covered = left >= c.planned ? 'yes' : left > 0 ? 'part' : 'no'
      left -= c.planned
      return { ...c, covered }
    })
}
