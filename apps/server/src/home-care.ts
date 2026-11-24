/**
 * Home and car (phase 6b): vehicles, things with warranties, recurring
 * maintenance, and the jobs done on them (with who did them and whether the
 * family would use them again).
 *
 * Sealed with the server key, like the rest of Household admin. A vehicle is
 * linked to its Quick Info record by ID only: the registration, VIN and
 * licence disc stay end-to-end encrypted in Quick Info; here it has just a
 * nickname the parents choose.
 *
 * What is due (the next service, maintenance, warranties ending) is worked
 * out from the jobs: logging a job is what moves things on.
 */
import type { Services } from './app.ts'
import { addDays, addMonths, bad, cents, date, id, int, list, obj, oneOf, text } from './household.ts'
import type { ReminderItem } from './notifications.ts'
import { daysBetween, localNow } from './schedule.ts'

export type CareKind = 'vehicle' | 'item' | 'task' | 'job'

export interface Vehicle {
  /** A nickname ("The Polo", "Mom's car"); the details stay in Quick Info. */
  label: string
  quickInfoId: string | null
  /** Service interval, by time and by distance (either or both). */
  serviceMonths: number | null
  serviceKm: number | null
  /** Odometer readings, oldest first, to estimate when the next service falls due. */
  readings: { date: string; km: number }[]
  roadworthyDue: string | null
  warrantyEnd: string | null
  servicePlanEnd: string | null
  tyres: string
  battery: string
  notes: string
}

export interface Thing {
  name: string
  make: string
  model: string
  serial: string
  where: string
  boughtOn: string | null
  boughtFrom: string
  price: number | null
  warrantyEnd: string | null
  documents: { id: string; name: string }[]
  notes: string
}

export interface Task {
  name: string
  everyMonths: number
  /** Done before the hub knew; later jobs move it on. */
  lastDone: string | null
  /** What it is for (a vehicle or a thing), if anything. */
  forId: string | null
  /** The usual tradesperson, from Contacts. */
  contactId: string | null
  notes: string
}

export interface Job {
  date: string
  what: string
  /** A vehicle service (moves the next service on). */
  service: boolean
  /** The vehicle, thing or maintenance task it was for. */
  forId: string | null
  contactId: string | null
  /** Who did it, if not in Contacts. */
  who: string
  cost: number | null
  km: number | null
  /** Would the family use them again? */
  again: 'yes' | 'no' | ''
  againNote: string
  invoiceId: string | null
  documents: { id: string; name: string }[]
  notes: string
}

export type Care = Vehicle | Thing | Task | Job

const docs = (v: unknown) =>
  list(v, 20, 'Documents').map((d) => {
    const e = obj(d)
    return { id: (id(e, 'id') ?? bad('A document is not valid.'))!, name: text(e, 'name', 240, 'A document name', true) }
  })
const optInt = (v: unknown, label: string, min: number, max: number) => (v === undefined || v === null || v === '' ? null : int(v, label, min, max))
const optCents = (v: unknown, label: string) => (v === undefined || v === null || v === '' ? null : cents(v, label))

