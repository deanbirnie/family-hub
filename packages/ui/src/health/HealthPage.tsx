/**
 * Health (phase 5): each person's record, for parents only, end-to-end
 * encrypted with the family key. Everything is decrypted on this device; the
 * server only ever has ciphertext (docs/DATA-PROTECTION.md, "Health").
 */
import { AlertTriangle, FileText, HeartPulse, Paperclip, Pencil, Phone, Pill, Plus, Search, Stethoscope, Syringe, Trash2, Upload } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api.ts'
import { navigate } from '../router.ts'
import type { Contact } from '../pages/Contacts.tsx'
import { decryptRecord, type StoredRecord } from '../quickinfo/model.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, Field, PageHeader, Spinner, errorText, useAction } from '../ui.tsx'
import { vault } from '../vault/store.ts'
import { useVaultUnlocked, VaultCard } from '../vault/VaultCard.tsx'
import {
  decryptHealth,
  encryptHealth,
  HISTORY_TYPES,
  isCurrentMedicine,
  KINDS,
  optionLabel,
  PROVIDER_ROLES,
  SEVERITIES,
  severityRank,
  type FieldDef,
  type HealthContent,
  type HealthKind,
  type LinkedDocument,
  type StoredHealthRecord,
} from './model.ts'
import { AttachDocuments, Documents, FieldInput } from './parts.tsx'
import { EpisodesCard, EpisodeView } from './Episodes.tsx'
import { Appointments, Checkups, ComingUpHealth, Growth, syncAppointmentEvent, Vaccinations, type Opener } from './Extras.tsx'
import { syncHealthReminders } from './reminders.ts'
import { emergencyCard, type EmergencyCard, type ReportInput } from './reports.ts'
import { EmergencyCardView } from './EmergencyCard.tsx'
import { VisitSummaryDialog } from './ReportDialogs.tsx'

interface Person {
  id: string
  displayName: string
  userId: string | null
}

type Rec = StoredHealthRecord & { content: HealthContent }

interface Loaded {
  people: Person[]
  records: Rec[]
  contacts: Contact[]
  /** Medical aid from Quick Info, per person. */
  medical: Record<string, Record<string, string>>
  /** Date of birth from Quick Info, per person. */
  births: Record<string, string>
  /** Personal details from Quick Info (full name, ID number), per person. */
  personal: Record<string, Record<string, string>>
  /** Emergency contacts from Quick Info, per person. */
  emergency: Record<string, { primary: string | null; backup: string | null }>
}

/** What a report or the emergency card is made from, for one person. */
export function reportInput(ctx: HubContext, data: Loaded, person: Person): ReportInput {
  const records = data.records.filter((r) => r.profileId === person.id)
  const personal = data.personal[person.id] ?? {}
  return {
    person: {
      displayName: person.displayName,
      fullName: personal.fullName,
      idNumber: personal.idNumber,
      birthDate: data.births[person.id] || records.find((r) => r.content.kind === 'basics')?.content.fields.birthDate,
      medical: data.medical[person.id],
      emergency: data.emergency[person.id],
    },
    records,
    contacts: data.contacts,
    preparedBy: ctx.user.displayName,
    now: Date.now(),
  }
}

export function HealthPage({ ctx, episodeId = null }: { ctx: HubContext; episodeId?: string | null }) {
  const unlocked = useVaultUnlocked()
  if (ctx.user.role !== 'admin') {
    return (
      <div className="page">
        <PageHeader title="Health" />
        <Card>
          <p>Health records are kept by the parents.</p>
        </Card>
      </div>
    )
  }
  return (
    <div className="page">
      <PageHeader title="Health" subtitle="Allergies, medicines, conditions, doctors and history for each of the family: end-to-end encrypted, for parents only." />
      {unlocked ? <HealthBody ctx={ctx} episodeId={episodeId} /> : <VaultCard ctx={ctx} />}
    </div>
  )
}

