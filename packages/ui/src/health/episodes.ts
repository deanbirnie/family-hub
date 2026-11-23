/**
 * Episodes (phase 5c): one illness or injury from the first symptom to
 * recovery. An episode, each entry in its timeline and each medicine plan is
 * its own encrypted health record (kinds "episode", "entry" and "plan"),
 * linked by the episode's ID inside the encryption.
 *
 * Times are local to the device ("2026-11-20T14:30"), which is the family's
 * time zone. Dose warnings come only from the limits the parents typed in
 * from the prescription: the hub never suggests a dose.
 */

export const HOUR = 3_600_000
const MINUTE = 60_000

/** Late after this long past the due time. */
export const LATE_AFTER = 15 * MINUTE

export type EntryType = 'observation' | 'dose' | 'doctor' | 'test' | 'note' | 'vitals' | 'round' | 'feeling'

export const ENTRY_TYPES: [EntryType, string][] = [
  ['observation', 'Observation'],
  ['dose', 'Dose given'],
  ['doctor', 'Doctor'],
  ['test', 'Test or result'],
  ['note', 'Note or photo'],
  ['vitals', 'Vitals'],
  ['round', 'Ward round or talk with a doctor'],
  ['feeling', 'How they are feeling'],
]

/** Entry types for a hospital stay only. */
export const HOSPITAL_TYPES: EntryType[] = ['vitals', 'round', 'feeling']

export const SYMPTOMS = [
  'Fever',
  'Cough',
  'Runny nose',
  'Sore throat',
  'Earache',
  'Headache',
  'Vomiting',
  'Diarrhoea',
  'Rash',
  'Tired',
  'Irritable',
  'Breathing fast',
  'Wheezing',
  'Tummy ache',
  'Not sleeping',
]

export const INTAKE: [string, string][] = [
  ['', '—'],
  ['normal', 'Normal'],
  ['less', 'Less than usual'],
  ['little', 'Very little'],
  ['none', 'Nothing'],
]

export const FEELINGS: [string, string][] = [
  ['much-worse', 'Much worse'],
  ['worse', 'Worse'],
  ['same', 'About the same'],
  ['better', 'Better'],
  ['much-better', 'Much better'],
]

export const PLAN_MODES: [string, string][] = [
  ['interval', 'Every so many hours'],
  ['times', 'At set times of day'],
  ['prn', 'Only when needed'],
]

// ---- times ---------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0')

/** "2026-11-20T14:30" for a moment, in this device's time zone. */
export function localStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The moment a local "2026-11-20T14:30" (or a date) stands for; NaN if it is not one. */
export function parseStamp(stamp: string | undefined): number {
  if (!stamp || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/.test(stamp)) return NaN
  const [y, m, d] = [Number(stamp.slice(0, 4)), Number(stamp.slice(5, 7)) - 1, Number(stamp.slice(8, 10))]
  return new Date(y, m, d, Number(stamp.slice(11, 13) || 0), Number(stamp.slice(14, 16) || 0)).getTime()
}

/** "4 h 10 min", "25 min". */
export function span(ms: number): string {
  const total = Math.round(Math.abs(ms) / MINUTE)
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h === 0) return `${m} min`
  return m === 0 ? `${h} h` : `${h} h ${m} min`
}

/** "14:30" today, "Tue 14:30" this week, "20 Nov 14:30" otherwise. */
export function whenShort(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const day = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`
  if (day(d) === day(new Date(now))) return time
  if (Math.abs(ms - now) < 6 * 24 * HOUR) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${time}`
}

// ---- medicine plans --------------------------------------------------------------------------

export interface Plan {
  id: string
  fields: Record<string, string>
}

export interface Dose {
  id?: string
  planId: string
  at: number
  /** Marked as not given (with a reason), so the slot is not counted as missed. */
  skipped?: boolean
}

const num = (v: string | undefined) => {
  const n = Number(v)
  return v && Number.isFinite(n) && n > 0 ? n : null
}