export function cleanCare(kind: CareKind, raw: unknown): Care {
  const o = obj(raw)
  if (kind === 'vehicle') {
    return {
      label: text(o, 'label', 60, 'The name', true),
      quickInfoId: id(o, 'quickInfoId'),
      serviceMonths: optInt(o.serviceMonths, 'Months between services', 1, 60),
      serviceKm: optInt(o.serviceKm, 'Kilometres between services', 500, 200_000),
      readings: list(o.readings, 500, 'Odometer readings')
        .map((r) => {
          const e = obj(r)
          return { date: date(e, 'date', 'A reading date', true)!, km: int(e.km, 'A reading', 0, 5_000_000) }
        })
        .sort((a, b) => a.date.localeCompare(b.date)),
      roadworthyDue: date(o, 'roadworthyDue', 'The roadworthy date'),
      warrantyEnd: date(o, 'warrantyEnd', 'The warranty end'),
      servicePlanEnd: date(o, 'servicePlanEnd', 'The service plan end'),
      tyres: text(o, 'tyres', 300, 'Tyres'),
      battery: text(o, 'battery', 300, 'Battery'),
      notes: text(o, 'notes', 2000, 'Notes'),
    }
  }
  if (kind === 'item') {
    return {
      name: text(o, 'name', 120, 'What it is', true),
      make: text(o, 'make', 60, 'The make'),
      model: text(o, 'model', 60, 'The model'),
      serial: text(o, 'serial', 60, 'The serial number'),
      where: text(o, 'where', 60, 'Where it is'),
      boughtOn: date(o, 'boughtOn', 'The day bought'),
      boughtFrom: text(o, 'boughtFrom', 120, 'Where it was bought'),
      price: optCents(o.price, 'The price'),
      warrantyEnd: date(o, 'warrantyEnd', 'The warranty end'),
      documents: docs(o.documents),
      notes: text(o, 'notes', 2000, 'Notes'),
    }
  }
  if (kind === 'task') {
    return {
      name: text(o, 'name', 120, 'The job', true),
      everyMonths: int(o.everyMonths, 'How often', 1, 120),
      lastDone: date(o, 'lastDone', 'When it was last done'),
      forId: id(o, 'forId'),
      contactId: id(o, 'contactId'),
      notes: text(o, 'notes', 2000, 'Notes'),
    }
  }
  return {
    date: date(o, 'date', 'The date', true)!,
    what: text(o, 'what', 200, 'What was done', true),
    service: o.service === true,
    forId: id(o, 'forId'),
    contactId: id(o, 'contactId'),
    who: text(o, 'who', 120, 'Who did it'),
    cost: optCents(o.cost, 'The cost'),
    km: optInt(o.km, 'The odometer', 0, 5_000_000),
    again: o.again ? oneOf(o.again, ['yes', 'no'] as const, 'Would use again') : '',
    againNote: text(o, 'againNote', 300, 'Why'),
    invoiceId: id(o, 'invoiceId'),
    documents: docs(o.documents),
    notes: text(o, 'notes', 2000, 'Notes'),
  }
}

// ---- reading -----------------------------------------------------------------------------------

interface Row {
  id: string
  kind: CareKind
  sealed: string
  version: number
}

export const sealCare = (s: Services, kind: CareKind, id: string, item: Care) => s.serverKey.seal(JSON.stringify(item), 'home-care', `${kind}:${id}`)
export const openCare = <T extends Care>(s: Services, r: Pick<Row, 'id' | 'kind' | 'sealed'>) => JSON.parse(s.serverKey.open(r.sealed, 'home-care', `${r.kind}:${r.id}`)) as T

export function readCare<T extends Care>(s: Services, kind: CareKind): { id: string; version: number; item: T }[] {
  return (s.db.prepare('SELECT id, kind, sealed, version FROM home_care WHERE kind = ? ORDER BY created_at, id').all(kind) as unknown as Row[]).map((r) => ({
    id: r.id,
    version: r.version,
    item: openCare<T>(s, r),
  }))
}

// ---- what is due -------------------------------------------------------------------------------

/** Kilometres a day, from the first and last odometer readings (and jobs); null if it cannot be told. */
export function kmPerDay(readings: { date: string; km: number }[]): number | null {
  const sorted = [...readings].sort((a, b) => a.date.localeCompare(b.date))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first || !last) return null
  const days = daysBetween(first.date, last.date)
  if (days < 14 || last.km <= first.km) return null
  return (last.km - first.km) / days
}

export interface VehicleStatus {
  lastService: { date: string; km: number | null } | null
  /** The next service by time, by distance, and the distance as an estimated date. */
  nextByDate: string | null
  nextKm: number | null
  nextByKm: string | null
  /** Whichever comes first. */
  nextService: string | null
  /** Today's estimated odometer. */
  kmNow: number | null
}

export function vehicleStatus(v: Vehicle, jobs: Job[], today: string): VehicleStatus {
  const services = jobs.filter((j) => j.service).sort((a, b) => a.date.localeCompare(b.date))
  const last = services[services.length - 1]
  const readings = [...v.readings, ...jobs.filter((j) => j.km !== null).map((j) => ({ date: j.date, km: j.km! }))]
  const rate = kmPerDay(readings)
  const latest = [...readings].sort((a, b) => a.date.localeCompare(b.date)).pop()
  const kmNow = latest ? Math.round(latest.km + (rate ?? 0) * Math.max(0, daysBetween(latest.date, today))) : null
  const nextByDate = last && v.serviceMonths ? addMonths(last.date, v.serviceMonths) : null
  const nextKm = last?.km !== null && last?.km !== undefined && v.serviceKm ? last.km + v.serviceKm : null
  let nextByKm: string | null = null
  if (nextKm !== null && latest && rate) nextByKm = addDays(latest.date, Math.max(0, Math.ceil((nextKm - latest.km) / rate)))
  const nextService = [nextByDate, nextByKm].filter((d): d is string => !!d).sort()[0] ?? null
  return { lastService: last ? { date: last.date, km: last.km } : null, nextByDate, nextKm, nextByKm, nextService, kmNow }
}

