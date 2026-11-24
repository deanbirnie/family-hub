/**
 * Home and car (phase 6b), for parents: vehicles and their services, things
 * with warranties, recurring maintenance, and the jobs done (who did them,
 * what it cost, would we use them again). Sealed with the server key; the
 * vehicles' registration and VIN stay end-to-end encrypted in Quick Info.
 */
import { Car, Gauge, Hammer, Home, Pencil, Phone, Plus, ThumbsDown, ThumbsUp, Wrench } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { AttachDocuments, Documents, type DocumentFolder } from '../health/parts.tsx'
import { Actions, conflict, Labelled } from '../money/form.tsx'
import { amountText, daysFrom, parseRand, rand, relative, shortDate } from '../money/model.ts'
import type { Contact } from '../pages/Contacts.tsx'
import { decryptRecord, type StoredRecord } from '../quickinfo/model.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, PageHeader, Spinner, errorText, useAction } from '../ui.tsx'
import { vault } from '../vault/store.ts'
import { useVaultUnlocked } from '../vault/VaultCard.tsx'

const HOUSEHOLD: DocumentFolder = { path: '/api/money/folder', name: 'Household' }

interface Vehicle {
  id: string
  version: number
  label: string
  quickInfoId: string | null
  serviceMonths: number | null
  serviceKm: number | null
  readings: { date: string; km: number }[]
  roadworthyDue: string | null
  warrantyEnd: string | null
  servicePlanEnd: string | null
  tyres: string
  battery: string
  notes: string
  status: { lastService: { date: string; km: number | null } | null; nextByDate: string | null; nextKm: number | null; nextByKm: string | null; nextService: string | null; kmNow: number | null }
}
interface Thing {
  id: string
  version: number
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
interface Task {
  id: string
  version: number
  name: string
  everyMonths: number
  lastDone: string | null
  forId: string | null
  contactId: string | null
  notes: string
  status: { lastDone: string | null; nextDue: string | null }
}
interface Job {
  id: string
  version: number
  date: string
  what: string
  service: boolean
  forId: string | null
  contactId: string | null
  who: string
  cost: number | null
  km: number | null
  again: 'yes' | 'no' | ''
  againNote: string
  invoiceId: string | null
  documents: { id: string; name: string }[]
  notes: string
}
interface State {
  today: string
  vehicles: Vehicle[]
  items: Thing[]
  tasks: Task[]
  jobs: Job[]
}
interface Extras {
  contacts: Contact[]
  /** Quick Info vehicles, while the vault is open: description, registration, licence disc. */
  qiVehicles: { id: string; description: string; registration: string; licenceExpiry: string }[]
  invoices: { id: string; from: string; number: string; amount: number }[]
}

/** Common jobs that come back, to add with one tap. */
const SUGGESTED: [string, number][] = [
  ['Geyser service', 24],
  ['Clean the gutters', 12],
  ['Smoke detector batteries', 12],
  ['Alarm and remote batteries', 12],
  ['Aircon filters', 3],
  ['Pool service', 1],
  ['Gas bottle check', 12],
  ['Pest control', 6],
  ['Borehole and pump service', 12],
  ['Fire extinguisher service', 12],
]

type Tab = 'overview' | 'vehicles' | 'home' | 'maintenance' | 'jobs'
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['vehicles', 'Vehicles'],
  ['home', 'Warranties'],
  ['maintenance', 'Maintenance'],
  ['jobs', 'Jobs and tradespeople'],
]

type Editing =
  | { what: 'vehicle'; vehicle?: Vehicle }
  | { what: 'reading'; vehicle: Vehicle }
  | { what: 'thing'; thing?: Thing }
  | { what: 'task'; task?: Task; preset?: Partial<Task> }
  | { what: 'job'; job?: Job; preset?: Partial<Job> }

export function HomeCarePage({ ctx }: { ctx: HubContext }) {
  if (ctx.user.role !== 'admin') {
    return (
      <div className="page">
        <PageHeader title="Home & car" />
        <Card>
          <p>Home and car records are kept by the parents.</p>
        </Card>
      </div>
    )
  }
  return <HomeCareBody ctx={ctx} />
}

