/**
 * Dates for reminders: which day something is due, how many days away it
 * is, and which reminder (90, 30 or 7 days before, for example) applies now.
 *
 * Dates are calendar days in the family's time zone (config TZ), written as
 * YYYY-MM-DD, or --MM-DD for a yearly date whose year is unknown (a friend's
 * birthday). Yearly dates come round every year; 29 February falls on
 * 28 February in other years.
 */

export interface Due {
  /** YYYY-MM-DD, or --MM-DD (yearly only). */
  date: string
  yearly: boolean
}

const DATE = /^(\d{4}|--)-?(\d{2})-(\d{2})$/

/** Parses YYYY-MM-DD or --MM-DD; null if it is not a real date. */
export function parseDate(value: string): { year: number | null; month: number; day: number } | null {
  const m = DATE.exec(value)
  if (!m) return null
  if (m[1] === '--' && !value.startsWith('--')) return null
  if (m[1] !== '--' && value.length !== 10) return null
  const year = m[1] === '--' ? null : Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  // Check the day exists (a leap year allows 29 February when the year is unknown).
  const probe = new Date(Date.UTC(year ?? 2000, month - 1, day))
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null
  if (year !== null && (year < 1900 || year > 2200)) return null
  return { year, month, day }
}

/** Today's date (YYYY-MM-DD) and hour in a time zone. */
export function localNow(nowMs: number, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(nowMs))
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
}

const dayNumber = (date: string) => {
  const p = parseDate(date)!
  return Date.UTC(p.year!, p.month - 1, p.day) / 86_400_000
}

export const daysBetween = (from: string, to: string) => dayNumber(to) - dayNumber(from)

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
const pad = (n: number) => String(n).padStart(2, '0')

/** The yearly date in a given year (29 February → 28 February in other years). */
function inYear(month: number, day: number, year: number): string {
  const d = month === 2 && day === 29 && !isLeap(year) ? 28 : day
  return `${year}-${pad(month)}-${pad(d)}`
}

/**
 * The next time something is due, on or after `today`; for a one-off date,
 * the date itself (which may be in the past). Null if the date is invalid.
 */
export function nextOccurrence(due: Due, today: string): string | null {
  const p = parseDate(due.date)
  if (!p) return null
  if (!due.yearly) return p.year === null ? null : due.date
  const year = Number(today.slice(0, 4))
  const thisYear = inYear(p.month, p.day, year)
  return thisYear >= today ? thisYear : inYear(p.month, p.day, year + 1)
}

/** Which reminder applies when `daysLeft` remain: the smallest lead time not yet passed, or null. */
export function applicableLead(daysLeft: number, leads: number[]): number | null {
  if (daysLeft < 0) return null
  const open = leads.filter((l) => l >= daysLeft).sort((a, b) => a - b)
  return open[0] ?? null
}

/** Years since the original date, when the year is known ("turns 40"); null otherwise. */
export function yearsAt(due: Due, occurrence: string): number | null {
  const p = parseDate(due.date)
  if (!p || p.year === null) return null
  return Number(occurrence.slice(0, 4)) - p.year
}