/** Set times of day, sorted: "08:00, 14:00,20:00" → ["08:00", "14:00", "20:00"]. */
export function planTimes(fields: Record<string, string>): string[] {
  return [...new Set((fields.times ?? '').split(/[,\s]+/).filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)))].sort()
}

export function planStart(fields: Record<string, string>): number {
  return parseStamp(fields.start)
}

/** When the plan stops: stopped early, or the end of its last day. Infinity if it runs on. */
export function planEnd(fields: Record<string, string>): number {
  const stopped = parseStamp(fields.stoppedAt)
  const until = fields.until ? parseStamp(fields.until) + 24 * HOUR - 1 : Infinity
  return Math.min(Number.isNaN(stopped) ? Infinity : stopped, Number.isNaN(until) ? Infinity : until)
}

/** How the plan reads: "5 ml every 6 hours", "1 tablet at 08:00 and 20:00", "2 puffs when needed". */
export function planSummary(fields: Record<string, string>): string {
  const amount = fields.amount ? `${fields.amount} ` : ''
  const limits = [num(fields.minGapHours) ? `at least ${fields.minGapHours} h apart` : '', num(fields.maxPer24) ? `at most ${fields.maxPer24} in 24 hours` : ''].filter(Boolean).join(', ')
  let how = ''
  if (fields.mode === 'interval') how = `every ${fields.everyHours} hours`
  else if (fields.mode === 'times') {
    const t = planTimes(fields)
    how = t.length ? `at ${t.length > 1 ? `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}` : t[0]}` : 'at set times'
  } else how = 'when needed'
  return `${amount}${how}${limits ? ` (${limits})` : ''}`
}

/** The smallest gap between two doses the prescription allows, if the parents entered one. */
export function minimumGap(fields: Record<string, string>): number | null {
  const gap = num(fields.minGapHours) ?? (fields.mode === 'interval' ? num(fields.everyHours) : null)
  return gap === null ? null : gap * HOUR
}

export interface Slot {
  at: number
  state: 'given' | 'skipped' | 'missed' | 'due' | 'late' | 'coming'
  dose?: Dose
}

/** Set-time plans: every slot from `from` to `to`, matched with the doses given. */
export function timeSlots(fields: Record<string, string>, doses: Dose[], from: number, to: number, now: number): Slot[] {
  const times = planTimes(fields)
  const start = planStart(fields)
  const end = planEnd(fields)
  if (times.length === 0 || Number.isNaN(start)) return []
  // A dose belongs to the nearest slot within half the shortest gap between slots (at most 3 hours).
  const minutes = times.map((t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)))
  const gaps = minutes.map((m, i) => (i === 0 ? m + 1440 - minutes[minutes.length - 1]! : m - minutes[i - 1]!))
  const window = Math.min(3 * HOUR, (Math.min(...gaps) * MINUTE) / 2)
  const slots: Slot[] = []
  const first = new Date(Math.max(from, start))
  first.setHours(0, 0, 0, 0)
  for (let day = first.getTime(); day <= Math.min(to, end); ) {
    const d = new Date(day)
    for (const t of times) {
      const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), Number(t.slice(0, 2)), Number(t.slice(3))).getTime()
      if (at >= start && at <= end && at >= from && at <= to) slots.push({ at, state: 'coming' })
    }
    d.setDate(d.getDate() + 1)
    day = d.getTime()
  }
  const unused = [...doses].sort((a, b) => a.at - b.at)
  for (const slot of slots) {
    const i = unused.findIndex((x) => Math.abs(x.at - slot.at) <= window)
    if (i >= 0) {
      slot.dose = unused[i]
      slot.state = unused[i]!.skipped ? 'skipped' : 'given'
      unused.splice(i, 1)
    } else if (now > slot.at + window) slot.state = 'missed'
    else if (now > slot.at + LATE_AFTER) slot.state = 'late'
    else if (now >= slot.at) slot.state = 'due'
  }
  return slots
}

