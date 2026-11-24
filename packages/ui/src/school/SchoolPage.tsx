/**
 * School (phase 7a), for parents: a page per child that brings the school
 * together, keeping things in their proper place: dates on the calendar,
 * fees in Bills, costs as planned expenses, documents in the School folder,
 * people in Contacts. Kept here: the school and class each year with its
 * terms, the school's contacts and their roles, extra-murals by term, and
 * reminders for the irregular things.
 */
import { Backpack, Bell, BookOpen, Clock, CalendarPlus, CheckCircle2, Circle, FileSignature, FolderOpen, GraduationCap, ListChecks, Pencil, Phone, Plus, Trash2, Trophy, Users } from 'lucide-react'
import { AttachDocuments, Documents } from '../health/parts.tsx'
import { useCallback, useEffect, useState } from 'react'
import { PlannedDialog } from '../money/Budget.tsx'
import { monthName, type Category, type Planned } from '../money/budget-model.ts'
import { Actions, conflict, Labelled } from '../money/form.tsx'
import { amountText, parseRand, rand, relative, shortDate } from '../money/model.ts'
import type { Contact } from '../pages/Contacts.tsx'
import { navigate } from '../router.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, PageHeader, Spinner, errorText, useAction } from '../ui.tsx'

const WEEKDAYS: [string, string][] = [
  ['MO', 'Monday'],
  ['TU', 'Tuesday'],
  ['WE', 'Wednesday'],
  ['TH', 'Thursday'],
  ['FR', 'Friday'],
  ['SA', 'Saturday'],
  ['SU', 'Sunday'],
]
const ROLES: [string, string][] = [
  ['teacher', 'Teacher'],
  ['assistant', 'Assistant teacher'],
  ['principal', 'Principal'],
  ['office', 'School office'],
  ['aftercare', 'Aftercare'],
  ['coach', 'Coach'],
  ['lift club', 'Lift club'],
  ['other', 'Other'],
]
const PER: [string, string][] = [
  ['term', 'a term'],
  ['month', 'a month'],
  ['year', 'a year'],
  ['session', 'a session'],
  ['once', 'once'],
]
const REMIND: [string, number[]][] = [
  ['On the day', [0]],
  ['The day before and on the day', [1, 0]],
  ['A week before and the day before', [7, 1]],
  ['Two weeks, a week and a day before', [14, 7, 1]],
]

interface Base {
  id: string
  version: number
  profileId: string | null
}
interface Year extends Base {
  kind: 'year'
  year: number
  school: string
  grade: string
  terms: { name: string; start: string; end: string }[]
  feesBillId: string | null
  notes: string
}
interface SchoolContact extends Base {
  kind: 'contact'
  contactId: string
  role: string
  note: string
}
interface Activity extends Base {
  kind: 'activity'
  name: string
  who: string
  contactId: string | null
  location: string
  sessions: { day: string; start: string; end: string }[]
  from: string
  to: string
  term: string
  cancelContactId: string | null
  cancelPhone: string
  cost: number | null
  costPer: string
  billId: string | null
  invoiceId: string | null
  plannedId: string | null
  eventIds: string[]
  notes: string
}
interface Reminder extends Base {
  kind: 'reminder'
  what: string
  date: string
  leads: number[]
  notes: string
  done: boolean
}
interface Form extends Base {
  kind: 'form'
  what: string
  needs: 'sign' | 'pay' | 'sign and pay' | 'return'
  amount: number | null
  due: string
  documents: { id: string; name: string }[]
  done: boolean
  doneOn: string | null
  notes: string
}
interface SList extends Base {
  kind: 'list'
  type: 'uniform' | 'stationery' | 'kit' | 'bring'
  name: string
  year: number
  items: { text: string; qty: string; done: boolean; day: string | null }[]
  notes: string
}
interface Timetable extends Base {
  kind: 'timetable'
  year: number
  lessons: { day: string; start: string; end: string; subject: string; note: string }[]
}
interface Homework extends Base {
  kind: 'homework'
  type: 'homework' | 'project' | 'test'
  subject: string
  what: string
  due: string
  done: boolean
  notes: string
}
type Item = Year | SchoolContact | Activity | Reminder | Form | SList | Timetable | Homework