/** When a recurring job is next due: from the latest of "last done" and the jobs logged for it. */
export function taskStatus(t: Task, jobs: Job[]): { lastDone: string | null; nextDue: string | null } {
  const lastDone = [t.lastDone, ...jobs.map((j) => j.date)].filter((d): d is string => !!d).sort().pop() ?? null
  return { lastDone, nextDue: lastDone ? addMonths(lastDone, t.everyMonths) : null }
}

/** Everything, with what is due worked out. */
export function careState(s: Services, today: string) {
  const vehicles = readCare<Vehicle>(s, 'vehicle')
  const items = readCare<Thing>(s, 'item')
  const tasks = readCare<Task>(s, 'task')
  const jobs = readCare<Job>(s, 'job')
  const jobsFor = (id: string) => jobs.filter((j) => j.item.forId === id).map((j) => j.item)
  return {
    vehicles: vehicles.map((v) => ({ ...v, status: vehicleStatus(v.item, jobsFor(v.id), today) })),
    items,
    tasks: tasks.map((t) => ({ ...t, status: taskStatus(t.item, jobsFor(t.id)) })),
    jobs,
  }
}

// ---- reminders ---------------------------------------------------------------------------------

/** Reminders for services, roadworthies, maintenance and warranties. Generic text; titles show in the app only. */
export function homeCareItems(s: Services): ReminderItem[] {
  if (!s.db.prepare("SELECT 1 FROM home_care WHERE kind != 'job' LIMIT 1").get()) return []
  const today = localNow(s.now(), s.config.timeZone).date
  const state = careState(s, today)
  const out: ReminderItem[] = []
  const item = (key: string, title: string, date: string, leads: number[], notice: string, horizon: number, detail: string | null, catchUp = false): ReminderItem => ({
    key,
    category: 'home',
    title,
    whose: null,
    due: { date, yearly: false },
    leads,
    notice: () => notice,
    url: '/home-care',
    audience: 'all',
    horizon,
    detail: () => detail,
    catchUp,
  })
  for (const v of state.vehicles) {
    const st = v.status
    if (st.nextService) {
      const byKm = st.nextService === st.nextByKm && st.nextKm !== null
      out.push(item(`hc:${v.id}:service`, `${v.item.label}: service due`, st.nextService, [14, 3], 'A vehicle service is due soon. Tap to see.', 30, byKm ? `at about ${st.nextKm!.toLocaleString('en-ZA')} km (estimated)` : null, true))
    }
    if (v.item.roadworthyDue && v.item.roadworthyDue >= today) out.push(item(`hc:${v.id}:rwc`, `${v.item.label}: roadworthy`, v.item.roadworthyDue, [30, 7], 'A roadworthy is due soon. Tap to see.', 60, null))
    for (const [field, label] of [
      ['warrantyEnd', 'warranty ends'],
      ['servicePlanEnd', 'service plan ends'],
    ] as const) {
      const end = v.item[field]
      if (end && end >= today) out.push(item(`hc:${v.id}:${field}`, `${v.item.label}: ${label}`, end, [60, 14], 'A warranty ends soon. Tap to see.', 90, null))
    }
  }
  for (const t of state.items) {
    const end = t.item.warrantyEnd
    if (end && end >= today) out.push(item(`hc:${t.id}:warranty`, `${t.item.name}: warranty ends`, end, [30, 7], 'A warranty ends soon. Tap to see.', 60, null))
  }
  for (const t of state.tasks) {
    if (t.status.nextDue) out.push(item(`hc:${t.id}:task`, t.item.name, t.status.nextDue, [7, 0], 'Home maintenance is due. Tap to see.', 30, null, true))
  }
  return out
}