function HealthBody({ ctx, episodeId }: { ctx: HubContext; episodeId: string | null }) {
  const { api } = ctx.platform
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [personId, setPersonId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError('')
    try {
      const [raw, book, qi] = await Promise.all([
        api.get<{ profiles: Person[]; records: StoredHealthRecord[] }>('/api/health/records'),
        api.get<{ contacts: Contact[] }>('/api/contacts'),
        api.get<{ profiles: { id: string; emergency: { primary: string | null; backup: string | null } }[]; records: StoredRecord[] }>('/api/quick-info'),
      ])
      const key = vault.use()
      if (!key) return
      const records: Rec[] = []
      for (const r of raw.records) {
        try {
          records.push({ ...r, content: await decryptHealth(key, r) })
        } catch {
          // A record that cannot be opened with this family key is skipped (it shows nowhere).
        }
      }
      const medical: Loaded['medical'] = {}
      const births: Loaded['births'] = {}
      const personal: Loaded['personal'] = {}
      const emergency: Loaded['emergency'] = Object.fromEntries(qi.profiles.map((p) => [p.id, p.emergency]))
      for (const r of qi.records.filter((x) => (x.kind === 'medical' || x.kind === 'personal') && x.profileId)) {
        try {
          const fields = (await decryptRecord(key, r)).fields
          if (r.kind === 'medical') medical[r.profileId!] = fields
          else {
            personal[r.profileId!] = fields
            if (fields.dateOfBirth) births[r.profileId!] = fields.dateOfBirth
          }
        } catch {
          // ignore
        }
      }
      const loaded: Loaded = { people: raw.profiles, records, contacts: book.contacts, medical, births, personal, emergency }
      setData(loaded)
      // On the phone, bring the offline emergency card up to date (no fingerprint needed to update it).
      if (ctx.platform.emergencyCard) void ctx.platform.emergencyCard.save(raw.profiles.map((p) => emergencyCard(reportInput(ctx, loaded, p)))).catch(() => undefined)
      // Keep the server's health reminders in step (it learns only person, date and how far ahead).
      void syncHealthReminders(
        api,
        raw.profiles.map((p) => ({
          id: p.id,
          records: records.filter((r) => r.profileId === p.id),
          birthDate: births[p.id] || records.find((r) => r.profileId === p.id && r.content.kind === 'basics')?.content.fields.birthDate,
        })),
      ).catch(() => undefined)
      setPersonId((p) => p ?? raw.profiles.find((x) => x.userId === ctx.user.id)?.id ?? raw.profiles[0]?.id ?? null)
    } catch (e) {
      setError(errorText(e))
    }
  }, [api, ctx.user.id, ctx.user.displayName, ctx.platform.emergencyCard]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <Banner kind="error">{error}</Banner>
  if (!data) return <Spinner />
  if (data.people.length === 0) return <Banner kind="info">Add the family’s people in Quick Info first (Add a person); each then has a health record here.</Banner>
  // An episode opened by its link (from the home page, or a notification) belongs to its person.
  const episode = episodeId ? data.records.find((r) => r.id === episodeId) : undefined
  const person = data.people.find((p) => p.id === (episode?.profileId ?? personId)) ?? data.people[0]!

  if (episodeId) {
    return (
      <EpisodeView
        ctx={ctx}
        person={person}
        records={data.records.filter((r) => r.profileId === person.id)}
        contacts={data.contacts}
        episodeId={episodeId}
        reportInput={reportInput(ctx, data, person)}
        reload={load}
        onBack={() => {
          setPersonId(person.id)
          navigate('/health')
        }}
      />
    )
  }

  return (
    <>
      <div className="row chips" role="group" aria-label="Whose health record">
        {data.people.map((p) => (
          <button key={p.id} className={`chip ${p.id === person.id ? 'chip-on' : ''}`} aria-pressed={p.id === person.id} onClick={() => setPersonId(p.id)}>
            {p.displayName}
          </button>
        ))}
      </div>
      <PersonHealth ctx={ctx} data={data} person={person} reload={load} />
    </>
  )
}

const contactName = (contacts: Contact[], id: string | undefined) => (id ? (contacts.find((c) => c.id === id)?.name ?? 'Removed contact') : '')

