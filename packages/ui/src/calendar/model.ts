/** The family calendar's data, as the server sends it, and date helpers for the views. */

export const FAMILY = 'family'

export interface Person {
  id: string
  displayName: string
  userId: string | null
  colour: string | null
}

export type Weekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU'
export const WEEKDAYS: Weekday[] = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']
export const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export interface Repeat {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  interval: number
  byDay?: Weekday[]
  monthlyBy?: 'date' | 'weekday'
  until?: string | null
  count?: number | null
}

/** One day's occurrence of an event. */
export interface Occurrence {
  eventId: string
  version: number
  /** The day it was due (the key for changing just this one). */
  day: string
  title: string
  allDay: boolean
  start: string
  end: string
  tags: string[]
  location: string
  notes: string
  contactId: string | null
  fileId: string | null
  fileName: string | null
  repeat: Repeat | null
  /** Minutes before the start to remind. */
  reminders: number[]
  changed: boolean
  /** Birthdays and other dates from Contacts: shown, not edited here. */
  readOnly?: boolean
  kind?: 'birthday' | 'anniversary' | 'memorial' | 'other' | 'holiday'
  /** "turns 80", "Wade’s · turns 4". */
  detail?: string | null
}

/** Reminder choices for timed and all-day events. */
export const TIMED_REMINDERS: [number, string][] = [
  [0, 'At the time'],
  [15, '15 minutes before'],
  [60, '1 hour before'],
  [1440, '1 day before'],
  [10080, '1 week before'],
]
export const ALL_DAY_REMINDERS: [number, string][] = [
  [0, 'On the day (08:00)'],
  [1440, 'The day before (08:00)'],
  [10080, 'A week before (08:00)'],
]

/** Colours offered for people; anyone without one gets one of these by position. */
export const PALETTE = ['#2f6d8c', '#d9774b', '#2f7d4f', '#8a5cc2', '#c2457a', '#b08a00', '#3a8f9e', '#6b7280']
export const FAMILY_COLOUR = '#d9774b'

export const colourOf = (people: Person[], id: string) => {
  if (id === FAMILY) return FAMILY_COLOUR
  const i = people.findIndex((p) => p.id === id)
  if (i < 0) return '#9aa0a6'
  return people[i]!.colour ?? PALETTE[i % PALETTE.length]!
}

// ---- dates (calendar days, YYYY-MM-DD, in the family's time zone) ----------------------

const pad = (n: number) => String(n).padStart(2, '0')
export const isoDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
export const today = () => isoDay(new Date())
const toDate = (day: string) => new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))
export const addDays = (day: string, n: number) => {
  const d = toDate(day)
  d.setDate(d.getDate() + n)
  return isoDay(d)
}
export const addMonths = (day: string, n: number) => {
  const d = toDate(day)
  d.setDate(1)
  d.setMonth(d.getMonth() + n)
  return isoDay(d)
}
export const daysBetween = (from: string, to: string) => Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000)
/** Monday = 0 … Sunday = 6. */
export const weekdayIndex = (day: string) => (toDate(day).getDay() + 6) % 7
export const startOfWeek = (day: string) => addDays(day, -weekdayIndex(day))
export const startOfMonth = (day: string) => `${day.slice(0, 8)}01`
export const dayOf = (v: string) => v.slice(0, 10)
export const timeOf = (v: string) => (v.length > 10 ? v.slice(11, 16) : '')

export const formatDay = (day: string, opts: Intl.DateTimeFormatOptions = { weekday: 'long', day: 'numeric', month: 'long' }) =>
  toDate(day).toLocaleDateString(undefined, opts)
export const formatMonth = (day: string) => toDate(day).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })

/** "09:30–10:00", "All day", or "Tue 24 Nov 09:30 – Wed 25 Nov 11:00" for several days. */
export function whenText(o: Pick<Occurrence, 'allDay' | 'start' | 'end'>): string {
  const sameDay = dayOf(o.start) === dayOf(o.end)
  if (o.allDay) return sameDay ? 'All day' : `${formatDay(dayOf(o.start), { day: 'numeric', month: 'short' })} – ${formatDay(dayOf(o.end), { day: 'numeric', month: 'short' })}`
  if (sameDay) return o.start === o.end ? timeOf(o.start) : `${timeOf(o.start)}–${timeOf(o.end)}`
  return `${formatDay(dayOf(o.start), { weekday: 'short', day: 'numeric', month: 'short' })} ${timeOf(o.start)} – ${formatDay(dayOf(o.end), { weekday: 'short', day: 'numeric', month: 'short' })} ${timeOf(o.end)}`
}

/** Whether an occurrence is on a given day (multi-day events show on each). */
export const isOn = (o: Pick<Occurrence, 'start' | 'end'>, day: string) => dayOf(o.start) <= day && dayOf(o.end) >= day

/** A short description of a repeat: "Every week on Tue, Thu". */
export function repeatText(r: Repeat | null): string {
  if (!r) return 'Does not repeat'
  const unit = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' }[r.freq]
  let s = r.interval > 1 ? `Every ${r.interval} ${unit}s` : `Every ${unit}`
  if (r.freq === 'weekly' && r.byDay?.length) s += ` on ${r.byDay.map((d) => WEEKDAY_SHORT[WEEKDAYS.indexOf(d)]).join(', ')}`
  if (r.freq === 'monthly' && r.monthlyBy === 'weekday') s += ' (same weekday)'
  if (r.until) s += `, until ${formatDay(r.until, { day: 'numeric', month: 'short', year: 'numeric' })}`
  else if (r.count) s += `, ${r.count} times`
  return s
}

/** Which view: mine (my events and Family), one person's (theirs and Family), or everyone's. */
export type ViewOf = { kind: 'me' } | { kind: 'person'; id: string } | { kind: 'everyone' }

export function shows(view: ViewOf, me: string | null, o: Pick<Occurrence, 'tags'>): boolean {
  if (view.kind === 'everyone') return true
  if (o.tags.includes(FAMILY)) return true
  const who = view.kind === 'me' ? me : view.id
  return who !== null && o.tags.includes(who)
}
