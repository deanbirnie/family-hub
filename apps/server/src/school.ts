/**
 * School (phase 7a): for each child, the school and class each year with
 * its terms, the school's contacts (from Contacts), extra-murals by term,
 * and reminders for the irregular things (a costume on Friday, money for the
 * tuck shop, plan for the book-week outfit).
 *
 * Sealed with the server key (docs/DATA-PROTECTION.md, "School hub"). Dates
 * go to the calendar, fees to Bills, costs to planned expenses, documents to
 * the School folder in Files: this page links to them rather than copying.
 */
import type { Services } from './app.ts'
import { bad, cents, date, id, int, list, obj, oneOf, text } from './household.ts'
import type { ReminderItem } from './notifications.ts'
import { localNow } from './schedule.ts'

export type SchoolKind = 'year' | 'contact' | 'activity' | 'reminder' | 'form' | 'list'
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export interface SchoolYear {
  year: number
  school: string
  /** Grade, class or group, e.g. "Grade R", "Butterflies". */
  grade: string
  /** Terms with their dates, as the school gives them. */
  terms: { name: string; start: string; end: string }[]
  /** The fees, as a bill in Bills & budget. */
  feesBillId: string | null
  notes: string
}

export const ROLES = ['teacher', 'assistant', 'principal', 'office', 'aftercare', 'coach', 'lift club', 'other'] as const
export type Role = (typeof ROLES)[number]

export interface SchoolContact {
  contactId: string
  role: Role
  note: string
}

export interface Activity {
  name: string
  /** Who runs it: a club, coach or company. */
  who: string
  /** Their entry in Contacts. */
  contactId: string | null
  location: string
  /** When it happens each week. */
  sessions: { day: Weekday; start: string; end: string }[]
  /** The term (or dates) it runs. */
  from: string
  to: string
  term: string
  /** Who to call to cancel or postpone (from Contacts), and/or a number. */
  cancelContactId: string | null
  cancelPhone: string
  cost: number | null
  costPer: 'term' | 'month' | 'year' | 'session' | 'once'
  /** Where it is paid: a bill, an invoice or a planned expense in Bills & budget. */
  billId: string | null
  invoiceId: string | null
  plannedId: string | null
  /** Its weekly events on the calendar, one per session. */
  eventIds: string[]
  notes: string
}

export interface SchoolReminder {
  what: string
  date: string
  /** Days before to remind, e.g. [7, 1, 0]. */
  leads: number[]
  notes: string
  done: boolean
}

/** A form or permission slip: what it needs, by when, and whether it is done. */
export interface SchoolForm {
  what: string
  needs: 'sign' | 'pay' | 'sign and pay' | 'return'
  amount: number | null
  due: string
  /** The form itself, scanned or downloaded, in the child's School folder. */
  documents: { id: string; name: string }[]
  done: boolean
  doneOn: string | null
  notes: string
}

/** A list for a school year: uniform, stationery, kit, or what to bring on which day. */
export interface SchoolList {
  type: 'uniform' | 'stationery' | 'kit' | 'bring'
  name: string
  year: number
  items: { text: string; qty: string; done: boolean; day: Weekday | null }[]
  notes: string
}

export type SchoolItem = SchoolYear | SchoolContact | Activity | SchoolReminder | SchoolForm | SchoolList

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/