export interface PlanStatus {
  /** Not started yet, running, or finished (end date passed or stopped). */
  phase: 'before' | 'running' | 'ended'
  /** When the next dose is due (set times, every N hours), or may be given from (when needed). */
  next: number | null
  late: boolean
  /** Doses that should have been given and were not (nor marked as not given). */
  missed: number
  last: Dose | null
  /** Doses given in the last 24 hours. */
  inLast24: number
}

/** Where a plan stands: next dose, late, missed. */
export function planStatus(plan: Plan, allDoses: Dose[], now: number): PlanStatus {
  const f = plan.fields
  const doses = allDoses.filter((d) => d.planId === plan.id).sort((a, b) => a.at - b.at)
  const given = doses.filter((d) => !d.skipped)
  const start = planStart(f)
  const end = planEnd(f)
  const last = given[given.length - 1] ?? null
  const handled = doses[doses.length - 1] ?? null
  const inLast24 = given.filter((d) => d.at > now - 24 * HOUR && d.at <= now).length
  const phase = !Number.isNaN(start) && now < start ? 'before' : now > end ? 'ended' : 'running'
  const base = { phase, last, inLast24 } as const

  if (f.mode === 'times') {
    const slots = timeSlots(f, doses, Number.isNaN(start) ? now : start, Math.min(end, now + 8 * 24 * HOUR), now)
    const open = slots.find((s) => s.state === 'due' || s.state === 'late' || s.state === 'coming')
    return { ...base, next: open?.at ?? null, late: open?.state === 'late', missed: slots.filter((s) => s.state === 'missed').length }
  }
  if (f.mode === 'interval') {
    const every = (num(f.everyHours) ?? 0) * HOUR
    if (!every) return { ...base, next: null, late: false, missed: 0 }
    // Gaps of about two intervals or more mean a dose was missed (half an interval's grace).
    const missedIn = (gap: number) => Math.max(0, Math.floor((gap + every / 2) / every) - 1)
    const times = doses.map((d) => d.at)
    let missed = 0
    if (!Number.isNaN(start) && times.length) missed += missedIn(times[0]! - start + every)
    for (let i = 1; i < times.length; i++) missed += missedIn(times[i]! - times[i - 1]!)
    const next = handled ? handled.at + every : Number.isNaN(start) ? null : start
    // Doses whose time passed more than half an interval ago without one are missed; the next is then the one after.
    const passed = next !== null && next <= end ? missedIn(Math.min(now, end) - next + every) : 0
    missed += passed
    const due = next !== null && next + passed * every <= end ? next + passed * every : null
    return { ...base, next: due, late: due !== null && now > due + LATE_AFTER, missed }
  }
  // When needed: no schedule; the earliest the next dose may be given.
  const gap = minimumGap(f)
  return { ...base, next: last && gap ? last.at + gap : null, late: false, missed: 0 }
}

/** Why a dose at `at` goes against the prescription the parents entered. Empty if it does not. */
export function doseWarnings(plan: Plan, allDoses: Dose[], at: number, ignoreId?: string): string[] {
  const f = plan.fields
  const given = allDoses.filter((d) => d.planId === plan.id && !d.skipped && (ignoreId === undefined || d.id !== ignoreId))
  const out: string[] = []
  const start = planStart(f)
  if (!Number.isNaN(start) && at < start) out.push('This is before the plan starts.')
  if (at > planEnd(f)) out.push(f.stoppedAt ? 'This plan has been stopped.' : 'This plan has ended.')
  const gap = minimumGap(f)
  const before = given.filter((d) => d.at <= at).sort((a, b) => b.at - a.at)[0]
  const after = given.filter((d) => d.at > at).sort((a, b) => a.at - b.at)[0]
  if (gap) {
    const hours = Math.round((gap / HOUR) * 10) / 10
    if (before && at - before.at < gap) out.push(`Too soon: the prescription says at least ${hours} hours apart, and the last dose was ${span(at - before.at)} before.`)
    if (after && after.at - at < gap) out.push(`Too close to the dose logged ${span(after.at - at)} after it (at least ${hours} hours apart).`)
  }
  const max = num(f.maxPer24)
  if (max) {
    // The busiest 24 hours that would include this dose.
    const all = [...given.map((d) => d.at), at]
    let busiest = 0
    for (const t of all) {
      if (t < at || t - at >= 24 * HOUR) continue
      busiest = Math.max(busiest, all.filter((x) => x > t - 24 * HOUR && x <= t).length)
    }
    if (busiest > max) out.push(`More than the prescription allows: at most ${max} in 24 hours, and this would make ${busiest}.`)
  }
  return out
}