function HomeCareBody({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const unlocked = useVaultUnlocked()
  const [state, setState] = useState<State | null>(null)
  const [extras, setExtras] = useState<Extras>({ contacts: [], qiVehicles: [], invoices: [] })
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [editing, setEditing] = useState<Editing | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await api.get<State>('/api/home-care'))
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [api])

  useEffect(() => {
    void load()
    void (async () => {
      const [book, qi, money] = await Promise.all([
        api.get<{ contacts: Contact[] }>('/api/contacts'),
        api.get<{ records: StoredRecord[] }>('/api/quick-info'),
        api.get<{ invoices: Extras['invoices'] }>('/api/money'),
      ])
      const qiVehicles: Extras['qiVehicles'] = []
      const key = vault.use()
      if (key) {
        for (const r of qi.records.filter((x) => x.kind === 'vehicle')) {
          try {
            const f = (await decryptRecord(key, r)).fields
            qiVehicles.push({ id: r.id, description: f.description ?? '', registration: f.registration ?? '', licenceExpiry: f.licenceExpiry ?? '' })
          } catch {
            // not this family's key
          }
        }
      }
      setExtras({ contacts: book.contacts, qiVehicles, invoices: money.invoices })
    })().catch(() => undefined)
  }, [api, load, unlocked])

  const done = (changed?: boolean) => {
    setEditing(null)
    if (changed) void load()
  }

  return (
    <div className="page">
      <PageHeader title="Home & car" subtitle="Services, warranties, maintenance and the people who do the work. For parents only." />
      <div className="row chips" role="tablist" aria-label="Home and car">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`chip ${tab === t ? 'chip-on' : ''}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {!state ? (
        !error && <Spinner />
      ) : (
        <>
          {tab === 'overview' && <Overview state={state} edit={setEditing} />}
          {tab === 'vehicles' && <Vehicles ctx={ctx} state={state} extras={extras} edit={setEditing} />}
          {tab === 'home' && <Things ctx={ctx} state={state} edit={setEditing} />}
          {tab === 'maintenance' && <Tasks state={state} extras={extras} edit={setEditing} />}
          {tab === 'jobs' && <Jobs ctx={ctx} state={state} extras={extras} edit={setEditing} />}
        </>
      )}
      {state && editing?.what === 'vehicle' && <VehicleDialog ctx={ctx} state={state} extras={extras} vehicle={editing.vehicle} onClose={done} />}
      {state && editing?.what === 'reading' && <ReadingDialog ctx={ctx} state={state} vehicle={editing.vehicle} onClose={done} />}
      {state && editing?.what === 'thing' && <ThingDialog ctx={ctx} thing={editing.thing} onClose={done} />}
      {state && editing?.what === 'task' && <TaskDialog ctx={ctx} state={state} extras={extras} task={editing.task} preset={editing.preset} onClose={done} />}
      {state && editing?.what === 'job' && <JobDialog ctx={ctx} state={state} extras={extras} job={editing.job} preset={editing.preset} onClose={done} />}
    </div>
  )
}

/** What a job or task is for, by name. */
function forName(state: State, id: string | null): string {
  if (!id) return ''
  return state.vehicles.find((v) => v.id === id)?.label ?? state.items.find((i) => i.id === id)?.name ?? state.tasks.find((t) => t.id === id)?.name ?? ''
}

const whoName = (extras: Extras, j: { contactId: string | null; who?: string }) => (j.contactId ? (extras.contacts.find((c) => c.id === j.contactId)?.name ?? j.who ?? '') : (j.who ?? ''))

const dueBadge = (today: string, iso: string | null, soon = 30) => {
  if (!iso) return null
  const n = daysFrom(today, iso)
  if (n < 0) return <Badge tone="warning">Overdue</Badge>
  if (n <= soon) return <Badge tone="warning">Due {relative(today, iso)}</Badge>
  return null
}

// ---- overview ----------------------------------------------------------------------------------

function Overview({ state, edit }: { state: State; edit: (e: Editing) => void }) {
  const t = state.today
  const rows: { key: string; text: string; date: string; action?: { label: string; run: () => void } }[] = []
  for (const v of state.vehicles) {
    const st = v.status
    if (st.nextService && daysFrom(t, st.nextService) <= 60) {
      rows.push({
        key: `s-${v.id}`,
        text: `${v.label}: service${st.nextService === st.nextByKm && st.nextKm ? ` (at ${st.nextKm.toLocaleString('en-ZA')} km, estimated)` : ''}`,
        date: st.nextService,
        action: { label: 'Log the service', run: () => edit({ what: 'job', preset: { forId: v.id, service: true, what: 'Service' } }) },
      })
    }
    if (v.roadworthyDue && daysFrom(t, v.roadworthyDue) <= 60) rows.push({ key: `r-${v.id}`, text: `${v.label}: roadworthy`, date: v.roadworthyDue })
    if (v.warrantyEnd && v.warrantyEnd >= t && daysFrom(t, v.warrantyEnd) <= 90) rows.push({ key: `w-${v.id}`, text: `${v.label}: warranty ends`, date: v.warrantyEnd })
    if (v.servicePlanEnd && v.servicePlanEnd >= t && daysFrom(t, v.servicePlanEnd) <= 90) rows.push({ key: `p-${v.id}`, text: `${v.label}: service plan ends`, date: v.servicePlanEnd })
  }
  for (const task of state.tasks) {
    if (task.status.nextDue && daysFrom(t, task.status.nextDue) <= 30) {
      rows.push({ key: `t-${task.id}`, text: task.name, date: task.status.nextDue, action: { label: 'Mark done', run: () => edit({ what: 'job', preset: { forId: task.id, what: task.name, contactId: task.contactId } }) } })
    }
  }
  for (const i of state.items) if (i.warrantyEnd && i.warrantyEnd >= t && daysFrom(t, i.warrantyEnd) <= 60) rows.push({ key: `i-${i.id}`, text: `${i.name}: warranty ends`, date: i.warrantyEnd })
  rows.sort((a, b) => a.date.localeCompare(b.date))

  if (state.vehicles.length + state.items.length + state.tasks.length + state.jobs.length === 0) {
    return (
      <Card title="Getting started">
        <p>Add your vehicles (with the last service), the things whose warranties matter (fridge, TV, geyser, laptop), and the jobs that come back (geyser service, gutters, smoke detectors). Log each job as it is done, with who did it and whether you would use them again.</p>
        <div className="row">
          <Button icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'vehicle' })}>
            Add a vehicle
          </Button>
          <Button variant="secondary" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'thing' })}>
            Add something with a warranty
          </Button>
          <Button variant="secondary" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'task' })}>
            Add maintenance
          </Button>
        </div>
      </Card>
    )
  }
  return (
    <Card title="Coming up">
      {rows.length === 0 ? (
        <p className="muted small">Nothing due in the next month or two.</p>
      ) : (
        <ul className="item-list">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="item-main">
                <div>{r.text}</div>
                <div className={`small ${r.date < t ? 'field-error' : 'muted'}`}>
                  {shortDate(r.date, t)} ({relative(t, r.date)})
                </div>
              </div>
              {r.action && (
                <Button variant="secondary" onClick={r.action.run}>
                  {r.action.label}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

// ---- vehicles ----------------------------------------------------------------------------------

function Vehicles({ ctx, state, extras, edit }: { ctx: HubContext; state: State; extras: Extras; edit: (e: Editing) => void }) {
  const t = state.today
  return (
    <div className="stack">
      <div className="row">
        <Button icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'vehicle' })}>
          Add a vehicle
        </Button>
      </div>
      {state.vehicles.length === 0 && <p className="muted small">The registration, VIN and licence disc stay in Quick Info (end-to-end encrypted); here a vehicle has a nickname, its services and what is due.</p>}
      {state.vehicles.map((v) => {
        const st = v.status
        const qi = extras.qiVehicles.find((q) => q.id === v.quickInfoId)
        const history = state.jobs.filter((j) => j.forId === v.id).sort((a, b) => b.date.localeCompare(a.date))
        return (
          <Card
            key={v.id}
            title={
              <>
                <Car size={18} aria-hidden /> {v.label}
              </>
            }
            actions={<Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${v.label}`} onClick={() => edit({ what: 'vehicle', vehicle: v })} />}
          >
            {qi && (
              <p className="muted small">
                {[qi.description, qi.registration, qi.licenceExpiry && `licence disc ${shortDate(qi.licenceExpiry, t)}`].filter(Boolean).join(' · ')}
              </p>
            )}
            {v.quickInfoId && !qi && <p className="muted small">Linked to Quick Info (open the family vault to see its registration).</p>}
            <dl className="care-facts">
              <dt>Next service</dt>
              <dd>
                {st.nextService ? (
                  <>
                    {shortDate(st.nextService, t)} ({relative(t, st.nextService)}) {dueBadge(t, st.nextService)}
                    {st.nextKm !== null && <div className="muted small">or at {st.nextKm.toLocaleString('en-ZA')} km{st.nextByKm ? `, about ${shortDate(st.nextByKm, t)} at the usual rate` : ''}</div>}
                  </>
                ) : (
                  <span className="muted">Log the last service to work it out{!v.serviceMonths && !v.serviceKm ? ', and set the interval' : ''}.</span>
                )}
              </dd>
              {st.lastService && (
                <>
                  <dt>Last service</dt>
                  <dd>
                    {shortDate(st.lastService.date, t)}
                    {st.lastService.km !== null && ` at ${st.lastService.km.toLocaleString('en-ZA')} km`}
                  </dd>
                </>
              )}
              {st.kmNow !== null && (
                <>
                  <dt>Odometer</dt>
                  <dd>about {st.kmNow.toLocaleString('en-ZA')} km</dd>
                </>
              )}
              {v.roadworthyDue && (
                <>
                  <dt>Roadworthy</dt>
                  <dd>
                    {shortDate(v.roadworthyDue, t)} {dueBadge(t, v.roadworthyDue, 60)}
                  </dd>
                </>
              )}
              {(v.warrantyEnd || v.servicePlanEnd) && (
                <>
                  <dt>Warranty and plan</dt>
                  <dd>{[v.warrantyEnd && `warranty to ${shortDate(v.warrantyEnd, t)}`, v.servicePlanEnd && `service plan to ${shortDate(v.servicePlanEnd, t)}`].filter(Boolean).join(' · ')}</dd>
                </>
              )}
              {v.tyres && (
                <>
                  <dt>Tyres</dt>
                  <dd>{v.tyres}</dd>
                </>
              )}
              {v.battery && (
                <>
                  <dt>Battery</dt>
                  <dd>{v.battery}</dd>
                </>
              )}
            </dl>
            <div className="row">
              <Button variant="secondary" icon={<Wrench size={16} aria-hidden />} onClick={() => edit({ what: 'job', preset: { forId: v.id, service: true, what: 'Service' } })}>
                Log a service or repair
              </Button>
              <Button variant="ghost" icon={<Gauge size={16} aria-hidden />} onClick={() => edit({ what: 'reading', vehicle: v })}>
                Odometer reading
              </Button>
            </div>
            {history.length > 0 && <JobList ctx={ctx} state={state} extras={extras} jobs={history} edit={edit} showFor={false} />}
          </Card>
        )
      })}
    </div>
  )
}

