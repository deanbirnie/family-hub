/**
 * South African public holidays, worked out by the hub itself (no outside
 * service): the fixed days, Good Friday and Family Day from the date of
 * Easter, and the Public Holidays Act's rule that a holiday on a Sunday makes
 * the Monday a holiday too. One-off days the President declares (e.g. for an
 * election) are not included.
 */

const FIXED: [number, number, string][] = [
  [1, 1, 'New Year’s Day'],
  [3, 21, 'Human Rights Day'],
  [4, 27, 'Freedom Day'],
  [5, 1, 'Workers’ Day'],
  [6, 16, 'Youth Day'],
  [8, 9, 'National Women’s Day'],
  [9, 24, 'Heritage Day'],
  [12, 16, 'Day of Reconciliation'],
  [12, 25, 'Christmas Day'],
  [12, 26, 'Day of Goodwill'],
]

/** Easter Sunday (Gregorian), by the anonymous Gregorian algorithm. */
export function easter(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

const DAY = 86_400_000
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10)
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()

/** The year's public holidays, in date order. */
export function southAfricanHolidays(year: number): { date: string; name: string }[] {
  const out: { date: string; name: string }[] = FIXED.map(([m, d, name]) => ({ date: `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`, name }))
  const e = easter(year)
  out.push({ date: shift(e, -2), name: 'Good Friday' }, { date: shift(e, 1), name: 'Family Day' })
  // A holiday on a Sunday: the Monday is a public holiday too.
  for (const h of [...out]) {
    if (weekday(h.date) === 0) {
      const monday = shift(h.date, 1)
      if (!out.some((x) => x.date === monday)) out.push({ date: monday, name: `Public holiday (${h.name} observed)` })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}
