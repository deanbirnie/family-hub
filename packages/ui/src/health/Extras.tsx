/**
 * Health, part 5b: what is coming up, vaccinations (the SA schedule),
 * growth with charts, regular check-ups, and appointments (with the family
 * calendar and "How did it go?").
 */
import { BellRing, CalendarClock, Plus, Ruler, Stethoscope, Syringe } from 'lucide-react'
import { useState } from 'react'
import type { Contact } from '../pages/Contacts.tsx'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, useAction } from '../ui.tsx'
import { vault } from '../vault/store.ts'
import { encryptHealth, optionLabel, VACCINE_STATUSES, type HealthContent, type StoredHealthRecord } from './model.ts'
import { healthReminders } from './reminders.ts'
import { dueDate, SA_SCHEDULE, scheduleApplies } from './vaccines.ts'

type Rec = StoredHealthRecord & { content: HealthContent }

export interface Opener {
  /** Opens the add/edit dialog, optionally with fields filled in. */
  open: (kind: HealthContent['kind'], record?: Rec, initial?: Record<string, string>) => void
}

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const daysUntil = (date: string) => Math.round((new Date(`${date}T00:00:00`).getTime() - new Date(`${today()}T00:00:00`).getTime()) / 86_400_000)
const when = (date: string) => {
  const n = daysUntil(date)
  if (n === 0) return 'today'
  if (n === 1) return 'tomorrow'
  if (n < 0) return `${-n} days ago`
  if (n < 14) return `in ${n} days`
  if (n < 60) return `in ${Math.round(n / 7)} weeks`
  return `in ${Math.round(n / 30)} months`
}