function PersonHealth({ ctx, data, person, reload }: { ctx: HubContext; data: Loaded; person: Person; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<{ kind: HealthKind; record?: Rec; initial?: Record<string, string> } | null>(null)
  const opener: Opener = { open: (kind, record, initial) => setEditing({ kind, record: record as Rec | undefined, initial }) }
  const mine = data.records.filter((r) => r.profileId === person.id)
  const of = (kind: HealthKind) => mine.filter((r) => r.content.kind === kind)
  const allergies = of('allergy').sort((a, b) => severityRank(a.content.fields.severity ?? '') - severityRank(b.content.fields.severity ?? ''))
  const severe = allergies.filter((a) => severityRank(a.content.fields.severity ?? '') <= 1)
  const basics = of('basics')[0]
  const medical = data.medical[person.id]
  const birthDate = data.births[person.id] || basics?.content.fields.birthDate
  const add = (kind: HealthKind) => setEditing({ kind })
  const edit = (record: Rec) => setEditing({ kind: record.content.kind, record })

  return (
    <div className="stack">
      {person.userId === ctx.user.id && <Banner kind="info">This is your own health record. Everything here is visible to the other parent too.</Banner>}
      {severe.length > 0 && (
        <Banner kind="error">
          <strong>Severe allergies:</strong> {severe.map((a) => `${a.content.fields.substance}${a.content.fields.epipen === 'yes' ? ' (carries an EpiPen)' : ''}`).join('; ')}
        </Banner>
      )}
      <ReportsBar ctx={ctx} input={reportInput(ctx, data, person)} />
      <EpisodesCard ctx={ctx} person={person} records={mine} onOpen={(id) => navigate(`/health/episodes/${encodeURIComponent(id)}`)} onChanged={() => void reload()} />
      <ComingUpHealth records={mine} birthDate={birthDate} />

      <div className="grid-2">
        <Section title="Allergies" icon={<AlertTriangle size={18} aria-hidden />} onAdd={() => add('allergy')} addLabel="Add an allergy" empty="No allergies recorded.">
          {allergies.map((r) => (
            <Row key={r.id} onEdit={() => edit(r)} title={r.content.fields.substance ?? ''} label={`Edit allergy ${r.content.fields.substance}`}>
              {r.content.fields.severity && <Badge tone={severityRank(r.content.fields.severity) <= 1 ? 'warning' : 'neutral'}>{optionLabel(SEVERITIES, r.content.fields.severity)}</Badge>}
              {r.content.fields.reaction && <span className="muted small"> {r.content.fields.reaction}</span>}
            </Row>
          ))}
        </Section>
        <Section title="Conditions" icon={<HeartPulse size={18} aria-hidden />} onAdd={() => add('condition')} addLabel="Add a condition" empty="No conditions recorded.">
          {of('condition').map((r) => (
            <Row key={r.id} onEdit={() => edit(r)} title={r.content.fields.name ?? ''} label={`Edit condition ${r.content.fields.name}`}>
              {r.content.fields.status === 'resolved' ? <Badge>Resolved</Badge> : <Badge tone="accent">Ongoing</Badge>}
              {r.content.fields.since && <span className="muted small"> since {r.content.fields.since}</span>}
            </Row>
          ))}
        </Section>
      </div>

      <div className="grid-2">
        <Card
          title="Blood type and care notes"
          actions={
            <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label="Edit blood type and care notes" onClick={() => (basics ? edit(basics) : add('basics'))} />
          }
        >
          <p>
            Blood type: <strong>{basics?.content.fields.bloodType || 'not known'}</strong>
          </p>
          {basics?.content.fields.careNotes ? <p className="pre-wrap">{basics.content.fields.careNotes}</p> : <p className="muted small">No care notes.</p>}
        </Card>
        <Card title="Medical aid">
          {medical?.scheme ? (
            <>
              <p>
                <strong>{medical.scheme}</strong>
                {medical.plan && ` · ${medical.plan}`}
              </p>
              <p className="muted small">
                {medical.dependantCode && `Dependant code ${medical.dependantCode}. `}Membership number and scheme contact are in Quick Info.
              </p>
            </>
          ) : (
            <p className="muted small">Not recorded. Add it in Quick Info (Medical aid).</p>
          )}
        </Card>
      </div>

      <Section title="Doctors and providers" icon={<Stethoscope size={18} aria-hidden />} onAdd={() => add('provider')} addLabel="Add a doctor or provider" empty="No doctors linked yet. Add them to Contacts first.">
        {of('provider')
          .sort((a, b) => Number(b.content.fields.main === 'yes') - Number(a.content.fields.main === 'yes'))
          .map((r) => {
            const c = data.contacts.find((x) => x.id === r.content.fields.contactId)
            return (
              <Row key={r.id} onEdit={() => edit(r)} title={c?.name ?? 'Removed contact'} label={`Edit provider ${c?.name ?? ''}`}>
                <span className="muted small">
                  {optionLabel(PROVIDER_ROLES, r.content.fields.role ?? '')}
                  {r.content.fields.speciality && ` · ${r.content.fields.speciality}`}
                </span>
                {r.content.fields.main === 'yes' && <Badge tone="accent">Main GP</Badge>}
                {c?.phones[0] && (
                  <a className="btn btn-ghost" href={`tel:${c.phones[0].number.replace(/[^0-9+]/g, '')}`} aria-label={`Call ${c.name}`}>
                    <Phone size={16} aria-hidden />
                    <span>{c.phones[0].number}</span>
                  </a>
                )}
              </Row>
            )
          })}
      </Section>

      <Medicines records={of('medicine')} contacts={data.contacts} onAdd={() => add('medicine')} onEdit={edit} />
      <Appointments ctx={ctx} person={person} records={mine} contacts={data.contacts} opener={opener} onChanged={() => void reload()} />
      <Vaccinations records={mine} birthDate={birthDate} opener={opener} />
      <Growth records={mine} opener={opener} />
      <Checkups records={mine} contacts={data.contacts} opener={opener} />
      <History ctx={ctx} records={of('history')} contacts={data.contacts} onAdd={() => add('history')} onEdit={edit} />

      {editing && (
        <RecordDialog
          ctx={ctx}
          kind={editing.kind}
          person={person}
          record={editing.record}
          initial={editing.initial}
          contacts={data.contacts}
          onClose={(changed) => {
            setEditing(null)
            if (changed) void reload()
          }}
        />
      )}
    </div>
  )
}

/** The visit summary, and on the phone the offline emergency card. */
function ReportsBar({ ctx, input }: { ctx: HubContext; input: ReportInput }) {
  const [visit, setVisit] = useState(false)
  const [cards, setCards] = useState<EmergencyCard[] | null>(null)
  const store = ctx.platform.emergencyCard
  const open = useAction(async () => {
    if (!store) return
    const opened = await store.open().catch((e: { code?: string }) => {
      if (e?.code === 'CANCELLED') return undefined
      throw e
    })
    if (opened === null) throw new Error('The emergency card is still being made. Try again in a moment.')
    if (opened) setCards(opened)
  })
  return (
    <div className="row">
      <Button variant="secondary" icon={<FileText size={16} aria-hidden />} onClick={() => setVisit(true)}>
        Visit summary (PDF)
      </Button>
      {store && (
        <Button variant="secondary" icon={<HeartPulse size={16} aria-hidden />} busy={open.busy} onClick={() => void open.run()}>
          Emergency card
        </Button>
      )}
      {open.error && <Banner kind="error">{open.error}</Banner>}
      {visit && <VisitSummaryDialog ctx={ctx} input={input} onClose={() => setVisit(false)} />}
      {cards && <EmergencyCardView cards={cards} onClose={() => setCards(null)} />}
    </div>
  )
}

function Section({ title, icon, onAdd, addLabel, empty, children }: { title: string; icon: React.ReactNode; onAdd: () => void; addLabel: string; empty: string; children: React.ReactNode[] | React.ReactNode }) {
  const list = Array.isArray(children) ? children : [children]
  return (
    <Card
      title={
        <>
          {icon} {title}
        </>
      }
      actions={<Button variant="ghost" icon={<Plus size={16} aria-hidden />} aria-label={addLabel} onClick={onAdd} />}
    >
      {list.length === 0 || list.every((c) => !c) ? <p className="muted small">{empty}</p> : <ul className="item-list">{children}</ul>}
    </Card>
  )
}

function Row({ title, label, onEdit, children }: { title: string; label: string; onEdit: () => void; children?: React.ReactNode }) {
  return (
    <li>
      <div className="item-main">
        <div>
          <strong>{title}</strong>
        </div>
        <div className="row">{children}</div>
      </div>
      <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={label} onClick={onEdit} />
    </li>
  )
}

function Medicines({ records, contacts, onAdd, onEdit }: { records: Rec[]; contacts: Contact[]; onAdd: () => void; onEdit: (r: Rec) => void }) {
  const [showPast, setShowPast] = useState(false)
  const current = records.filter((r) => isCurrentMedicine(r.content.fields))
  const past = records.filter((r) => !isCurrentMedicine(r.content.fields))
  const item = (r: Rec) => {
    const f = r.content.fields
    return (
      <Row key={r.id} onEdit={() => onEdit(r)} title={[f.name, f.strength].filter(Boolean).join(' · ')} label={`Edit medicine ${f.name}`}>
        <span className="small">{f.dose}</span>
        {f.reason && <span className="muted small"> for {f.reason}</span>}
        {f.prescriberId && <span className="muted small"> · {contactName(contacts, f.prescriberId)}</span>}
        {f.chronic === 'yes' && <Badge tone="accent">Chronic</Badge>}
        {f.chronic === 'yes' && f.repeatsLeft && <span className="muted small"> {f.repeatsLeft} repeats left</span>}
        {f.scriptExpiry && <span className="muted small"> · script expires {f.scriptExpiry}</span>}
      </Row>
    )
  }
  return (
    <Card
      title={
        <>
          <Pill size={18} aria-hidden /> Medicines
        </>
      }
      actions={<Button variant="ghost" icon={<Plus size={16} aria-hidden />} aria-label="Add a medicine" onClick={onAdd} />}
    >
      {current.length === 0 ? <p className="muted small">No current medicines.</p> : <ul className="item-list">{current.map(item)}</ul>}
      {past.length > 0 && (
        <>
          <button className="link small" onClick={() => setShowPast(!showPast)}>
            {showPast ? 'Hide past medicines' : `Past medicines (${past.length})`}
          </button>
          {showPast && <ul className="item-list">{past.map(item)}</ul>}
        </>
      )}
    </Card>
  )
}

function History({ ctx, records, contacts, onAdd, onEdit }: { ctx: HubContext; records: Rec[]; contacts: Contact[]; onAdd: () => void; onEdit: (r: Rec) => void }) {
  const [type, setType] = useState('')
  const [year, setYear] = useState('')
  const [query, setQuery] = useState('')
  const years = useMemo(() => [...new Set(records.map((r) => (r.content.fields.date ?? '').slice(0, 4)).filter(Boolean))].sort().reverse(), [records])
  const shown = records
    .filter((r) => (!type || r.content.fields.type === type) && (!year || (r.content.fields.date ?? '').startsWith(year)))
    .filter((r) => {
      const q = query.trim().toLowerCase()
      return !q || [r.content.fields.title, r.content.fields.notes, contactName(contacts, r.content.fields.providerId)].some((v) => (v ?? '').toLowerCase().includes(q))
    })
    .sort((a, b) => (b.content.fields.date ?? '').localeCompare(a.content.fields.date ?? ''))
  return (
    <Card
      title={
        <>
          <Syringe size={18} aria-hidden /> History
        </>
      }
      actions={<Button variant="ghost" icon={<Plus size={16} aria-hidden />} aria-label="Add to history" onClick={onAdd} />}
    >
      {records.length > 0 && (
        <div className="row">
          <div className="contacts-search">
            <Search size={16} aria-hidden />
            <input aria-label="Search history" placeholder="Search history" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <select className="select select-small" aria-label="Kind of entry" value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Everything</option>
            {HISTORY_TYPES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select className="select select-small" aria-label="Year" value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="">All years</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      )}
      {records.length === 0 && <p className="muted small">Visits, diagnoses, operations, tests, vaccinations: newest first.</p>}
      {records.length > 0 && shown.length === 0 && <p className="muted small">Nothing matches.</p>}
      <ul className="timeline">
        {shown.map((r) => {
          const f = r.content.fields
          return (
            <li key={r.id}>
              <span className="timeline-icon" aria-hidden>
                <Stethoscope size={14} />
              </span>
              <div className="item-main">
                <div className="muted small">
                  {f.date} · {optionLabel(HISTORY_TYPES, f.type ?? 'other')}
                  {f.providerId && ` · ${contactName(contacts, f.providerId)}`}
                </div>
                <div>
                  <strong>{f.title}</strong>
                </div>
                {f.notes && <div className="pre-wrap small">{f.notes}</div>}
                {r.content.documents.length > 0 && <Documents ctx={ctx} documents={r.content.documents} />}
              </div>
              <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${f.title}`} onClick={() => onEdit(r)} />
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

// ---- adding and editing --------------------------------------------------------------------

function RecordDialog({
  ctx,
  kind,
  person,
  record,
  initial: preset,
  contacts,
  onClose,
}: {
  ctx: HubContext
  kind: HealthKind
  person: Person
  record?: Rec
  initial?: Record<string, string>
  contacts: Contact[]
  onClose: (changed: boolean) => void
}) {
  const { api } = ctx.platform
  const def = KINDS[kind]
  const [fields, setFields] = useState<Record<string, string>>(() => {
    if (record) return { ...record.content.fields, ...(preset ?? {}) }
    const initial: Record<string, string> = {}
    for (const f of def.fields) if (f.type === 'select' && f.options?.length) initial[f.key] = f.options[0]![0]
    if (kind === 'history') initial.date = new Date().toISOString().slice(0, 10)
    if (kind === 'condition') initial.status = 'ongoing'
    return { ...initial, ...(preset ?? {}) }
  })
  const [documents, setDocuments] = useState<LinkedDocument[]>(record?.content.documents ?? [])
  const [changes, setChanges] = useState(record?.content.changes ?? [])
  const [change, setChange] = useState({ date: new Date().toISOString().slice(0, 10), note: '' })
  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }))
  // Chronic-script fields only when it is a chronic medicine.
  const visible = def.fields.filter((f) => kind !== 'medicine' || !['scriptDate', 'repeatsLeft', 'scriptExpiry'].includes(f.key) || fields.chronic === 'yes')

  const save = useAction(async () => {
    for (const f of def.fields) if (f.required && !fields[f.key]?.trim()) throw new Error(`${f.label} is needed.`)
    const key = vault.use()
    if (!key) throw new Error('The family vault has locked. Open it again, then save.')
    // Every field, including ones not on the form (an appointment's calendar event, a vaccine's scheduled dose).
    const clean: Record<string, string> = {}
    for (const [k, v] of Object.entries(fields)) if (typeof v === 'string' && v.trim()) clean[k] = v.trim()
    if (kind === 'appointment') {
      const eventId = await syncAppointmentEvent(ctx, person, clean, contacts)
      if (eventId) clean.eventId = eventId
      else delete clean.eventId
    }
    const ciphertext = await encryptHealth(key, person.id, { kind, fields: clean, documents, changes: change.note.trim() ? [...changes, { date: change.date, note: change.note.trim() }] : changes })
    try {
      if (record) await api.request('PUT', `/api/health/records/${record.id}`, { ciphertext, baseVersion: record.version })
      else await api.post('/api/health/records', { profileId: person.id, ciphertext })
    } catch (e) {
      if (e instanceof ApiError && e.code === 'edit_conflict') throw new Error(`${e.message} Your changes were not saved.`)
      throw e
    }
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!record || !window.confirm('Delete this from the health record?')) return
    if (kind === 'appointment' && record.content.fields.eventId) await api.del(`/api/calendar/events/${record.content.fields.eventId}`).catch(() => undefined)
    await api.del(`/api/health/records/${record.id}`)
    onClose(true)
  })

  return (
    <Dialog open title={`${record ? 'Edit' : def.addLabel.replace(/^Add (an? |to )?/, 'Add ')} · ${person.displayName}`} onClose={() => onClose(false)}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save.run()
        }}
      >
        {visible.map((f) => (
          <FieldInput key={f.key} def={f} value={fields[f.key] ?? ''} onChange={(v) => set(f.key, v)} contacts={contacts} />
        ))}
        {kind === 'provider' && contacts.length === 0 && <p className="muted small">Add the doctor or practice to Contacts first.</p>}
        {kind === 'medicine' && (
          <fieldset className="radio-group">
            <legend>Changes</legend>
            {changes.map((c, i) => (
              <div key={i} className="row small">
                <span className="muted">{c.date}</span> {c.note}
              </div>
            ))}
            <div className="row">
              <input className="qi-search year-input" type="date" aria-label="Date of change" value={change.date} onChange={(e) => setChange({ ...change, date: e.target.value })} />
              <input className="qi-search" aria-label="Change" placeholder="e.g. Dose raised to 10 mg" maxLength={300} value={change.note} onChange={(e) => setChange({ ...change, note: e.target.value })} />
            </div>
          </fieldset>
        )}
        {kind === 'history' && <AttachDocuments ctx={ctx} documents={documents} onChange={setDocuments} />}
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <div className="row">
          <Button type="submit" busy={save.busy}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
          {record && (
            <Button type="button" variant="danger" icon={<Trash2 size={16} aria-hidden />} busy={remove.busy} onClick={() => void remove.run()}>
              Delete
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  )
}
