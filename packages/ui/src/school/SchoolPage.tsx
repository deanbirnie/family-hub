/**
 * School (phase 7a), for parents: a page per child that brings the school
 * together, keeping things in their proper place: dates on the calendar,
 * fees in Bills, costs as planned expenses, documents in the School folder,
 * people in Contacts. Kept here: the school and class each year with its
 * terms, the school's contacts and their roles, extra-murals by term, and
 * reminders for the irregular things.
 */
import { Bell, CalendarPlus, FolderOpen, GraduationCap, Pencil, Phone, Plus, Trash2, Trophy, Users } from 'lucide-react'
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
type Item = Year | SchoolContact | Activity | Reminder

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