// ---- warranties --------------------------------------------------------------------------------

function Things({ ctx, state, edit }: { ctx: HubContext; state: State; edit: (e: Editing) => void }) {
  const t = state.today
  const sorted = [...state.items].sort((a, b) => (a.warrantyEnd ?? '9').localeCompare(b.warrantyEnd ?? '9'))
  return (
    <Card
      title={
        <>
          <Home size={18} aria-hidden /> Warranties and manuals
        </>
      }
      actions={
        <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'thing' })}>
          Add something
        </Button>
      }
    >
      {state.items.length === 0 && <p className="muted small">Appliances, electronics, tools, furniture: what it is, where it was bought, the warranty, and the receipt and manual in the Household folder.</p>}
      <ul className="item-list">
        {sorted.map((i) => (
          <li key={i.id}>
            <div className="item-main">
              <div>
                <strong>{i.name}</strong> <span className="muted small">{[i.make, i.model].filter(Boolean).join(' ')}</span>
                {i.warrantyEnd && (i.warrantyEnd < t ? <Badge>Warranty ended</Badge> : dueBadge(t, i.warrantyEnd, 60))}
              </div>
              <div className="muted small">
                {[i.where, i.boughtOn && `bought ${shortDate(i.boughtOn, t)}${i.boughtFrom ? ` at ${i.boughtFrom}` : ''}`, i.price !== null && rand(i.price), i.warrantyEnd && `warranty to ${shortDate(i.warrantyEnd, t)}`].filter(Boolean).join(' · ')}
              </div>
              {i.documents.length > 0 && <Documents ctx={ctx} documents={i.documents} />}
            </div>
            <Button variant="ghost" icon={<Hammer size={16} aria-hidden />} aria-label={`Log a repair to ${i.name}`} onClick={() => edit({ what: 'job', preset: { forId: i.id, what: 'Repair' } })} />
            <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${i.name}`} onClick={() => edit({ what: 'thing', thing: i })} />
          </li>
        ))}
      </ul>
    </Card>
  )
}

// ---- maintenance -------------------------------------------------------------------------------

function Tasks({ state, extras, edit }: { state: State; extras: Extras; edit: (e: Editing) => void }) {
  const t = state.today
  const sorted = [...state.tasks].sort((a, b) => (a.status.nextDue ?? '0').localeCompare(b.status.nextDue ?? '0'))
  const unused = SUGGESTED.filter(([name]) => !state.tasks.some((x) => x.name === name))
  return (
    <Card
      title={
        <>
          <Wrench size={18} aria-hidden /> Maintenance that comes back
        </>
      }
      actions={
        <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'task' })}>
          Add maintenance
        </Button>
      }
    >
      <ul className="item-list">
        {sorted.map((task) => (
          <li key={task.id}>
            <div className="item-main">
              <div>
                <strong>{task.name}</strong> <span className="muted small">every {task.everyMonths === 1 ? 'month' : `${task.everyMonths} months`}</span> {dueBadge(t, task.status.nextDue)}
              </div>
              <div className="muted small">
                {task.status.lastDone ? `Last done ${shortDate(task.status.lastDone, t)}` : 'Not done yet'}
                {task.status.nextDue && ` · next ${shortDate(task.status.nextDue, t)}`}
                {task.forId && ` · ${forName(state, task.forId)}`}
                {task.contactId && ` · ${whoName(extras, task)}`}
              </div>
            </div>
            <Button variant="secondary" aria-label={`Mark ${task.name} done`} onClick={() => edit({ what: 'job', preset: { forId: task.id, what: task.name, contactId: task.contactId } })}>
              Mark done
            </Button>
            <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${task.name}`} onClick={() => edit({ what: 'task', task })} />
          </li>
        ))}
      </ul>
      {unused.length > 0 && (
        <div className="stack-sm">
          <p className="muted small">Add with one tap:</p>
          <div className="row chips">
            {unused.map(([name, months]) => (
              <button key={name} className="chip" onClick={() => edit({ what: 'task', preset: { name, everyMonths: months } })}>
                + {name}
              </button>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}

// ---- jobs and tradespeople ---------------------------------------------------------------------

function JobList({ ctx, state, extras, jobs, edit, showFor = true }: { ctx: HubContext; state: State; extras: Extras; jobs: Job[]; edit: (e: Editing) => void; showFor?: boolean }) {
  const t = state.today
  return (
    <ul className="item-list">
      {jobs.map((j) => (
        <li key={j.id}>
          <div className="item-main">
            <div>
              <strong>{j.what}</strong>
              {showFor && j.forId && <span className="muted small"> · {forName(state, j.forId)}</span>} {j.cost !== null && rand(j.cost)}
              {j.again === 'yes' && <Badge tone="success">Would use again</Badge>}
              {j.again === 'no' && <Badge tone="warning">Would not use again</Badge>}
            </div>
            <div className="muted small">
              {shortDate(j.date, t)}
              {whoName(extras, j) && ` · ${whoName(extras, j)}`}
              {j.km !== null && ` · ${j.km.toLocaleString('en-ZA')} km`}
              {j.againNote && ` · ${j.againNote}`}
            </div>
            {j.documents.length > 0 && <Documents ctx={ctx} documents={j.documents} />}
          </div>
          <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit the job ${j.what} on ${j.date}`} onClick={() => edit({ what: 'job', job: j })} />
        </li>
      ))}
    </ul>
  )
}

function Jobs({ ctx, state, extras, edit }: { ctx: HubContext; state: State; extras: Extras; edit: (e: Editing) => void }) {
  const jobs = [...state.jobs].sort((a, b) => b.date.localeCompare(a.date))
  // Tradespeople: everyone who has done a job, with how it went.
  const people = new Map<string, { name: string; contact?: Contact; jobs: Job[] }>()
  for (const j of jobs) {
    const name = whoName(extras, j)
    if (!name) continue
    const key = j.contactId ?? `name:${name.toLowerCase()}`
    const entry = people.get(key) ?? { name, contact: extras.contacts.find((c) => c.id === j.contactId), jobs: [] }
    entry.jobs.push(j)
    people.set(key, entry)
  }
  return (
    <div className="stack">
      <Card
        title={
          <>
            <Hammer size={18} aria-hidden /> Jobs done
          </>
        }
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'job' })}>
            Log a job
          </Button>
        }
      >
        {jobs.length === 0 ? <p className="muted small">Repairs, services and installations: when, who, what it cost, and whether you would use them again.</p> : <JobList ctx={ctx} state={state} extras={extras} jobs={jobs} edit={edit} />}
      </Card>
      {people.size > 0 && (
        <Card title="Tradespeople">
          <ul className="item-list">
            {[...people.values()]
              .sort((a, b) => b.jobs.length - a.jobs.length || a.name.localeCompare(b.name))
              .map((p) => {
                const yes = p.jobs.filter((j) => j.again === 'yes').length
                const no = p.jobs.filter((j) => j.again === 'no').length
                const spent = p.jobs.reduce((n, j) => n + (j.cost ?? 0), 0)
                const phone = p.contact?.phones[0]?.number
                return (
                  <li key={p.name}>
                    <div className="item-main">
                      <div>
                        <strong>{p.name}</strong>
                        {yes > 0 && (
                          <span className="small care-vote">
                            <ThumbsUp size={14} aria-label="Would use again" /> {yes}
                          </span>
                        )}
                        {no > 0 && (
                          <span className="small care-vote">
                            <ThumbsDown size={14} aria-label="Would not use again" /> {no}
                          </span>
                        )}
                      </div>
                      <div className="muted small">
                        {p.jobs.length} job{p.jobs.length === 1 ? '' : 's'}, last {shortDate(p.jobs[0]!.date, state.today)} ({p.jobs[0]!.what}){spent > 0 && ` · ${rand(spent)} in all`}
                      </div>
                    </div>
                    {phone && (
                      <a className="btn btn-ghost" href={`tel:${phone.replace(/[^0-9+]/g, '')}`} aria-label={`Call ${p.name}`}>
                        <Phone size={16} aria-hidden />
                        <span>{phone}</span>
                      </a>
                    )}
                  </li>
                )
              })}
          </ul>
          <p className="muted small">Add tradespeople to Contacts to keep their numbers here.</p>
        </Card>
      )}
    </div>
  )
}

// ---- dialogs -----------------------------------------------------------------------------------

/** Saves one item (new or changed). */
async function saveCare(ctx: HubContext, kind: 'vehicles' | 'items' | 'tasks' | 'jobs', item: Record<string, unknown>, existing?: { id: string; version: number }) {
  const { api } = ctx.platform
  if (existing) await api.request('PUT', `/api/home-care/${kind}/${existing.id}`, { baseVersion: existing.version, item }).catch(conflict)
  else await api.post(`/api/home-care/${kind}`, { item })
}

function useRemove(ctx: HubContext, kind: string, existing: { id: string } | undefined, confirm: string, onClose: (c?: boolean) => void) {
  return useAction(async () => {
    if (!existing || !window.confirm(confirm)) return
    await ctx.platform.api.del(`/api/home-care/${kind}/${existing.id}`)
    onClose(true)
  })
}

const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(/[\s,]/g, '')))

function VehicleDialog({ ctx, state, extras, vehicle, onClose }: { ctx: HubContext; state: State; extras: Extras; vehicle?: Vehicle; onClose: (c?: boolean) => void }) {
  const [f, setF] = useState(() => ({
    label: vehicle?.label ?? '',
    quickInfoId: vehicle?.quickInfoId ?? '',
    serviceMonths: vehicle?.serviceMonths?.toString() ?? '12',
    serviceKm: vehicle?.serviceKm?.toString() ?? '15000',
    roadworthyDue: vehicle?.roadworthyDue ?? '',
    warrantyEnd: vehicle?.warrantyEnd ?? '',
    servicePlanEnd: vehicle?.servicePlanEnd ?? '',
    tyres: vehicle?.tyres ?? '',
    battery: vehicle?.battery ?? '',
    notes: vehicle?.notes ?? '',
  }))
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    await saveCare(
      ctx,
      'vehicles',
      { ...f, quickInfoId: f.quickInfoId || null, serviceMonths: num(f.serviceMonths), serviceKm: num(f.serviceKm), roadworthyDue: f.roadworthyDue || null, warrantyEnd: f.warrantyEnd || null, servicePlanEnd: f.servicePlanEnd || null, readings: vehicle?.readings ?? [] },
      vehicle,
    )
    onClose(true)
  })
  const remove = useRemove(ctx, 'vehicles', vehicle, `Delete ${vehicle?.label}? Its jobs stay in the history.`, onClose)
  const linked = state.vehicles.filter((v) => v.id !== vehicle?.id).map((v) => v.quickInfoId)
  return (
    <Dialog open title={vehicle ? `Edit ${vehicle.label}` : 'Add a vehicle'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="veh-label" label="Name" hint="A nickname, e.g. The Polo, Mom’s car.">
          <input id="veh-label" className="qi-search" maxLength={60} required value={f.label} onChange={(e) => set('label', e.target.value)} />
        </Labelled>
        <Labelled id="veh-qi" label="The vehicle in Quick Info" hint={extras.qiVehicles.length ? 'Its registration, VIN and licence disc stay there, end-to-end encrypted.' : 'Open the family vault (or add the vehicle in Quick Info) to link it.'}>
          <select id="veh-qi" className="select" value={f.quickInfoId} onChange={(e) => set('quickInfoId', e.target.value)}>
            <option value="">Not linked</option>
            {extras.qiVehicles
              .filter((q) => !linked.includes(q.id))
              .map((q) => (
                <option key={q.id} value={q.id}>
                  {[q.description, q.registration].filter(Boolean).join(' · ') || 'Vehicle'}
                </option>
              ))}
            {f.quickInfoId && !extras.qiVehicles.some((q) => q.id === f.quickInfoId) && <option value={f.quickInfoId}>Linked (vault closed)</option>}
          </select>
        </Labelled>
        <div className="row">
          <Labelled id="veh-months" label="Service every (months)">
            <input id="veh-months" className="qi-search year-input" type="number" min={1} max={60} value={f.serviceMonths} onChange={(e) => set('serviceMonths', e.target.value)} />
          </Labelled>
          <Labelled id="veh-km" label="or every (km)">
            <input id="veh-km" className="qi-search" inputMode="numeric" value={f.serviceKm} onChange={(e) => set('serviceKm', e.target.value)} />
          </Labelled>
        </div>
        <Labelled id="veh-rwc" label="Roadworthy due" hint="If one is needed (e.g. when selling, or for some licences).">
          <input id="veh-rwc" className="qi-search" type="date" value={f.roadworthyDue} onChange={(e) => set('roadworthyDue', e.target.value)} />
        </Labelled>
        <div className="row">
          <Labelled id="veh-warranty" label="Warranty ends">
            <input id="veh-warranty" className="qi-search" type="date" value={f.warrantyEnd} onChange={(e) => set('warrantyEnd', e.target.value)} />
          </Labelled>
          <Labelled id="veh-plan" label="Service plan ends">
            <input id="veh-plan" className="qi-search" type="date" value={f.servicePlanEnd} onChange={(e) => set('servicePlanEnd', e.target.value)} />
          </Labelled>
        </div>
        <Labelled id="veh-tyres" label="Tyres">
          <input id="veh-tyres" className="qi-search" maxLength={300} placeholder="e.g. 4 new Bridgestones, March 2026, 92 000 km" value={f.tyres} onChange={(e) => set('tyres', e.target.value)} />
        </Labelled>
        <Labelled id="veh-battery" label="Battery">
          <input id="veh-battery" className="qi-search" maxLength={300} placeholder="e.g. Willard 652, fitted June 2025, 24-month guarantee" value={f.battery} onChange={(e) => set('battery', e.target.value)} />
        </Labelled>
        <Labelled id="veh-notes" label="Notes">
          <textarea id="veh-notes" className="textarea" rows={2} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={vehicle ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

function ReadingDialog({ ctx, state, vehicle, onClose }: { ctx: HubContext; state: State; vehicle: Vehicle; onClose: (c?: boolean) => void }) {
  const [day, setDay] = useState(state.today)
  const [km, setKm] = useState('')
  const save = useAction(async () => {
    const value = num(km)
    if (value === null || !Number.isInteger(value) || value < 0) throw new Error('Enter the odometer reading in kilometres.')
    const { id, version, status: _status, ...rest } = vehicle
    void _status
    await saveCare(ctx, 'vehicles', { ...rest, readings: [...vehicle.readings.filter((r) => r.date !== day), { date: day, km: value }] }, { id, version })
    onClose(true)
  })
  return (
    <Dialog open title={`Odometer · ${vehicle.label}`} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <p className="muted small">A reading now and then lets the hub estimate when the next service falls due by distance.</p>
        <div className="row">
          <Labelled id="read-date" label="Date">
            <input id="read-date" className="qi-search" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Labelled>
          <Labelled id="read-km" label="Kilometres">
            <input id="read-km" className="qi-search" inputMode="numeric" required value={km} onChange={(e) => setKm(e.target.value)} />
          </Labelled>
        </div>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} />
      </form>
    </Dialog>
  )
}

function ThingDialog({ ctx, thing, onClose }: { ctx: HubContext; thing?: Thing; onClose: (c?: boolean) => void }) {
  const [f, setF] = useState(() => ({
    name: thing?.name ?? '',
    make: thing?.make ?? '',
    model: thing?.model ?? '',
    serial: thing?.serial ?? '',
    where: thing?.where ?? '',
    boughtOn: thing?.boughtOn ?? '',
    boughtFrom: thing?.boughtFrom ?? '',
    warrantyEnd: thing?.warrantyEnd ?? '',
    notes: thing?.notes ?? '',
  }))
  const [price, setPrice] = useState(thing?.price != null ? amountText(thing.price) : '')
  const [documents, setDocuments] = useState(thing?.documents ?? [])
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    const cents = price.trim() ? parseRand(price) : null
    if (price.trim() && cents === null) throw new Error('Enter the price, for example 8999.00.')
    await saveCare(ctx, 'items', { ...f, boughtOn: f.boughtOn || null, warrantyEnd: f.warrantyEnd || null, price: cents, documents }, thing)
    onClose(true)
  })
  const remove = useRemove(ctx, 'items', thing, `Delete ${thing?.name}? Its documents stay in the Household folder, and its jobs in the history.`, onClose)
  return (
    <Dialog open title={thing ? `Edit ${thing.name}` : 'Add something with a warranty'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="thing-name" label="What it is">
          <input id="thing-name" className="qi-search" maxLength={120} required placeholder="e.g. Fridge, TV, Geyser, Laptop" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Labelled>
        <div className="row">
          <Labelled id="thing-make" label="Make">
            <input id="thing-make" className="qi-search" maxLength={60} value={f.make} onChange={(e) => set('make', e.target.value)} />
          </Labelled>
          <Labelled id="thing-model" label="Model">
            <input id="thing-model" className="qi-search" maxLength={60} value={f.model} onChange={(e) => set('model', e.target.value)} />
          </Labelled>
        </div>
        <div className="row">
          <Labelled id="thing-serial" label="Serial number">
            <input id="thing-serial" className="qi-search" maxLength={60} value={f.serial} onChange={(e) => set('serial', e.target.value)} />
          </Labelled>
          <Labelled id="thing-where" label="Where it is">
            <input id="thing-where" className="qi-search" maxLength={60} placeholder="e.g. Kitchen" value={f.where} onChange={(e) => set('where', e.target.value)} />
          </Labelled>
        </div>
        <div className="row">
          <Labelled id="thing-bought" label="Bought on">
            <input id="thing-bought" className="qi-search" type="date" value={f.boughtOn} onChange={(e) => set('boughtOn', e.target.value)} />
          </Labelled>
          <Labelled id="thing-from" label="Bought from">
            <input id="thing-from" className="qi-search" maxLength={120} placeholder="e.g. Hirsch’s" value={f.boughtFrom} onChange={(e) => set('boughtFrom', e.target.value)} />
          </Labelled>
        </div>
        <div className="row">
          <Labelled id="thing-price" label="Price (R)">
            <input id="thing-price" className="qi-search" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </Labelled>
          <Labelled id="thing-warranty" label="Warranty ends">
            <input id="thing-warranty" className="qi-search" type="date" value={f.warrantyEnd} onChange={(e) => set('warrantyEnd', e.target.value)} />
          </Labelled>
        </div>
        <Labelled id="thing-notes" label="Notes">
          <textarea id="thing-notes" className="textarea" rows={2} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        <AttachDocuments ctx={ctx} documents={documents} onChange={setDocuments} folder={HOUSEHOLD} />
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={thing ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

function TaskDialog({ ctx, state, extras, task, preset, onClose }: { ctx: HubContext; state: State; extras: Extras; task?: Task; preset?: Partial<Task>; onClose: (c?: boolean) => void }) {
  const [f, setF] = useState(() => ({
    name: task?.name ?? preset?.name ?? '',
    everyMonths: String(task?.everyMonths ?? preset?.everyMonths ?? 12),
    lastDone: task?.lastDone ?? '',
    forId: task?.forId ?? '',
    contactId: task?.contactId ?? '',
    notes: task?.notes ?? '',
  }))
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    await saveCare(ctx, 'tasks', { ...f, everyMonths: Number(f.everyMonths), lastDone: f.lastDone || null, forId: f.forId || null, contactId: f.contactId || null }, task)
    onClose(true)
  })
  const remove = useRemove(ctx, 'tasks', task, `Delete ${task?.name}? Jobs already logged stay in the history.`, onClose)
  return (
    <Dialog open title={task ? `Edit ${task.name}` : 'Add maintenance'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="task-name" label="The job">
          <input id="task-name" className="qi-search" maxLength={120} required placeholder="e.g. Geyser service" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Labelled>
        <Labelled id="task-every" label="Every (months)">
          <input id="task-every" className="qi-search year-input" type="number" min={1} max={120} required value={f.everyMonths} onChange={(e) => set('everyMonths', e.target.value)} />
        </Labelled>
        <Labelled id="task-last" label="Last done" hint="If you know. After this, logging the job moves it on.">
          <input id="task-last" className="qi-search" type="date" value={f.lastDone} onChange={(e) => set('lastDone', e.target.value)} />
        </Labelled>
        <Labelled id="task-for" label="For">
          <select id="task-for" className="select" value={f.forId} onChange={(e) => set('forId', e.target.value)}>
            <option value="">The home</option>
            {state.vehicles.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
            {state.items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled id="task-contact" label="Usually done by (Contacts)">
          <select id="task-contact" className="select" value={f.contactId} onChange={(e) => set('contactId', e.target.value)}>
            <option value="">Not chosen</option>
            {extras.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled id="task-notes" label="Notes">
          <textarea id="task-notes" className="textarea" rows={2} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={task ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

function JobDialog({ ctx, state, extras, job, preset, onClose }: { ctx: HubContext; state: State; extras: Extras; job?: Job; preset?: Partial<Job>; onClose: (c?: boolean) => void }) {
  const base = job ?? preset ?? {}
  const [f, setF] = useState(() => ({
    date: job?.date ?? state.today,
    what: base.what ?? '',
    service: base.service ?? false,
    forId: base.forId ?? '',
    contactId: base.contactId ?? '',
    who: base.who ?? '',
    km: base.km != null ? String(base.km) : '',
    again: base.again ?? ('' as Job['again']),
    againNote: base.againNote ?? '',
    invoiceId: base.invoiceId ?? '',
    notes: base.notes ?? '',
  }))
  const [cost, setCost] = useState(job?.cost != null ? amountText(job.cost) : '')
  const [documents, setDocuments] = useState(job?.documents ?? [])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const isVehicle = state.vehicles.some((v) => v.id === f.forId)
  const save = useAction(async () => {
    const cents = cost.trim() ? parseRand(cost) : null
    if (cost.trim() && cents === null) throw new Error('Enter the cost, for example 1250.00.')
    const km = isVehicle ? num(f.km) : null
    if (km !== null && (!Number.isInteger(km) || km < 0)) throw new Error('Enter the odometer in whole kilometres.')
    await saveCare(
      ctx,
      'jobs',
      { ...f, service: isVehicle && f.service, forId: f.forId || null, contactId: f.contactId || null, km, cost: cents, invoiceId: f.invoiceId || null, documents },
      job,
    )
    onClose(true)
  })
  const remove = useRemove(ctx, 'jobs', job, 'Delete this job from the history?', onClose)
  return (
    <Dialog open title={job ? 'Edit the job' : 'Log a job'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <div className="row">
          <Labelled id="job-date" label="Date">
            <input id="job-date" className="qi-search" type="date" required value={f.date} onChange={(e) => set('date', e.target.value)} />
          </Labelled>
          <Labelled id="job-for" label="For">
            <select id="job-for" className="select" value={f.forId} onChange={(e) => set('forId', e.target.value)}>
              <option value="">The home</option>
              {state.vehicles.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
              {state.items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
              {state.tasks.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.name} (maintenance)
                </option>
              ))}
            </select>
          </Labelled>
        </div>
        <Labelled id="job-what" label="What was done">
          <input id="job-what" className="qi-search" maxLength={200} required placeholder="e.g. Major service; Replaced the geyser element" value={f.what} onChange={(e) => set('what', e.target.value)} />
        </Labelled>
        {isVehicle && (
          <>
            <label className="check">
              <input type="checkbox" checked={f.service} onChange={(e) => set('service', e.target.checked)} />
              <span>It was a service (the next one is counted from here)</span>
            </label>
            <Labelled id="job-km" label="Odometer (km)">
              <input id="job-km" className="qi-search" inputMode="numeric" value={f.km} onChange={(e) => set('km', e.target.value)} />
            </Labelled>
          </>
        )}
        <Labelled id="job-contact" label="Done by (Contacts)">
          <select id="job-contact" className="select" value={f.contactId} onChange={(e) => set('contactId', e.target.value)}>
            <option value="">Not in Contacts</option>
            {extras.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Labelled>
        {!f.contactId && (
          <Labelled id="job-who" label="Or their name">
            <input id="job-who" className="qi-search" maxLength={120} placeholder="e.g. Corner Garage" value={f.who} onChange={(e) => set('who', e.target.value)} />
          </Labelled>
        )}
        <Labelled id="job-cost" label="Cost (R)">
          <input id="job-cost" className="qi-search" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
        </Labelled>
        <fieldset className="radio-group">
          <legend>Would you use them again?</legend>
          <div className="row">
            {(
              [
                ['yes', 'Yes'],
                ['no', 'No'],
                ['', 'Not sure'],
              ] as const
            ).map(([v, l]) => (
              <label key={l} className="check">
                <input type="radio" name="job-again" checked={f.again === v} onChange={() => set('again', v)} />
                <span>{l}</span>
              </label>
            ))}
          </div>
          {f.again && <input className="qi-search" aria-label="Why" maxLength={300} placeholder={f.again === 'yes' ? 'e.g. On time, fair price, cleaned up' : 'e.g. Late twice, had to call them back'} value={f.againNote} onChange={(e) => set('againNote', e.target.value)} />}
        </fieldset>
        {extras.invoices.length > 0 && (
          <Labelled id="job-invoice" label="Invoice (Bills & budget)">
            <select id="job-invoice" className="select" value={f.invoiceId} onChange={(e) => set('invoiceId', e.target.value)}>
              <option value="">None</option>
              {extras.invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.from}
                  {i.number ? ` ${i.number}` : ''} · {rand(i.amount)}
                </option>
              ))}
            </select>
          </Labelled>
        )}
        <Labelled id="job-notes" label="Notes">
          <textarea id="job-notes" className="textarea" rows={2} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        <AttachDocuments ctx={ctx} documents={documents} onChange={setDocuments} folder={HOUSEHOLD} />
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={job ? () => void remove.run() : undefined} deleting={remove.busy} submit={job ? 'Save' : 'Log it'} />
      </form>
    </Dialog>
  )
}