/** Dose reminders a running plan calls for, from now on (set times: the next week; every N hours: the next dose). */
export function doseReminders(plan: Plan, allDoses: Dose[], now: number): number[] {
  const f = plan.fields
  const doses = allDoses.filter((d) => d.planId === plan.id)
  const end = planEnd(f)
  // A dose up to 2 hours late is still reminded (the server drops anything later).
  const from = now - 2 * HOUR
  if (f.mode === 'times') {
    return timeSlots(f, doses, from, Math.min(end, now + 7 * 24 * HOUR), now)
      .filter((s) => s.state === 'coming' || s.state === 'due' || s.state === 'late')
      .map((s) => s.at)
  }
  if (f.mode === 'interval') {
    const s = planStatus(plan, doses, now)
    return s.next !== null && s.next >= from && s.next <= end ? [s.next] : []
  }
  return []
}

// ---- reading entries ------------------------------------------------------------------------

/** The temperatures in an episode's observations and vitals, oldest first. */
export function temperatures(entries: { fields: Record<string, string> }[]): { at: string; value: number }[] {
  return entries
    .filter((e) => (e.fields.type === 'observation' || e.fields.type === 'vitals') && e.fields.temperature)
    .map((e) => ({ at: e.fields.at ?? '', value: Number(String(e.fields.temperature).replace(',', '.')) }))
    .filter((p) => p.at && Number.isFinite(p.value) && p.value > 25 && p.value < 45)
    .sort((a, b) => a.at.localeCompare(b.at))
}

/** One line for a timeline entry. */
export function entrySummary(f: Record<string, string>): string {
  const bits = (list: (string | false | undefined)[]) => list.filter(Boolean).join(' · ')
  switch (f.type) {
    case 'observation':
      return bits([
        f.temperature && `${f.temperature} °C`,
        f.symptoms,
        f.pain && `pain ${f.pain}/10`,
        f.eating && `eating: ${INTAKE.find(([v]) => v === f.eating)?.[1].toLowerCase()}`,
        f.drinking && `drinking: ${INTAKE.find(([v]) => v === f.drinking)?.[1].toLowerCase()}`,
        f.nappies && `${f.nappies} wet nappies`,
      ])
    case 'dose':
      return f.skipped === 'yes' ? `Not given: ${f.medicine}` : bits([`${f.medicine}${f.amount ? ` ${f.amount}` : ''}`])
    case 'doctor':
      return bits([f.who, f.diagnosis && `diagnosis: ${f.diagnosis}`])
    case 'test':
      return bits([f.what, f.result])
    case 'vitals':
      return bits([
        f.temperature && `${f.temperature} °C`,
        f.heartRate && `HR ${f.heartRate}`,
        f.breathing && `RR ${f.breathing}`,
        f.oxygen && `SpO₂ ${f.oxygen}%`,
        f.bp && `BP ${f.bp}`,
        f.weight && `${f.weight} kg`,
      ])
    case 'round':
      return bits([f.who, f.decisions])
    case 'feeling':
      return FEELINGS.find(([v]) => v === f.feeling)?.[1] ?? ''
    default:
      return ''
  }
}