export function cleanSchool(kind: SchoolKind, raw: unknown): SchoolItem {
  const o = obj(raw)
  if (kind === 'year') {
    return {
      year: int(o.year, 'The year', 2000, 2100),
      school: text(o, 'school', 120, 'The school', true),
      grade: text(o, 'grade', 60, 'The grade or class'),
      terms: list(o.terms, 6, 'Terms').map((t) => {
        const e = obj(t)
        const start = date(e, 'start', 'A term’s start', true)!
        const end = date(e, 'end', 'A term’s end', true)!
        if (end < start) bad('A term ends before it starts.')
        return { name: text(e, 'name', 30, 'A term’s name', true), start, end }
      }),
      feesBillId: id(o, 'feesBillId'),
      notes: text(o, 'notes', 2000, 'Notes'),
    }
  }
  if (kind === 'contact') {
    return { contactId: id(o, 'contactId') ?? bad('Choose the contact.'), role: oneOf(o.role, ROLES, 'The role', 'other'), note: text(o, 'note', 200, 'A note') }
  }
  if (kind === 'activity') {
    const from = date(o, 'from', 'The first day', true)!
    const to = date(o, 'to', 'The last day', true)!
    if (to < from) bad('It ends before it starts.')
    return {
      name: text(o, 'name', 80, 'The activity', true),
      who: text(o, 'who', 120, 'Who runs it'),
      contactId: id(o, 'contactId'),
      location: text(o, 'location', 200, 'Where'),
      sessions: list(o.sessions, 7, 'When').map((x) => {
        const e = obj(x)
        const start = typeof e.start === 'string' && TIME.test(e.start) ? e.start : bad('A start time must be like 14:30.')
        const end = typeof e.end === 'string' && TIME.test(e.end) ? e.end : bad('An end time must be like 15:30.')
        if (end <= start) bad('A session ends before it starts.')
        return { day: oneOf(e.day, WEEKDAYS, 'A day'), start, end }
      }),
      from,
      to,
      term: text(o, 'term', 30, 'The term'),
      cancelContactId: id(o, 'cancelContactId'),
      cancelPhone: text(o, 'cancelPhone', 30, 'The number to cancel'),
      cost: o.cost === null || o.cost === undefined || o.cost === '' ? null : cents(o.cost, 'The cost'),
      costPer: oneOf(o.costPer, ['term', 'month', 'year', 'session', 'once'] as const, 'What the cost is for', 'term'),
      billId: id(o, 'billId'),
      invoiceId: id(o, 'invoiceId'),
      plannedId: id(o, 'plannedId'),
      eventIds: list(o.eventIds, 7, 'Calendar events').map((v) => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : bad('A calendar event is not valid.'))),
      notes: text(o, 'notes', 2000, 'Notes'),
    }
  }
  if (kind === 'form') {
    const done = o.done === true
    return {
      what: text(o, 'what', 200, 'What it is', true),
      needs: oneOf(o.needs, ['sign', 'pay', 'sign and pay', 'return'] as const, 'What it needs', 'sign'),
      amount: o.amount === null || o.amount === undefined || o.amount === '' ? null : cents(o.amount, 'The amount'),
      due: date(o, 'due', 'The deadline', true)!,
      documents: list(o.documents, 10, 'Documents').map((d) => {
        const e = obj(d)
        return { id: id(e, 'id') ?? bad('A document is not valid.'), name: text(e, 'name', 240, 'A document name', true) }
      }),
      done,
      doneOn: done ? date(o, 'doneOn', 'The day it was done') : null,
      notes: text(o, 'notes', 1000, 'Notes'),
    }
  }
  if (kind === 'list') {
    const type = oneOf(o.type, ['uniform', 'stationery', 'kit', 'bring'] as const, 'The kind of list')
    return {
      type,
      name: text(o, 'name', 80, 'The name', true),
      year: int(o.year, 'The year', 2000, 2100),
      items: list(o.items, 300, 'Items').map((x) => {
        const e = obj(x)
        return {
          text: text(e, 'text', 200, 'An item', true),
          qty: text(e, 'qty', 30, 'How many'),
          done: e.done === true,
          day: type === 'bring' ? oneOf(e.day, WEEKDAYS, 'The day') : null,
        }
      }),
      notes: text(o, 'notes', 1000, 'Notes'),
    }
  }
  return {
    what: text(o, 'what', 200, 'What', true),
    date: date(o, 'date', 'The date', true)!,
    leads: [...new Set(list(o.leads, 5, 'Reminders').map((n) => int(n, 'A reminder', 0, 60)))].sort((a, b) => b - a),
    notes: text(o, 'notes', 1000, 'Notes'),
    done: o.done === true,
  }
}

// ---- reading ----------------------------------------------------------------------------------

interface Row {
  id: string
  kind: SchoolKind
  profile_id: string | null
  sealed: string
  version: number
}

export const sealSchool = (s: Services, kind: SchoolKind, id: string, item: SchoolItem) => s.serverKey.seal(JSON.stringify(item), 'school', `${kind}:${id}`)
const openSchool = (s: Services, r: Row) => JSON.parse(s.serverKey.open(r.sealed, 'school', `${r.kind}:${r.id}`)) as SchoolItem

export function readSchool(s: Services, kind?: SchoolKind): { id: string; kind: SchoolKind; profileId: string | null; version: number; item: SchoolItem }[] {
  const rows = (kind ? s.db.prepare('SELECT * FROM school WHERE kind = ? ORDER BY created_at, id').all(kind) : s.db.prepare('SELECT * FROM school ORDER BY created_at, id').all()) as unknown as Row[]
  return rows.map((r) => ({ id: r.id, kind: r.kind, profileId: r.profile_id, version: r.version, item: openSchool(s, r) }))
}

// ---- reminders ----------------------------------------------------------------------------------

/** School reminders not yet done. Generic notification text; the details show in the app. */
export function schoolItems(s: Services): ReminderItem[] {
  if (!s.db.prepare("SELECT 1 FROM school WHERE kind IN ('reminder', 'form') LIMIT 1").get()) return []
  const today = localNow(s.now(), s.config.timeZone).date
  const names = new Map((s.db.prepare('SELECT id, display_name FROM family_profiles').all() as { id: string; display_name: string }[]).map((p) => [p.id, p.display_name]))
  const reminders: ReminderItem[] = readSchool(s, 'reminder')
    .filter((r) => !(r.item as SchoolReminder).done && (r.item as SchoolReminder).date >= today)
    .map((r) => {
      const rem = r.item as SchoolReminder
      return {
        key: `sr:${r.id}`,
        category: 'school' as const,
        title: rem.what,
        whose: r.profileId ? (names.get(r.profileId) ?? null) : null,
        due: { date: rem.date, yearly: false },
        leads: rem.leads.length ? rem.leads : [0],
        notice: () => 'A school reminder is due. Tap to see.',
        url: '/school',
        audience: 'all',
        horizon: 14,
        detail: () => rem.notes || null,
      }
    })
  // Forms and permission slips: reminded before the deadline until done.
  const forms: ReminderItem[] = readSchool(s, 'form')
        .filter((r) => !(r.item as SchoolForm).done && (r.item as SchoolForm).due >= today)
        .map((r) => {
          const f = r.item as SchoolForm
          return {
            key: `sf:${r.id}`,
            category: 'school' as const,
            title: `${f.what} (${f.needs}${f.amount !== null ? ` R ${(f.amount / 100).toFixed(2)}` : ''})`,
            whose: r.profileId ? (names.get(r.profileId) ?? null) : null,
            due: { date: f.due, yearly: false },
            leads: [3, 1, 0],
            notice: () => 'A school form is due. Tap to see.',
            url: '/school',
            audience: 'all',
            horizon: 21,
            detail: () => f.notes || null,
          }
        })
  return [...reminders, ...forms]
}
