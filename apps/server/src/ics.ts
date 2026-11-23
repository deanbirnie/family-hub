/**
 * Reads iCalendar (.ics) files from outside calendars (school terms, sport
 * fixtures, a Google Calendar link or export), with no dependencies. Only
 * what the hub's calendar can hold is kept: title, times, location,
 * description, a simple repeat rule, and whether it was cancelled. Times are
 * turned into the family's time zone. The file is read as data only.
 */
import type { Repeat, Weekday } from './recurrence.ts'
import { WEEKDAYS } from './recurrence.ts'
import { zonedToEpoch } from './schedule.ts'

export interface IcsEvent {
  uid: string
  title: string
  allDay: boolean
  /** YYYY-MM-DD, or YYYY-MM-DDTHH:MM in the family's time zone. */
  start: string
  end: string
  location: string
  notes: string
  repeat: Repeat | null
  cancelled: boolean
}

interface Prop {
  name: string
  params: Record<string, string>
  value: string
}

const unescape = (v: string) => v.replace(/\\[nN]/g, '\n').replace(/\\([,;\\])/g, '$1')

function readProps(text: string): Prop[] {
  const lines: string[] = []
  for (const line of text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) lines[lines.length - 1] += line.slice(1)
    else lines.push(line)
  }
  const out: Prop[] = []
  for (const line of lines) {
    // The value starts at the first colon that is not inside a quoted parameter.
    let quoted = false
    let colon = -1
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') quoted = !quoted
      else if (line[i] === ':' && !quoted) {
        colon = i
        break
      }
    }
    if (colon < 0) continue
    const [name, ...parts] = line.slice(0, colon).split(';')
    const params: Record<string, string> = {}
    for (const p of parts) {
      const eq = p.indexOf('=')
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '')
    }
    out.push({ name: name!.toUpperCase(), params, value: line.slice(colon + 1) })
  }
  return out
}

const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** An instant as a local time in a time zone: YYYY-MM-DDTHH:MM. */
function localIn(ms: number, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  )
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`
}

/** A DTSTART/DTEND value: an all-day date, or a time in the family's zone. Null if unreadable. */
export function readIcsTime(prop: Prop, familyZone: string): { allDay: boolean; value: string } | null {
  const v = prop.value.trim()
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (m || prop.params.VALUE === 'DATE') {
    m ??= /^(\d{4})(\d{2})(\d{2})/.exec(v)
    return m ? { allDay: true, value: `${m[1]}-${m[2]}-${m[3]}` } : null
  }
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z?)$/.exec(v)
  if (!m) return null
  const local = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`
  if (m[7] === 'Z') return { allDay: false, value: localIn(Date.parse(`${local}:00Z`), familyZone) }
  const tz = prop.params.TZID
  // A named zone (Google, Apple) is converted; anything else (e.g. Outlook's Windows names) is taken as the family's own.
  if (tz && tz !== familyZone && validZone(tz)) return { allDay: false, value: localIn(zonedToEpoch(local, tz), familyZone) }
  return { allDay: false, value: local }
}

/** A simple RRULE the hub can hold; null for anything it cannot (then only the first occurrence is kept). */
export function readRRule(value: string): Repeat | null | 'unsupported' {
  const parts = Object.fromEntries(value.split(';').map((p) => p.split('=') as [string, string]))
  const freq = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[parts.FREQ ?? ''] as Repeat['freq'] | undefined
  if (!freq) return 'unsupported'
  const repeat: Repeat = { freq, interval: Math.max(1, Math.min(99, Number(parts.INTERVAL ?? 1) || 1)) }
  if (parts.BYDAY) {
    const days = parts.BYDAY.split(',')
    if (freq === 'weekly' && days.every((d) => WEEKDAYS.includes(d as Weekday))) repeat.byDay = days as Weekday[]
    else if (freq === 'monthly' && days.length === 1 && /^(-1|[1-5])(MO|TU|WE|TH|FR|SA|SU)$/.test(days[0]!)) repeat.monthlyBy = 'weekday'
    else return 'unsupported'
  }
  if (parts.BYMONTHDAY || parts.BYSETPOS || parts.BYHOUR || parts.BYWEEKNO || parts.BYYEARDAY) return 'unsupported'
  if (parts.UNTIL) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(parts.UNTIL)
    if (m) repeat.until = `${m[1]}-${m[2]}-${m[3]}`
  } else if (parts.COUNT) {
    repeat.count = Math.max(1, Math.min(1000, Number(parts.COUNT) || 1))
  }
  return repeat
}

const DAY = 86_400_000
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)

/** Reads the events in an iCalendar file. Changed single days of a series (RECURRENCE-ID) are left out. */
export function parseIcs(text: string, familyZone: string, limit = 5000): IcsEvent[] {
  const out: IcsEvent[] = []
  let current: Prop[] | null = null
  let depth = 0
  for (const p of readProps(text)) {
    if (p.name === 'BEGIN' && p.value.toUpperCase() === 'VEVENT') {
      current = []
      depth = 0
    } else if (current && p.name === 'BEGIN') depth++
    else if (current && p.name === 'END' && p.value.toUpperCase() !== 'VEVENT') depth--
    else if (current && p.name === 'END' && p.value.toUpperCase() === 'VEVENT') {
      const e = toEvent(current, familyZone)
      if (e) out.push(e)
      current = null
      if (out.length >= limit) break
    } else if (current && depth === 0) current.push(p)
  }
  return out
}

function toEvent(props: Prop[], zone: string): IcsEvent | null {
  const one = (n: string) => props.find((p) => p.name === n)
  if (one('RECURRENCE-ID')) return null
  const uid = one('UID')?.value.trim()
  const dtstart = one('DTSTART')
  if (!uid || !dtstart) return null
  const start = readIcsTime(dtstart, zone)
  if (!start) return null
  let end: string
  const dtend = one('DTEND')
  const endTime = dtend ? readIcsTime(dtend, zone) : null
  if (endTime && endTime.allDay === start.allDay && endTime.value >= start.value) {
    // iCalendar all-day ends are exclusive: the hub keeps the last day.
    end = start.allDay ? (endTime.value > start.value ? addDays(endTime.value, -1) : start.value) : endTime.value
  } else {
    const dur = one('DURATION')?.value
    const m = dur ? /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(dur) : null
    if (m && !start.allDay) {
      const minutes = (Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0)) * 1440 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0)
      end = new Date(Date.parse(`${start.value}:00Z`) + minutes * 60_000).toISOString().slice(0, 16)
    } else if (m && start.allDay) {
      end = addDays(start.value, Math.max(0, Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0) - 1))
    } else end = start.value
  }
  const rrule = one('RRULE')
  const repeat = rrule ? readRRule(rrule.value) : null
  return {
    uid: uid.slice(0, 300),
    title: (unescape(one('SUMMARY')?.value ?? '').trim() || 'Untitled').slice(0, 200),
    allDay: start.allDay,
    start: start.value,
    end,
    location: unescape(one('LOCATION')?.value ?? '').trim().slice(0, 300),
    notes: unescape(one('DESCRIPTION')?.value ?? '').trim().slice(0, 4000),
    repeat: repeat === 'unsupported' ? null : repeat,
    cancelled: (one('STATUS')?.value ?? '').toUpperCase() === 'CANCELLED',
  }
}
