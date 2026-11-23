/**
 * Health reminders. The server cannot read Health, so a parent's device
 * works out which reminders each person needs and tells the server only
 * "a health reminder · person · date", how far ahead to remind, and an
 * opaque key (docs/DATA-PROTECTION.md, "Health"). The details stay here.
 */
import type { Api } from '../api.ts'
import { isCurrentMedicine, type HealthContent } from './model.ts'
import { doseReminders, localStamp, parseStamp, type Dose } from './episodes.ts'
import { dueDate, SA_SCHEDULE, scheduleApplies } from './vaccines.ts'

export interface HealthReminder {
  /** What it is, shown only in the app. */
  title: string
  /** A date, or a date and time for a dose ("2026-11-20T14:30"). */
  date: string
  leads: number[]
  /** Stable source for the opaque key: record ID and purpose. */
  source: string
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const addMonths = (date: string, months: number) => {
  const d = new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
  d.setMonth(d.getMonth() + months)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

/** Every reminder one person's records call for, still to come. */
export function healthReminders(records: { id: string; content: HealthContent }[], birthDate: string | undefined, on = today(), now = Date.now()): HealthReminder[] {
  const out: HealthReminder[] = []
  const push = (r: HealthReminder) => {
    if (ISO.test(r.date) && r.date >= on) out.push(r)
  }
  const of = (kind: HealthContent['kind']) => records.filter((r) => r.content.kind === kind)

  for (const r of of('medicine')) {
    const f = r.content.fields
    if (f.chronic !== 'yes' || !isCurrentMedicine(f, on)) continue
    if (f.nextRepeat) push({ title: `Repeat due: ${f.name}`, date: f.nextRepeat, leads: [3, 0], source: `${r.id}:repeat` })
    if (f.scriptExpiry) push({ title: `Script expires: ${f.name}`, date: f.scriptExpiry, leads: [14, 3], source: `${r.id}:expiry` })
  }

  // Vaccinations: scheduled doses not yet dealt with, and booked or catch-up dates.
  const vaccines = of('vaccine')
  if (birthDate && scheduleApplies(birthDate, on)) {
    for (const dose of SA_SCHEDULE) {
      const rec = vaccines.find((v) => v.content.fields.doseId === dose.id)
      const status = rec?.content.fields.status
      if (status === 'given' || status === 'na' || status === 'held') continue
      push({ title: `Vaccination due: ${dose.name}`, date: rec?.content.fields.due || dueDate(birthDate, dose.age), leads: [7, 0], source: `dose:${dose.id}` })
    }
  }
  for (const v of vaccines) {
    const f = v.content.fields
    if (f.doseId || !f.due || (f.status !== 'planned' && f.status !== 'missed')) continue
    push({ title: `Vaccination: ${f.name}`, date: f.due, leads: [7, 0], source: `${v.id}:due` })
  }

  // Measuring height and weight, a set time after the last measurement.
  const basics = of('basics')[0]?.content.fields
  const every = Number(basics?.measureEvery || 0)
  const last = of('growth')
    .map((g) => g.content.fields.date ?? '')
    .sort()
    .pop()
  if (every > 0 && last) push({ title: 'Measure height and weight', date: addMonths(last, every), leads: [0], source: 'growth' })

  for (const c of of('checkup')) {
    const f = c.content.fields
    if (f.last && f.everyMonths) push({ title: `Check-up: ${f.what}`, date: addMonths(f.last, Number(f.everyMonths)), leads: [14, 0], source: `${c.id}:next` })
  }

  // Appointments not on the calendar get a health reminder instead.
  for (const a of of('appointment')) {
    const f = a.content.fields
    if (f.calendar === 'none' && f.done !== 'yes') push({ title: `Appointment: ${f.reason || 'doctor'}`, date: f.date ?? '', leads: [1, 0], source: `${a.id}:appointment` })
  }
  // Doses in open episodes' medicine plans, to the minute.
  const open = new Set(of('episode').filter((e) => e.content.fields.status !== 'closed').map((e) => e.id))
  const doses: Dose[] = of('entry')
    .filter((e) => e.content.fields.type === 'dose' && e.content.fields.planId)
    .map((e) => ({ planId: e.content.fields.planId!, at: parseStamp(e.content.fields.at), skipped: e.content.fields.skipped === 'yes' }))
    .filter((d) => !Number.isNaN(d.at))
  for (const p of of('plan')) {
    if (!open.has(p.content.fields.episodeId ?? '')) continue
    for (const at of doseReminders({ id: p.id, fields: p.content.fields }, doses, now).slice(0, 60)) {
      const stamp = localStamp(at)
      out.push({ title: `Dose due: ${p.content.fields.medicine}`, date: stamp, leads: [0], source: `${p.id}:dose:${stamp}` })
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/** An opaque, stable key for a reminder: says nothing about what it is. */
async function keyOf(profileId: string, source: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${profileId}\n${source}`)))
  let bin = ''
  for (const b of digest.subarray(0, 16)) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Brings the server's health reminders in line with each person's records. */
export async function syncHealthReminders(api: Api, people: { id: string; records: { id: string; content: HealthContent }[]; birthDate?: string }[]): Promise<void> {
  const { items } = await api.get<{ items: { profileId: string; key: string; date: string; leads: number[] }[] }>('/api/reminders/health')
  for (const p of people) {
    const want = await Promise.all(healthReminders(p.records, p.birthDate).slice(0, 400).map(async (r) => ({ key: await keyOf(p.id, r.source), date: r.date, leads: r.leads })))
    const have = items.filter((i) => i.profileId === p.id).map(({ key, date, leads }) => ({ key, date, leads }))
    const norm = (list: { key: string; date: string; leads: number[] }[]) => JSON.stringify([...list].sort((a, b) => a.key.localeCompare(b.key)))
    if (norm(want) !== norm(have)) await api.request('PUT', `/api/reminders/health/${p.id}`, { items: want })
  }
}
