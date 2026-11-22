/**
 * Repeating calendar events: which days a series falls on.
 *
 * Dates are calendar days (YYYY-MM-DD) in the family's time zone. A series
 * repeats daily, weekly (on chosen weekdays), monthly (on a day of the month,
 * or e.g. "the 2nd Tuesday" / "the last Friday") or yearly, every N, until a
 * date or for a number of times. Months without the day (31 June) and
 * 29 February in other years are skipped, as most calendar apps do.
 */

export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export interface Repeat {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly'
  /** Every N days / weeks / months / years. */
  interval: number
  /** Weekly: which days (default: the start's weekday). */
  byDay?: Weekday[]
  /** Monthly: on the same date, or the same weekday of the month (2nd Tuesday; 5th means last). */
  monthlyBy?: 'date' | 'weekday'
  /** Last possible day (inclusive), YYYY-MM-DD. */
  until?: string | null
  /** Or: how many times in all. */
  count?: number | null
}

const DAY = 86_400_000
export const dayNum = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY
export const fromDayNum = (n: number) => new Date(n * DAY).toISOString().slice(0, 10)
export const addDays = (date: string, days: number) => fromDayNum(dayNum(date) + days)
/** Monday = 0 … Sunday = 6. */
export const weekdayOf = (date: string) => (new Date(dayNum(date) * DAY).getUTCDay() + 6) % 7
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

/** Which week of the month a date is in (1–5), and whether it is the last such weekday. */
export function nthWeekday(date: string): { nth: number; last: boolean } {
  const d = Number(date.slice(8, 10))
  const dim = daysInMonth(Number(date.slice(0, 4)), Number(date.slice(5, 7)))
  return { nth: Math.ceil(d / 7), last: d + 7 > dim }
}

/** The day in month (y, m) that is the nth (or last) of a weekday; null if none. */
function nthWeekdayIn(y: number, m: number, weekday: number, nth: number, last: boolean): number | null {
  const dim = daysInMonth(y, m)
  if (last) {
    const lastWd = (new Date(Date.UTC(y, m - 1, dim)).getUTCDay() + 6) % 7
    return dim - ((lastWd - weekday + 7) % 7)
  }
  const firstWd = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7
  const day = 1 + ((weekday - firstWd + 7) % 7) + (nth - 1) * 7
  return day <= dim ? day : null
}

const MAX_OCCURRENCES = 5000

/**
 * The days a series starting on `start` falls on, between `from` and `to`
 * (inclusive). `count` counts from the start, not from `from`.
 */
export function occurrences(start: string, repeat: Repeat | null, from: string, to: string): string[] {
  if (!repeat) return start >= from && start <= to ? [start] : []
  const interval = Math.max(1, Math.floor(repeat.interval || 1))
  const until = repeat.until && repeat.until < to ? repeat.until : to
  const out: string[] = []
  let n = 0
  const emit = (date: string): boolean => {
    // Returns false when the series is over.
    if (date > until) return false
    if (repeat.count && n >= repeat.count) return false
    n++
    if (date >= from) out.push(date)
    return n < MAX_OCCURRENCES
  }
  const [sy, sm, sd] = [Number(start.slice(0, 4)), Number(start.slice(5, 7)), Number(start.slice(8, 10))]

  switch (repeat.freq) {
    case 'daily': {
      for (let d = dayNum(start); ; d += interval) if (!emit(fromDayNum(d))) break
      break
    }
    case 'weekly': {
      const days = (repeat.byDay?.length ? repeat.byDay : [WEEKDAYS[weekdayOf(start)]!]).map((w) => WEEKDAYS.indexOf(w)).sort((a, b) => a - b)
      const weekStart = dayNum(start) - weekdayOf(start)
      outer: for (let w = weekStart; ; w += 7 * interval) {
        for (const wd of days) {
          const d = w + wd
          if (d < dayNum(start)) continue
          if (!emit(fromDayNum(d))) break outer
        }
      }
      break
    }
    case 'monthly': {
      const byWeekday = repeat.monthlyBy === 'weekday'
      const { nth, last } = nthWeekday(start)
      const wd = weekdayOf(start)
      for (let i = 0; ; i += interval) {
        const y = sy + Math.floor((sm - 1 + i) / 12)
        const m = ((sm - 1 + i) % 12) + 1
        const day = byWeekday ? nthWeekdayIn(y, m, wd, nth, last && nth >= 5) : sd <= daysInMonth(y, m) ? sd : null
        if (day === null) {
          // Skipped month; stop if we are already past the end.
          if (ymd(y, m, 1) > until) break
          continue
        }
        if (!emit(ymd(y, m, day))) break
      }
      break
    }
    case 'yearly': {
      for (let i = 0; ; i += interval) {
        const y = sy + i
        if (sd > daysInMonth(y, sm)) {
          if (ymd(y, sm, 1) > until) break
          continue
        }
        if (!emit(ymd(y, sm, sd))) break
      }
      break
    }
  }
  return out
}

/** The series as an iCalendar RRULE (RFC 5545). */
export function toRRule(start: string, repeat: Repeat): string {
  const parts = [`FREQ=${repeat.freq.toUpperCase()}`]
  if (repeat.interval > 1) parts.push(`INTERVAL=${repeat.interval}`)
  if (repeat.freq === 'weekly' && repeat.byDay?.length) parts.push(`BYDAY=${repeat.byDay.join(',')}`)
  if (repeat.freq === 'monthly' && repeat.monthlyBy === 'weekday') {
    const { nth, last } = nthWeekday(start)
    parts.push(`BYDAY=${last && nth >= 5 ? -1 : nth}${WEEKDAYS[weekdayOf(start)]}`)
  }
  if (repeat.until) parts.push(`UNTIL=${repeat.until.replace(/-/g, '')}`)
  else if (repeat.count) parts.push(`COUNT=${repeat.count}`)
  return `RRULE:${parts.join(';')}`
}