interface Data {
  profiles: { id: string; displayName: string; userId: string | null }[]
  items: Item[]
}
interface Extras {
  today: string
  contacts: Contact[]
  bills: { id: string; name: string; amount: number; nextDue: string | null }[]
  invoices: { id: string; from: string; number: string; amount: number; status: string }[]
  planned: Planned[]
  categories: Category[]
}
interface CalItem {
  eventId: string
  kind?: string
  day: string
  title: string
  allDay: boolean
  start: string
  tags: string[]
  notes: string
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const plusDays = (day: string, n: number) => {
  const d = new Date(`${day}T12:00:00`)
  d.setDate(d.getDate() + n)
  return iso(d)
}
const tel = (n: string) => `tel:${n.replace(/[^0-9+]/g, '')}`
const SCHOOL_NOTE = 'From school'

type Editing =
  | { what: 'year'; profileId: string; year?: Year }
  | { what: 'contact'; profileId: string; contact?: SchoolContact }
  | { what: 'activity'; profileId: string; activity?: Activity }
  | { what: 'reminder'; profileId: string; reminder?: Reminder }
  | { what: 'dates'; profileId: string }
  | { what: 'cost'; profileId: string; planned?: Planned }
  | { what: 'add-child' }
  | { what: 'form'; profileId: string; form?: Form }
  | { what: 'list'; profileId: string; list?: SList; type?: SList['type'] }
  | { what: 'copy-list'; list: SList }
  | { what: 'timetable'; profileId: string; timetable?: Timetable }
  | { what: 'homework'; profileId: string; homework?: Homework }

export function SchoolPage({ ctx }: { ctx: HubContext }) {
  if (ctx.user.role !== 'admin') {
    return (
      <div className="page">
        <PageHeader title="School" />
        <Card>
          <p>School is kept by the parents for now.</p>
        </Card>
      </div>
    )
  }
  return <SchoolBody ctx={ctx} />
}

function SchoolBody({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const [data, setData] = useState<Data | null>(null)
  const [extras, setExtras] = useState<Extras | null>(null)
  const [dates, setDates] = useState<CalItem[]>([])
  const [error, setError] = useState('')
  const [childId, setChildId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)

  const load = useCallback(async () => {
    try {
      const [school, book, money, budget] = await Promise.all([
        api.get<Data>('/api/school'),
        api.get<{ contacts: Contact[] }>('/api/contacts'),
        api.get<{ today: string; bills: Extras['bills']; invoices: Extras['invoices'] }>('/api/money'),
        api.get<{ planned: Planned[]; categories: Category[] }>('/api/budget'),
      ])
      setData(school)
      setExtras({ today: money.today, contacts: book.contacts, bills: money.bills, invoices: money.invoices, planned: budget.planned, categories: budget.categories })
      const from = money.today
      const cal = await api.get<{ events: CalItem[] }>(`/api/calendar/events?from=${from}&to=${plusDays(from, 180)}`)
      // School dates only: the weekly extra-murals show under Extra-murals.
      setDates(cal.events.filter((e) => e.notes === SCHOOL_NOTE))
      setError('')
      setChildId((c) => c ?? school.items.find((i) => i.kind === 'year')?.profileId ?? null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])

  const done = (changed?: boolean) => {
    setEditing(null)
    if (changed) void load()
  }

  if (error) return <Banner kind="error">{error}</Banner>
  if (!data || !extras) return <Spinner />
  const atSchool = data.profiles.filter((p) => data.items.some((i) => i.kind === 'year' && i.profileId === p.id))
  const child = atSchool.find((p) => p.id === childId) ?? atSchool[0]

  return (
    <div className="page">
      <PageHeader title="School" subtitle="Each child’s school: dates, contacts, extra-murals, reminders, fees and costs, and documents. For parents only, for now." />
      <div className="row chips" role="group" aria-label="Which child">
        {atSchool.map((p) => (
          <button key={p.id} className={`chip ${p.id === child?.id ? 'chip-on' : ''}`} aria-pressed={p.id === child?.id} onClick={() => setChildId(p.id)}>
            {p.displayName}
          </button>
        ))}
        <button className="chip" onClick={() => setEditing({ what: 'add-child' })}>
          + Add a child
        </button>
      </div>
      {!child ? (
        <Card title="Getting started">
          <p>Add each child at school (or pre-school) with the school, the class and the term dates. Then link the teachers and the office from Contacts, add extra-murals and reminders, plan the school costs, and add dates as the school sends them.</p>
          <Button icon={<Plus size={16} aria-hidden />} onClick={() => setEditing({ what: 'add-child' })}>
            Add a child
          </Button>
        </Card>
      ) : (
        <ChildSchool ctx={ctx} data={data} extras={extras} dates={dates} child={child} edit={setEditing} reload={load} />
      )}

      {editing?.what === 'add-child' && (
        <AddChildDialog
          profiles={data.profiles.filter((p) => !atSchool.some((a) => a.id === p.id))}
          onPick={(profileId) => {
            setChildId(profileId)
            setEditing({ what: 'year', profileId })
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.what === 'year' && <YearDialog ctx={ctx} extras={extras} profileId={editing.profileId} year={editing.year} onClose={done} />}
      {editing?.what === 'contact' && <ContactDialog ctx={ctx} extras={extras} profileId={editing.profileId} contact={editing.contact} onClose={done} />}
      {editing?.what === 'activity' && child && (
        <ActivityDialog ctx={ctx} extras={extras} child={child} activity={editing.activity} terms={latestYear(data, child.id)?.terms ?? []} onClose={done} />
      )}
      {editing?.what === 'reminder' && <ReminderDialog ctx={ctx} extras={extras} profileId={editing.profileId} reminder={editing.reminder} onClose={done} />}
      {editing?.what === 'dates' && child && <DatesDialog ctx={ctx} child={child} today={extras.today} onClose={done} />}
      {editing?.what === 'form' && <FormDialog ctx={ctx} extras={extras} profileId={editing.profileId} form={editing.form} onClose={done} />}
      {editing?.what === 'list' && <ListDialog ctx={ctx} extras={extras} profileId={editing.profileId} list={editing.list} type={editing.type} onClose={done} />}
      {editing?.what === 'timetable' && <TimetableDialog ctx={ctx} extras={extras} profileId={editing.profileId} timetable={editing.timetable} onClose={done} />}
      {editing?.what === 'homework' && <HomeworkDialog ctx={ctx} extras={extras} profileId={editing.profileId} homework={editing.homework} onClose={done} />}
      {editing?.what === 'copy-list' && <CopyListDialog ctx={ctx} data={data} list={editing.list} year={Number(extras.today.slice(0, 4))} onClose={done} />}
      {editing?.what === 'cost' && (
        <PlannedDialog
          ctx={ctx}
          view={{ today: extras.today, categories: extras.categories }}
          people={data.profiles}
          planned={editing.planned}
          preset={{ tag: 'school', profileId: editing.profileId, categoryId: extras.categories.some((c) => c.id === 'school') ? 'school' : null }}
          onClose={done}
        />
      )}
    </div>
  )
}

const latestYear = (data: Data, profileId: string) =>
  data.items
    .filter((i): i is Year => i.kind === 'year' && i.profileId === profileId)
    .sort((a, b) => b.year - a.year)[0]

function ChildSchool({ ctx, data, extras, dates, child, edit, reload }: { ctx: HubContext; data: Data; extras: Extras; dates: CalItem[]; child: Data['profiles'][number]; edit: (e: Editing) => void; reload: () => Promise<void> }) {
  const { api } = ctx.platform
  const t = extras.today
  const year = latestYear(data, child.id)
  const contacts = data.items.filter((i): i is SchoolContact => i.kind === 'contact' && (i.profileId === child.id || i.profileId === null))
  const activities = data.items.filter((i): i is Activity => i.kind === 'activity' && i.profileId === child.id).sort((a, b) => a.from.localeCompare(b.from))
  const reminders = data.items.filter((i): i is Reminder => i.kind === 'reminder' && (i.profileId === child.id || i.profileId === null)).sort((a, b) => a.date.localeCompare(b.date))
  const upcomingReminders = reminders.filter((r) => !r.done && r.date >= t)
  const forms = data.items.filter((i): i is Form => i.kind === 'form' && i.profileId === child.id).sort((a, b) => a.due.localeCompare(b.due))
  const lists = data.items.filter((i): i is SList => i.kind === 'list' && i.profileId === child.id).sort((a, b) => b.year - a.year || a.name.localeCompare(b.name))
  const bring = lists.filter((l) => l.type === 'bring' && (!year || l.year === year.year))
  const setList = useAction(async (l: SList, items: SList['items']) => {
    const { id, version, kind: _k, profileId: _p, ...item } = l
    void _k
    void _p
    await api.request('PUT', `/api/school/lists/${id}`, { baseVersion: version, item: { ...item, items } }).catch(conflict)
    await reload()
  })
  const timetable = data.items.filter((i): i is Timetable => i.kind === 'timetable' && i.profileId === child.id).sort((a, b) => b.year - a.year)[0]
  const homework = data.items.filter((i): i is Homework => i.kind === 'homework' && i.profileId === child.id).sort((a, b) => a.due.localeCompare(b.due))
  const homeworkDone = useAction(async (h: Homework) => {
    const { id, version, kind: _k, profileId: _p, ...item } = h
    void _k
    void _p
    await api.request('PUT', `/api/school/homework/${id}`, { baseVersion: version, item: { ...item, done: !h.done } }).catch(conflict)
    await reload()
  })
  const formDone = useAction(async (f: Form) => {
    const { id, version, kind: _k, profileId: _p, ...item } = f
    void _k
    void _p
    await api.request('PUT', `/api/school/forms/${id}`, { baseVersion: version, item: { ...item, done: !f.done, doneOn: !f.done ? t : null } }).catch(conflict)
    await reload()
  })
  const pastReminders = reminders.filter((r) => r.done || r.date < t)
  const costs = extras.planned.filter((p) => p.profileId === child.id && p.tag.toLowerCase() === 'school').sort((a, b) => a.month.localeCompare(b.month))
  const fees = year?.feesBillId ? extras.bills.find((b) => b.id === year.feesBillId) : undefined
  const childDates = dates.filter((d) => d.tags.includes(child.id))
  const term = year?.terms.find((x) => x.start <= t && t <= x.end)
  const contactOf = (id: string | null) => (id ? extras.contacts.find((c) => c.id === id) : undefined)

  const toggleDone = useAction(async (r: Reminder) => {
    const { id, version, kind: _k, profileId: _p, ...item } = r
    void _k
    void _p
    await api.request('PUT', `/api/school/reminders/${id}`, { baseVersion: version, item: { ...item, done: !r.done } }).catch(conflict)
    await reload()
  })
  const openFolder = useAction(async () => {
    const { folderId } = await api.get<{ folderId: string }>(`/api/school/folder/${child.id}`)
    navigate(`/files/${folderId}`)
  })

  return (
    <div className="stack">
      <Card
        title={
          <>
            <GraduationCap size={18} aria-hidden /> {year ? year.school : 'School'}
          </>
        }
        actions={
          <>
            {year && <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label="Edit the school year" onClick={() => edit({ what: 'year', profileId: child.id, year })} />}
            <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'year', profileId: child.id })}>
              New year
            </Button>
          </>
        }
      >
        {year && (
          <>
            <p>
              <strong>{child.displayName}</strong> · {year.grade || 'class not set'} · {year.year}
              {term && <Badge tone="accent">{term.name} now</Badge>}
            </p>
            {year.terms.length > 0 && (
              <ul className="item-list small">
                {year.terms.map((x) => (
                  <li key={x.name}>
                    <div className="item-main">{x.name}</div>
                    <span className="muted">
                      {shortDate(x.start, t)} – {shortDate(x.end, t)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="small">
              Fees:{' '}
              {fees ? (
                <>
                  <strong>{fees.name}</strong> {rand(fees.amount)}
                  {fees.nextDue && `, next ${shortDate(fees.nextDue, t)}`}{' '}
                  <button className="link" onClick={() => navigate('/money')}>
                    Bills
                  </button>
                </>
              ) : (
                <span className="muted">not linked: add the fees as a bill in Bills & budget, then choose it here (Edit).</span>
              )}
            </p>
          </>
        )}
      </Card>

      {year && (
        <PlanTheYear
          checks={[
            { done: year.terms.length > 0, text: 'The terms and their dates', action: () => edit({ what: 'year', profileId: child.id, year }) },
            { done: !!year.feesBillId, text: 'The fees, as a bill (linked here)', action: () => edit({ what: 'year', profileId: child.id, year }) },
            { done: contacts.length > 0, text: 'The teacher and the school office in School contacts', action: () => edit({ what: 'contact', profileId: child.id }) },
            { done: lists.some((l) => l.year === year.year && (l.type === 'stationery' || l.type === 'uniform')), text: 'The stationery and uniform lists', action: () => edit({ what: 'list', profileId: child.id, type: 'stationery' }) },
            { done: costs.some((p) => p.month.startsWith(String(year.year))), text: 'This year’s school costs planned (camp, uniform, photos)', action: () => edit({ what: 'cost', profileId: child.id }) },
            { done: childDates.length > 0, text: 'The dates the school has sent so far', action: () => edit({ what: 'dates', profileId: child.id }) },
            { done: bring.length > 0, text: 'What to bring on which day', action: () => edit({ what: 'list', profileId: child.id, type: 'bring' }) },
          ]}
          year={year.year}
        />
      )}

      <Card
        title={
          <>
            <CalendarPlus size={18} aria-hidden /> School dates
          </>
        }
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'dates', profileId: child.id })}>
            Add dates from school
          </Button>
        }
      >
        {childDates.length === 0 ? (
          <p className="muted small">When the school sends dates (open day, sports day, concerts, photo day, closing day), add them here several at once. They go on the family calendar, tagged to {child.displayName}.</p>
        ) : (
          <ul className="item-list">
            {childDates.slice(0, 12).map((d) => (
              <li key={d.eventId + d.day}>
                <div className="item-main">
                  <div>{d.title}</div>
                  <div className="muted small">
                    {shortDate(d.day, t)}
                    {!d.allDay && ` ${d.start.slice(11, 16)}`} ({relative(t, d.day)})
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={
          <>
            <Bell size={18} aria-hidden /> Reminders
          </>
        }
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'reminder', profileId: child.id })}>
            Add a reminder
          </Button>
        }
      >
        {upcomingReminders.length === 0 && <p className="muted small">For the irregular things: a costume for Friday, money for the cake sale, a photo for the class project, plan for book week.</p>}
        <ul className="item-list">
          {upcomingReminders.map((r) => (
            <li key={r.id}>
              <input type="checkbox" aria-label={`Done: ${r.what}`} checked={r.done} onChange={() => void toggleDone.run(r)} />
              <div className="item-main">
                <div>
                  {r.what}
                  {r.profileId === null && <Badge>All children</Badge>}
                </div>
                <div className="muted small">
                  {shortDate(r.date, t)} ({relative(t, r.date)}){r.notes && ` · ${r.notes}`}
                </div>
              </div>
              <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${r.what}`} onClick={() => edit({ what: 'reminder', profileId: child.id, reminder: r })} />
            </li>
          ))}
        </ul>
        {pastReminders.length > 0 && (
          <details>
            <summary className="small">Done and past ({pastReminders.length})</summary>
            <ul className="item-list small">
              {pastReminders
                .slice(-20)
                .reverse()
                .map((r) => (
                  <li key={r.id}>
                    <input type="checkbox" aria-label={`Done: ${r.what}`} checked={r.done} onChange={() => void toggleDone.run(r)} />
                    <div className="item-main">
                      {r.what} <span className="muted">{shortDate(r.date, t)}</span>
                    </div>
                  </li>
                ))}
            </ul>
          </details>
        )}
        {toggleDone.error && <Banner kind="error">{toggleDone.error}</Banner>}
      </Card>

      <WhatToBring lists={bring} today={t} onEdit={(l) => edit({ what: 'list', profileId: child.id, list: l })} onAdd={() => edit({ what: 'list', profileId: child.id, type: 'bring' })} />

      <Card
        title={
          <>
            <FileSignature size={18} aria-hidden /> Forms and permission slips
          </>
        }
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'form', profileId: child.id })}>
            Add a form
          </Button>
        }
      >
        {forms.filter((f) => !f.done).length === 0 && <p className="muted small">Outings, indemnities, consent forms: what each needs (sign, pay, return), by when, with the form itself. Reminded 3 days and a day before, until it is done.</p>}
        <ul className="item-list">
          {forms
            .filter((f) => !f.done)
            .map((f) => (
              <li key={f.id}>
                <input type="checkbox" aria-label={`Done: ${f.what}`} checked={f.done} onChange={() => void formDone.run(f)} />
                <div className="item-main">
                  <div>
                    <strong>{f.what}</strong> <Badge>{f.needs}</Badge> {f.amount !== null && rand(f.amount)}
                  </div>
                  <div className={`small ${f.due < t ? 'field-error' : 'muted'}`}>
                    by {shortDate(f.due, t)} ({relative(t, f.due)}){f.notes && ` · ${f.notes}`}
                  </div>
                  {f.documents.length > 0 && <Documents ctx={ctx} documents={f.documents} />}
                </div>
                <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${f.what}`} onClick={() => edit({ what: 'form', profileId: child.id, form: f })} />
              </li>
            ))}
        </ul>
        {forms.some((f) => f.done) && (
          <details>
            <summary className="small">Done ({forms.filter((f) => f.done).length})</summary>
            <ul className="item-list small">
              {forms
                .filter((f) => f.done)
                .reverse()
                .map((f) => (
                  <li key={f.id}>
                    <input type="checkbox" aria-label={`Done: ${f.what}`} checked onChange={() => void formDone.run(f)} />
                    <div className="item-main">
                      {f.what} <span className="muted">{f.doneOn ? `done ${shortDate(f.doneOn, t)}` : ''}</span>
                    </div>
                  </li>
                ))}
            </ul>
          </details>
        )}
        {formDone.error && <Banner kind="error">{formDone.error}</Banner>}
      </Card>

      <Card
        title={
          <>
            <ListChecks size={18} aria-hidden /> Uniform, stationery and kit
          </>
        }
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'list', profileId: child.id, type: 'stationery' })}>
            Add a list
          </Button>
        }
      >
        {lists.filter((l) => l.type !== 'bring').length === 0 && <p className="muted small">The school’s stationery list, the uniform, sports kit: ticked as bought. Copy a list to next year or to another child.</p>}
        {lists
          .filter((l) => l.type !== 'bring')
          .map((l) => {
            const got = l.items.filter((x) => x.done).length
            return (
              <div key={l.id} className="school-list">
                <div className="row">
                  <strong>{l.name}</strong>
                  <span className="muted small">
                    {l.year} · {got} of {l.items.length} {l.type === 'uniform' || l.type === 'kit' ? 'got' : 'bought'}
                  </span>
                  <Button variant="ghost" aria-label={`Copy ${l.name}`} onClick={() => edit({ what: 'copy-list', list: l })}>
                    Copy
                  </Button>
                  <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${l.name}`} onClick={() => edit({ what: 'list', profileId: child.id, list: l })} />
                </div>
                <ul className="school-items">
                  {l.items.map((x, i) => (
                    <li key={i}>
                      <label className="check">
                        <input type="checkbox" checked={x.done} onChange={() => void setList.run(l, l.items.map((y, j) => (j === i ? { ...y, done: !y.done } : y)))} />
                        <span className={x.done ? 'school-got' : ''}>
                          {x.text}
                          {x.qty && <span className="muted"> × {x.qty}</span>}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        {setList.error && <Banner kind="error">{setList.error}</Banner>}
      </Card>

      <Card
        title={
          <>
            <Trophy size={18} aria-hidden /> Extra-murals
          </>
        }
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'activity', profileId: child.id })}>
            Add an extra-mural
          </Button>
        }
      >
        {activities.length === 0 && <p className="muted small">Swimming, ballet, soccer, music: who runs it, where and when, the number to cancel or postpone, and what it costs. Each goes on the calendar for its term.</p>}
        <ul className="item-list">
          {activities.map((a) => {
            const provider = contactOf(a.contactId)
            const cancel = contactOf(a.cancelContactId)
            const cancelNumber = a.cancelPhone || cancel?.phones[0]?.number
            const bill = extras.bills.find((b) => b.id === a.billId)
            const invoice = extras.invoices.find((i) => i.id === a.invoiceId)
            const planned = extras.planned.find((p) => p.id === a.plannedId)
            const over = a.to < t
            return (
              <li key={a.id} className={over ? 'muted' : ''}>
                <div className="item-main">
                  <div>
                    <strong>{a.name}</strong>
                    {a.term && <Badge>{a.term}</Badge>}
                    {over && <Badge>Ended</Badge>}
                  </div>
                  <div className="small">
                    {a.sessions.map((x) => `${WEEKDAYS.find(([d]) => d === x.day)?.[1]}s ${x.start}–${x.end}`).join(', ')}
                    {a.location && ` · ${a.location}`}
                  </div>
                  <div className="muted small">
                    {shortDate(a.from, t)} to {shortDate(a.to, t)}
                    {(a.who || provider) && ` · ${[a.who, provider?.name].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', ')}`}
                    {a.cost !== null && ` · ${rand(a.cost)} ${PER.find(([p]) => p === a.costPer)?.[1] ?? ''}`}
                    {bill && ` · bill: ${bill.name}`}
                    {invoice && ` · invoice: ${invoice.from}${invoice.status === 'paid' ? ' (paid)' : ''}`}
                    {planned && ` · planned: ${planned.name}`}
                  </div>
                </div>
                {cancelNumber && !over && (
                  <a className="btn btn-ghost" href={tel(cancelNumber)} aria-label={`Call to cancel or postpone ${a.name}: ${cancelNumber}`}>
                    <Phone size={16} aria-hidden />
                    <span>Cancel or postpone</span>
                  </a>
                )}
                <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${a.name}`} onClick={() => edit({ what: 'activity', profileId: child.id, activity: a })} />
              </li>
            )
          })}
        </ul>
      </Card>

      <Card
        title={
          <>
            <Users size={18} aria-hidden /> School contacts
          </>
        }
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'contact', profileId: child.id })}>
            Add a contact
          </Button>
        }
      >
        {contacts.length === 0 && <p className="muted small">The teacher, the office, aftercare, coaches and the lift club, from Contacts (add them there first).</p>}
        <ul className="item-list">
          {contacts.map((c) => {
            const person = contactOf(c.contactId)
            const phone = person?.phones[0]?.number
            return (
              <li key={c.id}>
                <div className="item-main">
                  <div>
                    <strong>{person?.name ?? 'Removed contact'}</strong> <span className="muted small">{ROLES.find(([r]) => r === c.role)?.[1]}</span>
                    {c.profileId === null && <Badge>All children</Badge>}
                  </div>
                  {(c.note || person?.emails[0]) && <div className="muted small">{[c.note, person?.emails[0]].filter(Boolean).join(' · ')}</div>}
                </div>
                {phone && (
                  <a className="btn btn-ghost" href={tel(phone)} aria-label={`Call ${person?.name}`}>
                    <Phone size={16} aria-hidden />
                    <span>{phone}</span>
                  </a>
                )}
                <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${person?.name ?? 'contact'}`} onClick={() => edit({ what: 'contact', profileId: child.id, contact: c })} />
              </li>
            )
          })}
        </ul>
      </Card>

      <Card
        title="School costs"
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'cost', profileId: child.id })}>
            Plan a school cost
          </Button>
        }
      >
        {costs.length === 0 ? (
          <p className="muted small">Camp, tours, uniform, stationery, photos, the concert costume: plan each for its month and save towards it, so it is already in the budget.</p>
        ) : (
          <ul className="item-list">
            {costs.map((p) => (
              <li key={p.id}>
                <div className="item-main">
                  <div>
                    <strong>{p.name}</strong> {rand(p.amount)}
                    {p.done && <Badge tone="success">Done</Badge>}
                  </div>
                  <div className="muted small">
                    {monthName(p.month)}
                    {p.saveFrom && ` · saving from ${monthName(p.saveFrom)}`}
                  </div>
                </div>
                <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${p.name}`} onClick={() => edit({ what: 'cost', profileId: child.id, planned: p })} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={
          <>
            <BookOpen size={18} aria-hidden /> Homework, projects and tests
          </>
        }
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'homework', profileId: child.id })}>
            Add
          </Button>
        }
      >
        {homework.filter((h) => !h.done).length === 0 && <p className="muted small">For when they are older: homework (reminded the day before), projects and tests (a week and a day before).</p>}
        <ul className="item-list">
          {homework
            .filter((h) => !h.done)
            .map((h) => (
              <li key={h.id}>
                <input type="checkbox" aria-label={`Done: ${h.what}`} checked={h.done} onChange={() => void homeworkDone.run(h)} />
                <div className="item-main">
                  <div>
                    {h.type !== 'homework' && <Badge tone={h.type === 'test' ? 'warning' : 'accent'}>{h.type === 'test' ? 'Test' : 'Project'}</Badge>} {h.subject && <strong>{h.subject}: </strong>}
                    {h.what}
                  </div>
                  <div className={`small ${h.due < t ? 'field-error' : 'muted'}`}>
                    {shortDate(h.due, t)} ({relative(t, h.due)}){h.notes && ` · ${h.notes}`}
                  </div>
                </div>
                <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${h.what}`} onClick={() => edit({ what: 'homework', profileId: child.id, homework: h })} />
              </li>
            ))}
        </ul>
        {homeworkDone.error && <Banner kind="error">{homeworkDone.error}</Banner>}
      </Card>

      <TimetableCard timetable={timetable} today={t} onEdit={() => edit({ what: 'timetable', profileId: child.id, timetable })} />

      <Card title="Documents">
        <p className="muted small">Reports, letters and forms, in {child.displayName}’s folder inside the School folder in Files (parents only).</p>
        <div className="row">
          <Button variant="secondary" icon={<FolderOpen size={16} aria-hidden />} busy={openFolder.busy} onClick={() => void openFolder.run()}>
            Open {child.displayName}’s folder
          </Button>
        </div>
        {openFolder.error && <Banner kind="error">{openFolder.error}</Banner>}
      </Card>
    </div>
  )
}

// ---- dialogs -----------------------------------------------------------------------------------

/** Saves an item for a child (or every child). */
async function saveItem(ctx: HubContext, plural: string, profileId: string | null, item: Record<string, unknown>, existing?: { id: string; version: number }) {
  const { api } = ctx.platform
  if (existing) return (await api.request<{ item: { id: string } }>('PUT', `/api/school/${plural}/${existing.id}`, { baseVersion: existing.version, item }).catch(conflict)).item
  return (await api.post<{ item: { id: string } }>(`/api/school/${plural}`, { profileId, item })).item
}

function useRemove(ctx: HubContext, plural: string, existing: { id: string } | undefined, question: string, onClose: (c?: boolean) => void, before?: () => Promise<void>) {
  return useAction(async () => {
    if (!existing || !window.confirm(question)) return
    await before?.()
    await ctx.platform.api.del(`/api/school/${plural}/${existing.id}`)
    onClose(true)
  })
}

function AddChildDialog({ profiles, onPick, onClose }: { profiles: Data['profiles']; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <Dialog open title="Add a child to School" onClose={onClose}>
      <div className="stack">
        {profiles.length === 0 ? (
          <p>Everyone in the family is already here. Add a person in Quick Info first.</p>
        ) : (
          <div className="row">
            {profiles.map((p) => (
              <Button key={p.id} variant="secondary" onClick={() => onPick(p.id)}>
                {p.displayName}
              </Button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  )
}

function YearDialog({ ctx, extras, profileId, year, onClose }: { ctx: HubContext; extras: Extras; profileId: string; year?: Year; onClose: (c?: boolean) => void }) {
  const [f, setF] = useState(() => ({
    year: String(year?.year ?? Number(extras.today.slice(0, 4))),
    school: year?.school ?? '',
    grade: year?.grade ?? '',
    feesBillId: year?.feesBillId ?? '',
    notes: year?.notes ?? '',
  }))
  const [terms, setTerms] = useState(year?.terms ?? [])
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    await saveItem(ctx, 'years', profileId, { ...f, year: Number(f.year), feesBillId: f.feesBillId || null, terms: terms.filter((x) => x.start && x.end) }, year)
    onClose(true)
  })
  const remove = useRemove(ctx, 'years', year, 'Delete this school year?', onClose)
  return (
    <Dialog open title={year ? 'Edit the school year' : 'A school year'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <div className="row">
          <Labelled id="yr-year" label="Year">
            <input id="yr-year" className="qi-search year-input" type="number" min={2000} max={2100} required value={f.year} onChange={(e) => set('year', e.target.value)} />
          </Labelled>
          <Labelled id="yr-grade" label="Grade or class">
            <input id="yr-grade" className="qi-search" maxLength={60} placeholder="e.g. Grade R, Butterflies" value={f.grade} onChange={(e) => set('grade', e.target.value)} />
          </Labelled>
        </div>
        <Labelled id="yr-school" label="School">
          <input id="yr-school" className="qi-search" maxLength={120} required value={f.school} onChange={(e) => set('school', e.target.value)} />
        </Labelled>
        <fieldset className="radio-group">
          <legend>Terms</legend>
          {terms.map((x, i) => (
            <div key={i} className="row">
              <input className="qi-search year-input" aria-label="Term name" value={x.name} onChange={(e) => setTerms(terms.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} />
              <input className="qi-search" type="date" aria-label={`${x.name} starts`} value={x.start} onChange={(e) => setTerms(terms.map((y, j) => (j === i ? { ...y, start: e.target.value } : y)))} />
              <input className="qi-search" type="date" aria-label={`${x.name} ends`} value={x.end} onChange={(e) => setTerms(terms.map((y, j) => (j === i ? { ...y, end: e.target.value } : y)))} />
              <Button type="button" variant="ghost" icon={<Trash2 size={14} aria-hidden />} aria-label={`Remove ${x.name}`} onClick={() => setTerms(terms.filter((_, j) => j !== i))} />
            </div>
          ))}
          {terms.length < 6 && (
            <button type="button" className="link small" onClick={() => setTerms([...terms, { name: `Term ${terms.length + 1}`, start: '', end: '' }])}>
              + Add a term
            </button>
          )}
        </fieldset>
        <Labelled id="yr-fees" label="Fees (a bill in Bills & budget)">
          <select id="yr-fees" className="select" value={f.feesBillId} onChange={(e) => set('feesBillId', e.target.value)}>
            <option value="">Not linked</option>
            {extras.bills.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} · {rand(b.amount)}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled id="yr-notes" label="Notes">
          <textarea id="yr-notes" className="textarea" rows={2} maxLength={2000} placeholder="e.g. Drop-off by 07:45, aftercare until 17:30" value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={year ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

function ContactDialog({ ctx, extras, profileId, contact, onClose }: { ctx: HubContext; extras: Extras; profileId: string; contact?: SchoolContact; onClose: (c?: boolean) => void }) {
  const [contactId, setContactId] = useState(contact?.contactId ?? '')
  const [role, setRole] = useState(contact?.role ?? 'teacher')
  const [note, setNote] = useState(contact?.note ?? '')
  const [everyone, setEveryone] = useState(contact ? contact.profileId === null : false)
  const save = useAction(async () => {
    if (!contactId) throw new Error('Choose the contact (add them in Contacts first).')
    // Who it is for cannot change on an existing link: remove it and add it again.
    await saveItem(ctx, 'contacts', everyone ? null : profileId, { contactId, role, note }, contact)
    onClose(true)
  })
  const remove = useRemove(ctx, 'contacts', contact, 'Remove this school contact? They stay in Contacts.', onClose)
  return (
    <Dialog open title={contact ? 'Edit the school contact' : 'Add a school contact'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="sc-contact" label="Who (from Contacts)">
          <select id="sc-contact" className="select" required value={contactId} onChange={(e) => setContactId(e.target.value)}>
            <option value="">Choose…</option>
            {extras.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled id="sc-role" label="Role">
          <select id="sc-role" className="select" value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled id="sc-note" label="Note">
          <input id="sc-note" className="qi-search" maxLength={200} placeholder="e.g. WhatsApp only; mornings before 08:00" value={note} onChange={(e) => setNote(e.target.value)} />
        </Labelled>
        {!contact && (
          <label className="check">
            <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
            <span>For all the children (e.g. the school office)</span>
          </label>
        )}
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={contact ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

/** The calendar's weekly events for an activity: one per session, from its first day to its last. */
async function syncActivityEvents(ctx: HubContext, child: { id: string; displayName: string }, a: { name: string; location: string; contactId: string | null; from: string; to: string; sessions: { day: string; start: string; end: string }[] }, existing: string[]): Promise<string[]> {
  const { api } = ctx.platform
  for (const id of existing) await api.del(`/api/calendar/events/${id}`).catch(() => undefined)
  const ids: string[] = []
  for (const x of a.sessions) {
    // The first such weekday on or after the first day.
    const want = WEEKDAYS.findIndex(([d]) => d === x.day)
    let day = a.from
    for (let i = 0; i < 7 && (new Date(`${day}T12:00:00`).getDay() + 6) % 7 !== want; i++) day = plusDays(day, 1)
    if (day > a.to) continue
    const r = await api.post<{ id: string }>('/api/calendar/events', {
      title: `${a.name} – ${child.displayName}`,
      start: `${day}T${x.start}`,
      end: `${day}T${x.end}`,
      tags: [child.id],
      location: a.location,
      notes: `${SCHOOL_NOTE}: extra-mural`,
      contactId: a.contactId,
      repeat: { freq: 'weekly', interval: 1, byDay: [x.day], until: a.to },
    })
    ids.push(r.id)
  }
  return ids
}

function ActivityDialog({ ctx, extras, child, activity, terms, onClose }: { ctx: HubContext; extras: Extras; child: Data['profiles'][number]; activity?: Activity; terms: Year['terms']; onClose: (c?: boolean) => void }) {
  const t = extras.today
  const current = terms.find((x) => x.end >= t) ?? terms[terms.length - 1]
  const [f, setF] = useState(() => ({
    name: activity?.name ?? '',
    who: activity?.who ?? '',
    contactId: activity?.contactId ?? '',
    location: activity?.location ?? '',
    from: activity?.from ?? current?.start ?? t,
    to: activity?.to ?? current?.end ?? plusDays(t, 90),
    term: activity?.term ?? current?.name ?? '',
    cancelContactId: activity?.cancelContactId ?? '',
    cancelPhone: activity?.cancelPhone ?? '',
    costPer: activity?.costPer ?? 'term',
    billId: activity?.billId ?? '',
    invoiceId: activity?.invoiceId ?? '',
    plannedId: activity?.plannedId ?? '',
    notes: activity?.notes ?? '',
  }))
  const [sessions, setSessions] = useState(activity?.sessions ?? [{ day: 'TU', start: '14:30', end: '15:30' }])
  const [cost, setCost] = useState(activity?.cost != null ? amountText(activity.cost) : '')
  const [onCalendar, setOnCalendar] = useState(activity ? activity.eventIds.length > 0 : true)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    const c = cost.trim() ? parseRand(cost) : null
    if (cost.trim() && c === null) throw new Error('Enter the cost, for example 950.00.')
    const base = { ...f, contactId: f.contactId || null, cancelContactId: f.cancelContactId || null, billId: f.billId || null, invoiceId: f.invoiceId || null, plannedId: f.plannedId || null, cost: c, sessions }
    const eventIds = onCalendar ? await syncActivityEvents(ctx, child, base, activity?.eventIds ?? []) : (await syncActivityEvents(ctx, child, { ...base, sessions: [] }, activity?.eventIds ?? []), [])
    await saveItem(ctx, 'activities', child.id, { ...base, eventIds }, activity)
    onClose(true)
  })
  const remove = useRemove(ctx, 'activities', activity, `Delete ${activity?.name}? Its calendar events go too.`, onClose, async () => {
    for (const id of activity?.eventIds ?? []) await ctx.platform.api.del(`/api/calendar/events/${id}`).catch(() => undefined)
  })
  return (
    <Dialog open title={activity ? `Edit ${activity.name}` : 'Add an extra-mural'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="act-name" label="Activity">
          <input id="act-name" className="qi-search" maxLength={80} required placeholder="e.g. Swimming, Ballet, Mini soccer" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Labelled>
        <div className="row">
          <Labelled id="act-who" label="Who runs it">
            <input id="act-who" className="qi-search" maxLength={120} placeholder="e.g. Aqua Kids" value={f.who} onChange={(e) => set('who', e.target.value)} />
          </Labelled>
          <Labelled id="act-contact" label="In Contacts">
            <select id="act-contact" className="select" value={f.contactId} onChange={(e) => set('contactId', e.target.value)}>
              <option value="">Not linked</option>
              {extras.contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Labelled>
        </div>
        <Labelled id="act-where" label="Where">
          <input id="act-where" className="qi-search" maxLength={200} placeholder="e.g. Sea Point pool; the school hall" value={f.location} onChange={(e) => set('location', e.target.value)} />
        </Labelled>
        <fieldset className="radio-group">
          <legend>When</legend>
          {sessions.map((x, i) => (
            <div key={i} className="row">
              <select className="select select-small" aria-label="Day" value={x.day} onChange={(e) => setSessions(sessions.map((y, j) => (j === i ? { ...y, day: e.target.value } : y)))}>
                {WEEKDAYS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <input className="qi-search year-input" type="time" aria-label="From" value={x.start} onChange={(e) => setSessions(sessions.map((y, j) => (j === i ? { ...y, start: e.target.value } : y)))} />
              <input className="qi-search year-input" type="time" aria-label="To" value={x.end} onChange={(e) => setSessions(sessions.map((y, j) => (j === i ? { ...y, end: e.target.value } : y)))} />
              {sessions.length > 1 && <Button type="button" variant="ghost" icon={<Trash2 size={14} aria-hidden />} aria-label="Remove this day" onClick={() => setSessions(sessions.filter((_, j) => j !== i))} />}
            </div>
          ))}
          {sessions.length < 7 && (
            <button type="button" className="link small" onClick={() => setSessions([...sessions, { day: 'TH', start: sessions[0]?.start ?? '14:30', end: sessions[0]?.end ?? '15:30' }])}>
              + Another day
            </button>
          )}
        </fieldset>
        <div className="row">
          {terms.length > 0 && (
            <Labelled id="act-term" label="Term">
              <select
                id="act-term"
                className="select"
                value={f.term}
                onChange={(e) => {
                  const x = terms.find((y) => y.name === e.target.value)
                  setF((v) => ({ ...v, term: e.target.value, ...(x ? { from: x.start, to: x.end } : {}) }))
                }}
              >
                <option value="">Dates of my own</option>
                {terms.map((x) => (
                  <option key={x.name} value={x.name}>
                    {x.name}
                  </option>
                ))}
              </select>
            </Labelled>
          )}
          <Labelled id="act-from" label="From">
            <input id="act-from" className="qi-search" type="date" required value={f.from} onChange={(e) => set('from', e.target.value)} />
          </Labelled>
          <Labelled id="act-to" label="To">
            <input id="act-to" className="qi-search" type="date" required value={f.to} onChange={(e) => set('to', e.target.value)} />
          </Labelled>
        </div>
        <label className="check">
          <input type="checkbox" checked={onCalendar} onChange={(e) => setOnCalendar(e.target.checked)} />
          <span>On the family calendar (weekly, for these dates)</span>
        </label>
        <div className="row">
          <Labelled id="act-cancel" label="To cancel or postpone, call">
            <select id="act-cancel" className="select" value={f.cancelContactId} onChange={(e) => set('cancelContactId', e.target.value)}>
              <option value="">Not in Contacts</option>
              {extras.contacts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled id="act-phone" label="or this number">
            <input id="act-phone" className="qi-search" inputMode="tel" maxLength={30} value={f.cancelPhone} onChange={(e) => set('cancelPhone', e.target.value)} />
          </Labelled>
        </div>
        <div className="row">
          <Labelled id="act-cost" label="Cost (R)">
            <input id="act-cost" className="qi-search" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} />
          </Labelled>
          <Labelled id="act-per" label="Per">
            <select id="act-per" className="select" value={f.costPer} onChange={(e) => set('costPer', e.target.value)}>
              {PER.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Labelled>
        </div>
        <fieldset className="radio-group">
          <legend>Paid through (Bills & budget)</legend>
          <div className="row">
            <select className="select" aria-label="Bill" value={f.billId} onChange={(e) => set('billId', e.target.value)}>
              <option value="">No bill</option>
              {extras.bills.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
            <select className="select" aria-label="Invoice" value={f.invoiceId} onChange={(e) => set('invoiceId', e.target.value)}>
              <option value="">No invoice</option>
              {extras.invoices.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.from}
                  {i.number ? ` ${i.number}` : ''} · {rand(i.amount)}
                </option>
              ))}
            </select>
            <select className="select" aria-label="Planned expense" value={f.plannedId} onChange={(e) => set('plannedId', e.target.value)}>
              <option value="">No planned expense</option>
              {extras.planned.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} · {p.month}
                </option>
              ))}
            </select>
          </div>
        </fieldset>
        <Labelled id="act-notes" label="Notes">
          <textarea id="act-notes" className="textarea" rows={2} maxLength={2000} placeholder="e.g. Bring a towel and goggles; no class on public holidays" value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={activity ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

function ReminderDialog({ ctx, extras, profileId, reminder, onClose }: { ctx: HubContext; extras: Extras; profileId: string; reminder?: Reminder; onClose: (c?: boolean) => void }) {
  const [f, setF] = useState(() => ({ what: reminder?.what ?? '', date: reminder?.date ?? plusDays(extras.today, 7), notes: reminder?.notes ?? '' }))
  const [leads, setLeads] = useState<number[]>(reminder?.leads ?? [1, 0])
  const [everyone, setEveryone] = useState(reminder ? reminder.profileId === null : false)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    await saveItem(ctx, 'reminders', everyone ? null : profileId, { ...f, leads, done: reminder?.done ?? false }, reminder)
    onClose(true)
  })
  const remove = useRemove(ctx, 'reminders', reminder, 'Delete this reminder?', onClose)
  const index = REMIND.findIndex(([, l]) => JSON.stringify(l) === JSON.stringify(leads))
  return (
    <Dialog open title={reminder ? 'Edit the reminder' : 'Add a school reminder'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="rem-what" label="What">
          <input id="rem-what" className="qi-search" maxLength={200} required placeholder="e.g. Costume for the concert; R20 for the cake sale" value={f.what} onChange={(e) => set('what', e.target.value)} />
        </Labelled>
        <div className="row">
          <Labelled id="rem-date" label="When it is needed">
            <input id="rem-date" className="qi-search" type="date" required value={f.date} onChange={(e) => set('date', e.target.value)} />
          </Labelled>
          <Labelled id="rem-when" label="Remind us">
            <select id="rem-when" className="select" value={index < 0 ? 1 : index} onChange={(e) => setLeads(REMIND[Number(e.target.value)]![1])}>
              {REMIND.map(([l], i) => (
                <option key={l} value={i}>
                  {l}
                </option>
              ))}
            </select>
          </Labelled>
        </div>
        <Labelled id="rem-notes" label="Notes">
          <input id="rem-notes" className="qi-search" maxLength={1000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        {!reminder && (
          <label className="check">
            <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} />
            <span>For all the children</span>
          </label>
        )}
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={reminder ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

/** Several dates from the school at once, onto the calendar for the child. */
function DatesDialog({ ctx, child, today, onClose }: { ctx: HubContext; child: Data['profiles'][number]; today: string; onClose: (c?: boolean) => void }) {
  const blank = () => ({ title: '', date: '', time: '', endDate: '' })
  const [rows, setRows] = useState([blank(), blank(), blank()])
  const save = useAction(async () => {
    const filled = rows.filter((r) => r.title.trim() && r.date)
    if (filled.length === 0) throw new Error('Add at least one date with what it is.')
    for (const r of filled) {
      const timed = /^\d{2}:\d{2}$/.test(r.time)
      const endTime = timed ? `${String(Math.min(23, Number(r.time.slice(0, 2)) + 1)).padStart(2, '0')}:${r.time.slice(3)}` : ''
      await ctx.platform.api.post('/api/calendar/events', {
        title: `${r.title.trim()} – ${child.displayName}`,
        allDay: !timed,
        start: timed ? `${r.date}T${r.time}` : r.date,
        end: timed ? `${r.date}T${endTime}` : r.endDate && r.endDate > r.date ? r.endDate : r.date,
        tags: [child.id],
        notes: SCHOOL_NOTE,
        reminders: timed ? [1440] : [],
      })
    }
    onClose(true)
  })
  return (
    <Dialog open title={`Dates from school · ${child.displayName}`} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <p className="muted small">As the school sends them. Each goes on the family calendar, tagged to {child.displayName}. A time is optional (all day without one); a last day only for something that runs over several days (e.g. a holiday club).</p>
        {rows.map((r, i) => (
          <div key={i} className="row school-date-row">
            <input className="qi-search" aria-label={`What (${i + 1})`} placeholder="e.g. Sports day" maxLength={150} value={r.title} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
            <input className="qi-search" type="date" aria-label={`Date (${i + 1})`} min={today} value={r.date} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))} />
            <input className="qi-search year-input" type="time" aria-label={`Time (${i + 1})`} value={r.time} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))} />
            <input className="qi-search" type="date" aria-label={`Last day (${i + 1})`} value={r.endDate} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, endDate: e.target.value } : x)))} />
          </div>
        ))}
        <button type="button" className="link small" onClick={() => setRows([...rows, blank()])}>
          + Another date
        </button>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} submit="Add to the calendar" />
      </form>
    </Dialog>
  )
}

// ---- 7b: plan the year, what to bring, forms, lists ---------------------------------------------

function PlanTheYear({ checks, year }: { checks: { done: boolean; text: string; action: () => void }[]; year: number }) {
  const left = checks.filter((c) => !c.done).length
  const [open, setOpen] = useState(left > 0)
  return (
    <Card title={`Plan ${year}`} actions={<span className="muted small">{left === 0 ? 'All done' : `${checks.length - left} of ${checks.length} done`}</span>}>
      <button className="link small" onClick={() => setOpen(!open)}>
        {open ? 'Hide the checklist' : 'Show the checklist'}
      </button>
      {open && (
        <ul className="item-list">
          {checks.map((c) => (
            <li key={c.text}>
              {c.done ? <CheckCircle2 size={18} aria-label="Done" className="school-done" /> : <Circle size={18} aria-label="Still to do" />}
              <div className="item-main">{c.text}</div>
              {!c.done && (
                <Button variant="ghost" onClick={c.action}>
                  Do it
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

const DAY_INDEX: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 }

/** What to bring on which day, with tomorrow's (or Monday's, at the weekend) first. */
function WhatToBring({ lists, today, onEdit, onAdd }: { lists: SList[]; today: string; onEdit: (l: SList) => void; onAdd: () => void }) {
  const items = lists.flatMap((l) => l.items.map((x) => ({ ...x, list: l })))
  const d = new Date(`${today}T12:00:00`)
  let next = (d.getDay() + 1) % 7
  if (next === 6 || next === 0) next = 1
  const nextCode = Object.keys(DAY_INDEX).find((k) => DAY_INDEX[k] === next)!
  const label = next === (d.getDay() + 1) % 7 ? 'Tomorrow' : 'Monday'
  const days = WEEKDAYS.filter(([code]) => items.some((x) => x.day === code))
  return (
    <Card
      title={
        <>
          <Backpack size={18} aria-hidden /> What to bring
        </>
      }
      actions={
        lists[0] ? (
          <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label="Edit what to bring" onClick={() => onEdit(lists[0]!)} />
        ) : (
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={onAdd}>
            Set it up
          </Button>
        )
      }
    >
      {items.length === 0 ? (
        <p className="muted small">The swimming bag on Tuesdays, the library book on Fridays: set the week up once.</p>
      ) : (
        <>
          <p className="school-tomorrow">
            <strong>{label}:</strong>{' '}
            {items
              .filter((x) => x.day === nextCode)
              .map((x) => x.text)
              .join(', ') || 'nothing extra'}
          </p>
          <ul className="item-list small">
            {days.map(([code, name]) => (
              <li key={code}>
                <div className="item-main">
                  <strong>{name}</strong>{' '}
                  {items
                    .filter((x) => x.day === code)
                    .map((x) => x.text)
                    .join(', ')}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}

function FormDialog({ ctx, extras, profileId, form, onClose }: { ctx: HubContext; extras: Extras; profileId: string; form?: Form; onClose: (c?: boolean) => void }) {
  const [f, setF] = useState(() => ({ what: form?.what ?? '', needs: form?.needs ?? 'sign', due: form?.due ?? plusDays(extras.today, 5), notes: form?.notes ?? '', done: form?.done ?? false }))
  const [amount, setAmount] = useState(form?.amount != null ? amountText(form.amount) : '')
  const [documents, setDocuments] = useState(form?.documents ?? [])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    const c = amount.trim() ? parseRand(amount) : null
    if (amount.trim() && c === null) throw new Error('Enter the amount, for example 150.00.')
    await saveItem(ctx, 'forms', profileId, { ...f, amount: c, documents, doneOn: f.done ? (form?.doneOn ?? extras.today) : null }, form)
    onClose(true)
  })
  const remove = useRemove(ctx, 'forms', form, 'Delete this form? Its documents stay in the School folder.', onClose)
  return (
    <Dialog open title={form ? 'Edit the form' : 'Add a form or permission slip'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="form-what" label="What it is">
          <input id="form-what" className="qi-search" maxLength={200} required placeholder="e.g. Zoo outing, Swimming indemnity" value={f.what} onChange={(e) => set('what', e.target.value)} />
        </Labelled>
        <div className="row">
          <Labelled id="form-needs" label="It needs">
            <select id="form-needs" className="select" value={f.needs} onChange={(e) => set('needs', e.target.value as Form['needs'])}>
              <option value="sign">Signing</option>
              <option value="pay">Paying</option>
              <option value="sign and pay">Signing and paying</option>
              <option value="return">Filling in and returning</option>
            </select>
          </Labelled>
          <Labelled id="form-amount" label="Amount (R)">
            <input id="form-amount" className="qi-search" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Labelled>
        </div>
        <Labelled id="form-due" label="Back by">
          <input id="form-due" className="qi-search" type="date" required value={f.due} onChange={(e) => set('due', e.target.value)} />
        </Labelled>
        <Labelled id="form-notes" label="Notes">
          <input id="form-notes" className="qi-search" maxLength={1000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        <AttachDocuments ctx={ctx} documents={documents} onChange={setDocuments} folder={{ path: `/api/school/folder/${profileId}`, name: 'School' }} />
        {form && (
          <label className="check">
            <input type="checkbox" checked={f.done} onChange={(e) => set('done', e.target.checked)} />
            <span>Done</span>
          </label>
        )}
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={form ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

const LIST_TYPES: [SList['type'], string][] = [
  ['stationery', 'Stationery'],
  ['uniform', 'Uniform'],
  ['kit', 'Sports or other kit'],
  ['bring', 'What to bring (by day)'],
]

function ListDialog({ ctx, extras, profileId, list, type, onClose }: { ctx: HubContext; extras: Extras; profileId: string; list?: SList; type?: SList['type']; onClose: (c?: boolean) => void }) {
  const kind = list?.type ?? type ?? 'stationery'
  const [f, setF] = useState(() => ({ type: kind, name: list?.name ?? (kind === 'bring' ? 'What to bring' : LIST_TYPES.find(([v]) => v === kind)![1]), year: String(list?.year ?? Number(extras.today.slice(0, 4))), notes: list?.notes ?? '' }))
  const [items, setItems] = useState<SList['items']>(list?.items ?? [{ text: '', qty: '', done: false, day: kind === 'bring' ? 'MO' : null }])
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const bring = f.type === 'bring'
  const save = useAction(async () => {
    const clean = items.filter((x) => x.text.trim()).map((x) => ({ ...x, day: bring ? (x.day ?? 'MO') : null }))
    await saveItem(ctx, 'lists', profileId, { ...f, year: Number(f.year), items: clean }, list)
    onClose(true)
  })
  const remove = useRemove(ctx, 'lists', list, `Delete ${list?.name}?`, onClose)
  return (
    <Dialog open title={list ? `Edit ${list.name}` : 'Add a list'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <div className="row">
          <Labelled id="list-type" label="Kind">
            <select id="list-type" className="select" value={f.type} onChange={(e) => set('type', e.target.value)}>
              {LIST_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled id="list-year" label="Year">
            <input id="list-year" className="qi-search year-input" type="number" min={2000} max={2100} value={f.year} onChange={(e) => set('year', e.target.value)} />
          </Labelled>
        </div>
        <Labelled id="list-name" label="Name">
          <input id="list-name" className="qi-search" maxLength={80} required value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Labelled>
        <fieldset className="radio-group">
          <legend>{bring ? 'What, on which day' : 'Items'}</legend>
          {items.map((x, i) => (
            <div key={i} className="row">
              {bring && (
                <select className="select select-small" aria-label={`Day for item ${i + 1}`} value={x.day ?? 'MO'} onChange={(e) => setItems(items.map((y, j) => (j === i ? { ...y, day: e.target.value } : y)))}>
                  {WEEKDAYS.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              )}
              <input className="qi-search" aria-label={`Item ${i + 1}`} maxLength={200} placeholder={bring ? 'e.g. Swimming bag' : 'e.g. HB pencils'} value={x.text} onChange={(e) => setItems(items.map((y, j) => (j === i ? { ...y, text: e.target.value } : y)))} />
              {!bring && <input className="qi-search year-input" aria-label={`How many of item ${i + 1}`} maxLength={30} placeholder="How many" value={x.qty} onChange={(e) => setItems(items.map((y, j) => (j === i ? { ...y, qty: e.target.value } : y)))} />}
              <Button type="button" variant="ghost" icon={<Trash2 size={14} aria-hidden />} aria-label={`Remove item ${i + 1}`} onClick={() => setItems(items.filter((_, j) => j !== i))} />
            </div>
          ))}
          <button type="button" className="link small" onClick={() => setItems([...items, { text: '', qty: '', done: false, day: bring ? (items[items.length - 1]?.day ?? 'MO') : null }])}>
            + Another
          </button>
        </fieldset>
        <Labelled id="list-notes" label="Notes">
          <input id="list-notes" className="qi-search" maxLength={1000} placeholder="e.g. Label everything with the child's name" value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={list ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

/** A list again, for next year or another child, with nothing ticked. */
function CopyListDialog({ ctx, data, list, year, onClose }: { ctx: HubContext; data: Data; list: SList; year: number; onClose: (c?: boolean) => void }) {
  const [to, setTo] = useState(list.profileId ?? data.profiles[0]?.id ?? '')
  const [toYear, setToYear] = useState(String(Math.max(year, list.year + 1)))
  const save = useAction(async () => {
    await saveItem(ctx, 'lists', to, { type: list.type, name: list.name, year: Number(toYear), notes: list.notes, items: list.items.map((x) => ({ ...x, done: false })) })
    onClose(true)
  })
  return (
    <Dialog open title={`Copy ${list.name}`} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <div className="row">
          <Labelled id="copy-to" label="For">
            <select id="copy-to" className="select" value={to} onChange={(e) => setTo(e.target.value)}>
              {data.profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled id="copy-year" label="Year">
            <input id="copy-year" className="qi-search year-input" type="number" min={2000} max={2100} value={toYear} onChange={(e) => setToYear(e.target.value)} />
          </Labelled>
        </div>
        <p className="muted small">The copy starts with nothing ticked.</p>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} submit="Copy" />
      </form>
    </Dialog>
  )
}

// ---- 7c: timetable and homework ---------------------------------------------------------------

function TimetableCard({ timetable, today, onEdit }: { timetable?: Timetable; today: string; onEdit: () => void }) {
  const day = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'][new Date(`${today}T12:00:00`).getDay()]
  const days = WEEKDAYS.filter(([code]) => timetable?.lessons.some((l) => l.day === code))
  return (
    <Card
      title={
        <>
          <Clock size={18} aria-hidden /> Timetable{timetable ? ` ${timetable.year}` : ''}
        </>
      }
      actions={
        <Button variant="ghost" icon={timetable ? <Pencil size={16} aria-hidden /> : <Plus size={16} aria-hidden />} aria-label={timetable ? 'Edit the timetable' : undefined} onClick={onEdit}>
          {timetable ? '' : 'Add the timetable'}
        </Button>
      }
    >
      {!timetable || timetable.lessons.length === 0 ? (
        <p className="muted small">For when they are older: the week’s lessons, with today’s first.</p>
      ) : (
        <div className="timetable">
          {days.map(([code, name]) => (
            <div key={code} className={`timetable-day ${code === day ? 'timetable-today' : ''}`}>
              <strong>{code === day ? `Today (${name})` : name}</strong>
              <ul>
                {timetable.lessons
                  .filter((l) => l.day === code)
                  .map((l, i) => (
                    <li key={i}>
                      <span className="muted">{l.start}</span> {l.subject}
                      {l.note && <span className="muted"> · {l.note}</span>}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

function TimetableDialog({ ctx, extras, profileId, timetable, onClose }: { ctx: HubContext; extras: Extras; profileId: string; timetable?: Timetable; onClose: (c?: boolean) => void }) {
  const [year, setYear] = useState(String(timetable?.year ?? Number(extras.today.slice(0, 4))))
  const [lessons, setLessons] = useState<Timetable['lessons']>(timetable?.lessons ?? [{ day: 'MO', start: '08:00', end: '08:45', subject: '', note: '' }])
  const set = (i: number, change: Partial<Timetable['lessons'][number]>) => setLessons(lessons.map((l, j) => (j === i ? { ...l, ...change } : l)))
  const save = useAction(async () => {
    await saveItem(ctx, 'timetables', profileId, { year: Number(year), lessons: lessons.filter((l) => l.subject.trim()) }, timetable)
    onClose(true)
  })
  const remove = useRemove(ctx, 'timetables', timetable, 'Delete the timetable?', onClose)
  return (
    <Dialog open title="Timetable" onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="tt-year" label="Year">
          <input id="tt-year" className="qi-search year-input" type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(e.target.value)} />
        </Labelled>
        <fieldset className="radio-group">
          <legend>Lessons</legend>
          {lessons.map((l, i) => (
            <div key={i} className="row">
              <select className="select select-small" aria-label={`Day of lesson ${i + 1}`} value={l.day} onChange={(e) => set(i, { day: e.target.value })}>
                {WEEKDAYS.slice(0, 5).map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </select>
              <input className="qi-search year-input" type="time" aria-label={`Start of lesson ${i + 1}`} value={l.start} onChange={(e) => set(i, { start: e.target.value })} />
              <input className="qi-search year-input" type="time" aria-label={`End of lesson ${i + 1}`} value={l.end} onChange={(e) => set(i, { end: e.target.value })} />
              <input className="qi-search" aria-label={`Subject of lesson ${i + 1}`} maxLength={60} placeholder="Subject" value={l.subject} onChange={(e) => set(i, { subject: e.target.value })} />
              <Button type="button" variant="ghost" icon={<Trash2 size={14} aria-hidden />} aria-label={`Remove lesson ${i + 1}`} onClick={() => setLessons(lessons.filter((_, j) => j !== i))} />
            </div>
          ))}
          <button
            type="button"
            className="link small"
            onClick={() => {
              const last = lessons[lessons.length - 1]
              setLessons([...lessons, { day: last?.day ?? 'MO', start: last?.end ?? '08:00', end: last?.end ?? '08:45', subject: '', note: '' }])
            }}
          >
            + Another lesson
          </button>
        </fieldset>
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={timetable ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

function HomeworkDialog({ ctx, extras, profileId, homework, onClose }: { ctx: HubContext; extras: Extras; profileId: string; homework?: Homework; onClose: (c?: boolean) => void }) {
  const [f, setF] = useState(() => ({ type: homework?.type ?? 'homework', subject: homework?.subject ?? '', what: homework?.what ?? '', due: homework?.due ?? plusDays(extras.today, 1), notes: homework?.notes ?? '', done: homework?.done ?? false }))
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    await saveItem(ctx, 'homework', profileId, f, homework)
    onClose(true)
  })
  const remove = useRemove(ctx, 'homework', homework, 'Delete this?', onClose)
  return (
    <Dialog open title={homework ? 'Edit' : 'Add homework, a project or a test'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <div className="row">
          <Labelled id="hw-type" label="Kind">
            <select id="hw-type" className="select" value={f.type} onChange={(e) => set('type', e.target.value as Homework['type'])}>
              <option value="homework">Homework</option>
              <option value="project">Project</option>
              <option value="test">Test</option>
            </select>
          </Labelled>
          <Labelled id="hw-subject" label="Subject">
            <input id="hw-subject" className="qi-search" maxLength={60} value={f.subject} onChange={(e) => set('subject', e.target.value)} />
          </Labelled>
        </div>
        <Labelled id="hw-what" label="What">
          <input id="hw-what" className="qi-search" maxLength={300} required placeholder="e.g. Times tables 1–5; Volcano model" value={f.what} onChange={(e) => set('what', e.target.value)} />
        </Labelled>
        <Labelled id="hw-due" label={f.type === 'test' ? 'On' : 'Due'}>
          <input id="hw-due" className="qi-search" type="date" required value={f.due} onChange={(e) => set('due', e.target.value)} />
        </Labelled>
        <Labelled id="hw-notes" label="Notes">
          <input id="hw-notes" className="qi-search" maxLength={1000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        {homework && (
          <label className="check">
            <input type="checkbox" checked={f.done} onChange={(e) => set('done', e.target.checked)} />
            <span>Done</span>
          </label>
        )}
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={homework ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}