export function ComingUpHealth({ records, birthDate }: { records: Rec[]; birthDate?: string }) {
  const list = healthReminders(records, birthDate).filter((r) => r.date.length === 10 && daysUntil(r.date) <= 60)
  if (list.length === 0) return null
  return (
    <Card
      title={
        <>
          <BellRing size={18} aria-hidden /> Coming up
        </>
      }
    >
      <ul className="item-list">
        {list.map((r) => (
          <li key={r.source}>
            <div className="item-main">
              <div>{r.title}</div>
              <div className="muted small">
                {r.date}, {when(r.date)}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="muted small">Notifications only say “A health reminder is due”; the details are here.</p>
    </Card>
  )
}

const STATUS_TONE: Record<string, 'success' | 'warning' | 'neutral' | 'accent'> = { given: 'success', missed: 'warning', held: 'neutral', na: 'neutral', planned: 'accent' }

export function Vaccinations({ records, birthDate, opener }: { records: Rec[]; birthDate?: string; opener: Opener }) {
  const vaccines = records.filter((r) => r.content.kind === 'vaccine')
  const applies = scheduleApplies(birthDate, today())
  const extras = vaccines.filter((v) => !v.content.fields.doseId).sort((a, b) => (b.content.fields.date ?? '').localeCompare(a.content.fields.date ?? ''))
  return (
    <Card
      title={
        <>
          <Syringe size={18} aria-hidden /> Vaccinations
        </>
      }
      actions={<Button variant="ghost" icon={<Plus size={16} aria-hidden />} aria-label="Add a vaccination" onClick={() => opener.open('vaccine', undefined, { status: 'given', date: today() })} />}
    >
      {applies && birthDate && (
        <>
          <p className="muted small">The public schedule from the Road-to-Health booklet. It changes from time to time: check it against the child’s own booklet. Tap a dose to record it.</p>
          <ul className="item-list vaccine-list">
            {SA_SCHEDULE.map((dose) => {
              const rec = vaccines.find((v) => v.content.fields.doseId === dose.id)
              const f = rec?.content.fields ?? {}
              const due = f.due || dueDate(birthDate, dose.age)
              const status = f.status ?? (due < today() ? 'overdue' : 'due')
              return (
                <li key={dose.id}>
                  <button
                    className="vaccine-row"
                    onClick={() => opener.open('vaccine', rec, rec ? undefined : { doseId: dose.id, name: dose.name, status: 'given', date: due <= today() ? today() : due })}
                    aria-label={`Record ${dose.name}`}
                  >
                    <span className="vaccine-when muted small">{dose.label}</span>
                    <span>{dose.name}</span>
                    <span>
                      {status === 'due' && <Badge>Due {when(due)}</Badge>}
                      {status === 'overdue' && <Badge tone="warning">Overdue ({due})</Badge>}
                      {status !== 'due' && status !== 'overdue' && (
                        <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
                          {optionLabel(VACCINE_STATUSES, status).replace(/ \(.*\)$/, '')}
                          {status === 'given' && f.date ? ` ${f.date}` : ''}
                          {(status === 'planned' || status === 'missed') && f.due ? ` · ${f.due}` : ''}
                        </Badge>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </>
      )}
      {!birthDate && <p className="muted small">Add the date of birth (Quick Info, or Blood type and care notes here) to see the childhood schedule.</p>}
      {birthDate && !applies && extras.length === 0 && <p className="muted small">The childhood schedule is done by 13. Add flu, travel or other vaccinations with +.</p>}
      {extras.length > 0 && (
        <>
          <div className="muted small">Other vaccinations</div>
          <ul className="item-list">
            {extras.map((v) => (
              <li key={v.id}>
                <button className="vaccine-row" onClick={() => opener.open('vaccine', v)} aria-label={`Edit ${v.content.fields.name}`}>
                  <span className="vaccine-when muted small">{v.content.fields.date || v.content.fields.due || ''}</span>
                  <span>{v.content.fields.name}</span>
                  <Badge tone={STATUS_TONE[v.content.fields.status ?? ''] ?? 'neutral'}>{optionLabel(VACCINE_STATUSES, v.content.fields.status ?? 'given').replace(/ \(.*\)$/, '')}</Badge>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}

/** A small line chart of one measure over time (one series: no legend; the title names it). */
/** A single-series line over time. Points are dates, or dates and times ("2026-11-20T14:30"). */
export function TrendChart({ title, unit, points, label = (d) => d.slice(0, 7) }: { title: string; unit: string; points: { date: string; value: number }[]; label?: (date: string) => string }) {
  const [hover, setHover] = useState<number | null>(null)
  if (points.length === 0) return null
  const W = 320
  const H = 140
  const pad = { l: 36, r: 12, t: 12, b: 22 }
  const times = points.map((p) => new Date(p.date.length > 10 ? p.date : `${p.date}T00:00:00`).getTime())
  const t0 = Math.min(...times)
  const t1 = Math.max(...times)
  const values = points.map((p) => p.value)
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const span = hi - lo || Math.max(1, hi * 0.1)
  // A little room above and below; a single value sits in the middle.
  const bottom = hi === lo ? lo - span / 2 : lo - span * 0.1
  const range = hi === lo ? span : span * 1.2
  const x = (t: number) => pad.l + (t1 === t0 ? (W - pad.l - pad.r) / 2 : ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r))
  const y = (v: number) => pad.t + (1 - (v - bottom) / range) * (H - pad.t - pad.b)
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(times[i]!).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')
  const ticks = [lo, (lo + hi) / 2, hi].filter((v, i, a) => a.indexOf(v) === i)
  const h = hover === null ? null : points[hover]!
  return (
    <figure className="trend">
      <figcaption className="small">
        <strong>{title}</strong> <span className="muted">({unit})</span>
        {h && (
          <span className="trend-readout">
            {' '}
            · {h.date.replace('T', ' ')}: <strong>{h.value}</strong> {unit}
          </span>
        )}
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title} over time`} onMouseLeave={() => setHover(null)}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} className="trend-grid" />
            <text x={pad.l - 6} y={y(v) + 4} textAnchor="end" className="trend-tick">
              {Math.round(v * 10) / 10}
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 6} className="trend-tick">
          {label(points[0]!.date)}
        </text>
        {points.length > 1 && (
          <text x={W - pad.r} y={H - 6} textAnchor="end" className="trend-tick">
            {label(points[points.length - 1]!.date)}
          </text>
        )}
        {points.length > 1 && <path d={path} className="trend-line" />}
        {points.map((p, i) => (
          <g key={p.date + i} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={0} aria-label={`${p.date.replace('T', ' ')}: ${p.value} ${unit}`}>
            <circle cx={x(times[i]!)} cy={y(p.value)} r={12} className="trend-hit" />
            <circle cx={x(times[i]!)} cy={y(p.value)} r={hover === i ? 5 : 4} className="trend-dot" />
          </g>
        ))}
      </svg>
    </figure>
  )
}

export function Growth({ records, opener }: { records: Rec[]; opener: Opener }) {
  const rows = records.filter((r) => r.content.kind === 'growth').sort((a, b) => (a.content.fields.date ?? '').localeCompare(b.content.fields.date ?? ''))
  const series = (key: string) =>
    rows.filter((r) => r.content.fields[key] && !Number.isNaN(Number(r.content.fields[key]))).map((r) => ({ date: r.content.fields.date!, value: Number(r.content.fields[key]) }))
  const [table, setTable] = useState(false)
  return (
    <Card
      title={
        <>
          <Ruler size={18} aria-hidden /> Growth
        </>
      }
      actions={<Button variant="ghost" icon={<Plus size={16} aria-hidden />} aria-label="Add a measurement" onClick={() => opener.open('growth', undefined, { date: today() })} />}
    >
      {rows.length === 0 ? (
        <p className="muted small">Height and weight over time, with a chart. Set a measuring reminder under Blood type and care notes.</p>
      ) : (
        <>
          <div className="trend-grid-wrap">
            <TrendChart title="Height" unit="cm" points={series('height')} />
            <TrendChart title="Weight" unit="kg" points={series('weight')} />
            <TrendChart title="Head" unit="cm" points={series('head')} />
          </div>
          <button className="link small" onClick={() => setTable(!table)}>
            {table ? 'Hide the measurements' : `Show the measurements (${rows.length})`}
          </button>
          {table && (
            <table className="trend-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Height (cm)</th>
                  <th>Weight (kg)</th>
                  <th>Head (cm)</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {[...rows].reverse().map((r) => (
                  <tr key={r.id}>
                    <td>{r.content.fields.date}</td>
                    <td>{r.content.fields.height ?? ''}</td>
                    <td>{r.content.fields.weight ?? ''}</td>
                    <td>{r.content.fields.head ?? ''}</td>
                    <td>
                      <button className="link small" onClick={() => opener.open('growth', r)} aria-label={`Edit the measurement of ${r.content.fields.date}`}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Card>
  )
}

export function Checkups({ records, contacts, opener }: { records: Rec[]; contacts: Contact[]; opener: Opener }) {
  const list = records.filter((r) => r.content.kind === 'checkup')
  return (
    <Card
      title={
        <>
          <Stethoscope size={18} aria-hidden /> Regular check-ups
        </>
      }
      actions={<Button variant="ghost" icon={<Plus size={16} aria-hidden />} aria-label="Add a regular check-up" onClick={() => opener.open('checkup', undefined, { everyMonths: '6' })} />}
    >
      {list.length === 0 && <p className="muted small">e.g. the dentist every 6 months, an eye test every year: reminded when the next one is due.</p>}
      <ul className="item-list">
        {list.map((r) => {
          const f = r.content.fields
          const next = f.last && f.everyMonths ? healthReminders([r], undefined, '0000-01-01')[0]?.date : undefined
          return (
            <li key={r.id}>
              <div className="item-main">
                <div>
                  <strong>{f.what}</strong>
                  {f.providerId && <span className="muted small"> · {contacts.find((c) => c.id === f.providerId)?.name ?? ''}</span>}
                </div>
                <div className="muted small">{f.last ? `Last ${f.last}` : 'Not done yet'}{next ? ` · next ${next} (${when(next)})` : ''}</div>
              </div>
              <Button variant="ghost" onClick={() => opener.open('checkup', r, { ...f, last: today() })}>
                Done today
              </Button>
              <Button variant="ghost" onClick={() => opener.open('checkup', r)} aria-label={`Edit ${f.what}`}>
                Edit
              </Button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

export function Appointments({ ctx, person, records, contacts, opener, onChanged }: { ctx: HubContext; person: { id: string; displayName: string }; records: Rec[]; contacts: Contact[]; opener: Opener; onChanged: () => void }) {
  const list = records.filter((r) => r.content.kind === 'appointment').sort((a, b) => (a.content.fields.date ?? '').localeCompare(b.content.fields.date ?? ''))
  const upcoming = list.filter((r) => (r.content.fields.date ?? '') >= today() && r.content.fields.done !== 'yes')
  const toReview = list.filter((r) => (r.content.fields.date ?? '') < today() && r.content.fields.done !== 'yes')
  const [reviewing, setReviewing] = useState<Rec | null>(null)
  const who = (id?: string) => (id ? (contacts.find((c) => c.id === id)?.name ?? '') : '')
  return (
    <Card
      title={
        <>
          <CalendarClock size={18} aria-hidden /> Appointments
        </>
      }
      actions={<Button variant="ghost" icon={<Plus size={16} aria-hidden />} aria-label="Add an appointment" onClick={() => opener.open('appointment', undefined, { date: today(), time: '09:00', calendar: 'generic' })} />}
    >
      {upcoming.length === 0 && toReview.length === 0 && <p className="muted small">No appointments coming up.</p>}
      <ul className="item-list">
        {toReview.map((r) => (
          <li key={r.id}>
            <div className="item-main">
              <div>
                <strong>{r.content.fields.reason || 'Appointment'}</strong> <span className="muted small">{who(r.content.fields.providerId)}</span>
              </div>
              <div className="muted small">
                {r.content.fields.date} {r.content.fields.time}
              </div>
            </div>
            <Button onClick={() => setReviewing(r)}>How did it go?</Button>
          </li>
        ))}
        {upcoming.map((r) => (
          <li key={r.id}>
            <div className="item-main">
              <div>
                <strong>{r.content.fields.reason || 'Appointment'}</strong> <span className="muted small">{who(r.content.fields.providerId)}</span>
              </div>
              <div className="muted small">
                {r.content.fields.date} {r.content.fields.time} · {when(r.content.fields.date!)}
                {r.content.fields.calendar === 'none' ? ' · not on the calendar' : ' · on the calendar'}
              </div>
            </div>
            <Button variant="ghost" onClick={() => opener.open('appointment', r)} aria-label={`Edit the appointment on ${r.content.fields.date}`}>
              Edit
            </Button>
          </li>
        ))}
      </ul>
      {reviewing && (
        <HowDidItGo
          ctx={ctx}
          person={person}
          appointment={reviewing}
          onClose={(changed) => {
            setReviewing(null)
            if (changed) onChanged()
          }}
        />
      )}
    </Card>
  )
}

/** After an appointment: what happened becomes a history entry, and the appointment is done. */
function HowDidItGo({ ctx, person, appointment, onClose }: { ctx: HubContext; person: { id: string; displayName: string }; appointment: Rec; onClose: (changed: boolean) => void }) {
  const [notes, setNotes] = useState('')
  const f = appointment.content.fields
  const save = useAction(async (skip: boolean) => {
    const key = vault.use()
    if (!key) throw new Error('The family vault has locked. Open it again, then save.')
    const { api } = ctx.platform
    if (!skip) {
      const entry: HealthContent = {
        kind: 'history',
        fields: Object.fromEntries(Object.entries({ date: f.date ?? today(), type: 'visit', title: f.reason || 'Appointment', providerId: f.providerId ?? '', notes: notes.trim() }).filter(([, v]) => v)),
        documents: [],
        changes: [],
      }
      await api.post('/api/health/records', { profileId: person.id, ciphertext: await encryptHealth(key, person.id, entry) })
    }
    const done: HealthContent = { ...appointment.content, fields: { ...f, done: 'yes' } }
    await api.request('PUT', `/api/health/records/${appointment.id}`, { ciphertext: await encryptHealth(key, person.id, done), baseVersion: appointment.version })
    onClose(true)
  })
  return (
    <Dialog open title={`How did it go? · ${person.displayName}`} onClose={() => onClose(false)}>
      <div className="stack">
        <p>
          {f.reason || 'Appointment'} on {f.date}. What was found, said or prescribed goes into the history.
        </p>
        <textarea className="textarea" rows={4} aria-label="What happened" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Ear infection; antibiotics for 7 days; come back if not better by Friday" />
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <div className="row">
          <Button busy={save.busy} onClick={() => void save.run(false)}>
            Add to history
          </Button>
          <Button variant="ghost" busy={save.busy} onClick={() => void save.run(true)}>
            It didn’t happen
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * Keeps an appointment's family-calendar event in step: "Appointment – Sam"
 * (or with the doctor's name), tagged to the person, with reminders; or none.
 * Returns the event ID to keep on the appointment.
 */
export async function syncAppointmentEvent(ctx: HubContext, person: { id: string; displayName: string }, fields: Record<string, string>, contacts: Contact[]): Promise<string> {
  const { api } = ctx.platform
  const existing = fields.eventId || ''
  if (fields.calendar === 'none' || fields.done === 'yes' || !fields.date) {
    if (existing) await api.del(`/api/calendar/events/${existing}`).catch(() => undefined)
    return ''
  }
  const doctor = contacts.find((c) => c.id === fields.providerId)?.name
  const title = fields.calendar === 'named' && doctor ? `${doctor} – ${person.displayName}` : `Appointment – ${person.displayName}`
  const time = /^\d{2}:\d{2}$/.test(fields.time ?? '') ? fields.time! : '09:00'
  const [h, m] = time.split(':').map(Number) as [number, number]
  const endMinutes = Math.min(h * 60 + m + 30, 23 * 60 + 59)
  const end = `${String(Math.floor(endMinutes / 60)).padStart(2, '0')}:${String(endMinutes % 60).padStart(2, '0')}`
  const body = { title, start: `${fields.date}T${time}`, end: `${fields.date}T${end}`, tags: [person.id], reminders: [1440, 60] }
  if (existing) {
    try {
      const current = await api.get<{ event: { version: number } }>(`/api/calendar/events/${existing}`)
      await api.request('PUT', `/api/calendar/events/${existing}`, { ...body, baseVersion: current.event.version, scope: 'all' })
      return existing
    } catch {
      // Deleted from the calendar since: add it again.
    }
  }
  return (await api.post<{ id: string }>('/api/calendar/events', body)).id
}
