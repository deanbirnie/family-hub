/**
 * Episodes (phase 5c): one illness or injury, from the first symptom to
 * recovery. A timeline both parents add to, medicine plans with the next
 * dose and warnings from the prescription, an optional hospital stay, and
 * closing with an outcome. Each piece is its own encrypted health record.
 */
import { Activity, ArrowLeft, BedDouble, CheckCircle2, ClipboardList, Pencil, Pill, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api.ts'
import type { Contact } from '../pages/Contacts.tsx'
import type { HubContext } from '../Shell.tsx'
import { navigate } from '../router.ts'
import { Badge, Banner, Button, Card, Dialog, useAction } from '../ui.tsx'
import { vault } from '../vault/store.ts'
import {
  ENTRY_TYPES,
  entrySummary,
  FEELINGS,
  HOSPITAL_TYPES,
  INTAKE,
  localStamp,
  parseStamp,
  PLAN_MODES,
  planStatus,
  planSummary,
  span,
  SYMPTOMS,
  temperatures,
  whenShort,
  doseWarnings,
  type Dose,
  type EntryType,
  type Plan,
} from './episodes.ts'
import { TrendChart } from './Extras.tsx'
import { decryptHealth, encryptHealth, optionLabel, type FieldDef, type HealthContent, type HealthKind, type LinkedDocument, type StoredHealthRecord } from './model.ts'
import { AttachDocuments, Documents, FieldInput } from './parts.tsx'

type Rec = StoredHealthRecord & { content: HealthContent }
interface Person {
  id: string
  displayName: string
}

/** Encrypts and saves one health record (new, or a change to `record`). */
export async function saveHealth(ctx: HubContext, personId: string, kind: HealthKind, fields: Record<string, string>, documents: LinkedDocument[] = [], record?: Rec): Promise<void> {
  const key = vault.use()
  if (!key) throw new Error('The family vault has locked. Open it again, then save.')
  const clean: Record<string, string> = {}
  for (const [k, v] of Object.entries(fields)) if (typeof v === 'string' && v.trim()) clean[k] = v.trim()
  const ciphertext = await encryptHealth(key, personId, { kind, fields: clean, documents, changes: record?.content.changes ?? [] })
  try {
    if (record) await ctx.platform.api.request('PUT', `/api/health/records/${record.id}`, { ciphertext, baseVersion: record.version })
    else await ctx.platform.api.post('/api/health/records', { profileId: personId, ciphertext })
  } catch (e) {
    if (e instanceof ApiError && e.code === 'edit_conflict') throw new Error('The other parent changed this a moment ago. Close it and open it again to see their change; yours was not saved.')
    throw e
  }
}

const nowStamp = () => localStamp(Date.now())

/** The pieces of one episode. */
export function episodeParts(records: Rec[], episodeId: string) {
  const entries = records.filter((r) => r.content.kind === 'entry' && r.content.fields.episodeId === episodeId)
  const plans = records.filter((r) => r.content.kind === 'plan' && r.content.fields.episodeId === episodeId)
  const doses: Dose[] = entries
    .filter((e) => e.content.fields.type === 'dose' && e.content.fields.planId)
    .map((e) => ({ id: e.id, planId: e.content.fields.planId!, at: parseStamp(e.content.fields.at), skipped: e.content.fields.skipped === 'yes' }))
    .filter((d) => !Number.isNaN(d.at))
  return { entries, plans, doses }
}

/** "Paracetamol: due 14:05", "Amoxicillin: late (due 08:00)". */
export function nextDoseText(plan: Rec, doses: Dose[], now: number): { text: string; late: boolean } | null {
  const p: Plan = { id: plan.id, fields: plan.content.fields }
  const s = planStatus(p, doses, now)
  if (s.phase === 'ended') return null
  const name = plan.content.fields.medicine ?? 'Medicine'
  if (plan.content.fields.mode === 'prn') return s.next && s.next > now ? { text: `${name}: not before ${whenShort(s.next, now)}`, late: false } : null
  if (s.next === null) return null
  if (s.late) return { text: `${name}: late (due ${whenShort(s.next, now)})`, late: true }
  return { text: `${name}: ${s.next <= now ? 'due now' : `due ${whenShort(s.next, now)}`}`, late: false }
}

/** Ticks every 30 seconds, so "due" and "late" stay current. */
function useNow(): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(t)
  }, [])
  return now
}

// ---- the list on a person's Health page ------------------------------------------------------

export function EpisodesCard({ ctx, person, records, onOpen, onChanged }: { ctx: HubContext; person: Person; records: Rec[]; onOpen: (id: string) => void; onChanged: () => void }) {
  const [starting, setStarting] = useState(false)
  const [showPast, setShowPast] = useState(false)
  const now = useNow()
  const episodes = records.filter((r) => r.content.kind === 'episode').sort((a, b) => (b.content.fields.started ?? '').localeCompare(a.content.fields.started ?? ''))
  const open = episodes.filter((e) => e.content.fields.status !== 'closed')
  const past = episodes.filter((e) => e.content.fields.status === 'closed')
  const item = (e: Rec) => {
    const f = e.content.fields
    const { plans, doses } = episodeParts(records, e.id)
    const next = f.status === 'closed' ? [] : plans.map((p) => nextDoseText(p, doses, now)).filter((x): x is { text: string; late: boolean } => !!x)
    return (
      <li key={e.id}>
        <button className="item-main link-row" onClick={() => onOpen(e.id)} aria-label={`Open episode ${f.title}`}>
          <div>
            <strong>{f.title}</strong>
            {f.hospital === 'yes' && !f.discharged && f.status !== 'closed' && <Badge tone="warning">In hospital</Badge>}
          </div>
          <div className="muted small">
            {f.status === 'closed' ? `${(f.started ?? '').slice(0, 10)} to ${f.closed ?? ''}${f.outcome ? ` · ${f.outcome}` : ''}` : `Since ${whenShort(parseStamp(f.started), now)}`}
          </div>
          {next.map((n) => (
            <div key={n.text} className={`small ${n.late ? 'field-error' : ''}`}>
              <Pill size={12} aria-hidden /> {n.text}
            </div>
          ))}
        </button>
      </li>
    )
  }
  return (
    <Card
      className={open.length ? 'episodes-open' : ''}
      title={
        <>
          <Activity size={18} aria-hidden /> Episodes
        </>
      }
      actions={
        <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => setStarting(true)}>
          Start an episode
        </Button>
      }
    >
      {open.length === 0 && <p className="muted small">When {person.displayName} is ill or hurt, start an episode to keep the symptoms, doses, doctors and tests together, and to share them with the other parent as you go.</p>}
      {open.length > 0 && <ul className="item-list">{open.map(item)}</ul>}
      {past.length > 0 && (
        <>
          <button className="link small" onClick={() => setShowPast(!showPast)}>
            {showPast ? 'Hide past episodes' : `Past episodes (${past.length})`}
          </button>
          {showPast && <ul className="item-list">{past.map(item)}</ul>}
        </>
      )}
      {starting && (
        <EpisodeDialog
          ctx={ctx}
          person={person}
          onClose={(id) => {
            setStarting(false)
            if (id !== undefined) onChanged()
          }}
        />
      )}
    </Card>
  )
}

function EpisodeDialog({ ctx, person, record, onClose }: { ctx: HubContext; person: Person; record?: Rec; onClose: (changed?: boolean) => void }) {
  const [fields, setFields] = useState<Record<string, string>>(() => (record ? { ...record.content.fields } : { started: nowStamp(), status: 'open' }))
  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }))
  const save = useAction(async () => {
    if (!fields.title?.trim()) throw new Error('Say what it is, for example “Fever and cough”.')
    await saveHealth(ctx, person.id, 'episode', fields, record?.content.documents ?? [], record)
    onClose(true)
  })
  const defs: FieldDef[] = [
    { key: 'title', label: 'What is it', required: true, placeholder: 'e.g. Fever and cough; Broken arm' },
    { key: 'started', label: 'Started', type: 'datetime' },
    { key: 'symptoms', label: 'First symptoms', type: 'textarea', placeholder: 'e.g. Hot and grumpy since lunch, off his food' },
  ]
  return (
    <Dialog open title={`${record ? 'Edit episode' : 'Start an episode'} · ${person.displayName}`} onClose={() => onClose()}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save.run()
        }}
      >
        {defs.map((d) => (
          <FieldInput key={d.key} def={d} value={fields[d.key] ?? ''} onChange={(v) => set(d.key, v)} contacts={[]} />
        ))}
        {!record && <p className="muted small">Everything in an episode is visible to the other parent as soon as it is saved.</p>}
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <div className="row">
          <Button type="submit" busy={save.busy}>
            {record ? 'Save' : 'Start'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// ---- one episode -----------------------------------------------------------------------------

type Editing =
  | { what: 'entry'; type: EntryType; record?: Rec; preset?: Record<string, string> }
  | { what: 'plan'; record?: Rec }
  | { what: 'episode' }
  | { what: 'hospital' }
  | { what: 'discharge' }
  | { what: 'close' }

export function EpisodeView({
  ctx,
  person,
  records,
  contacts,
  episodeId,
  onBack,
  reload,
}: {
  ctx: HubContext
  person: Person
  records: Rec[]
  contacts: Contact[]
  episodeId: string
  onBack: () => void
  reload: () => Promise<void>
}) {
  const [editing, setEditing] = useState<Editing | null>(null)
  const [filter, setFilter] = useState('')
  const now = useNow()
  // What the other parent logs shows up here within half a minute.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void reload()
    }, 20_000)
    return () => clearInterval(t)
  }, [reload])

  const episode = records.find((r) => r.id === episodeId && r.content.kind === 'episode')
  const { entries, plans, doses } = useMemo(() => episodeParts(records, episodeId), [records, episodeId])
  const remove = useAction(async () => {
    if (!episode || !window.confirm('Delete this episode, with its whole timeline and medicine plans? This cannot be undone.')) return
    for (const r of [...entries, ...plans]) await ctx.platform.api.del(`/api/health/records/${r.id}`)
    await ctx.platform.api.del(`/api/health/records/${episode.id}`)
    await reload()
    onBack()
  })
  const reopen = useAction(async () => {
    if (!episode) return
    await saveHealth(ctx, person.id, 'episode', { ...episode.content.fields, status: 'open' }, episode.content.documents, episode)
    await reload()
  })

  if (!episode) {
    return (
      <Card>
        <p>This episode is no longer there.</p>
        <Button variant="secondary" icon={<ArrowLeft size={16} aria-hidden />} onClick={onBack}>
          Back
        </Button>
      </Card>
    )
  }
  const f = episode.content.fields
  const closed = f.status === 'closed'
  const inHospital = f.hospital === 'yes'
  const temps = temperatures(entries.map((e) => e.content))
  const types = ENTRY_TYPES.filter(([t]) => inHospital || !HOSPITAL_TYPES.includes(t))
  const shown = entries
    .filter((e) => !filter || e.content.fields.type === filter)
    .sort((a, b) => (b.content.fields.at ?? '').localeCompare(a.content.fields.at ?? '') || b.createdAt - a.createdAt)
  const done = (changed?: boolean) => {
    setEditing(null)
    if (changed) void reload()
  }

  return (
    <div className="stack">
      <div className="row">
        <Button variant="ghost" icon={<ArrowLeft size={16} aria-hidden />} onClick={onBack}>
          {person.displayName}’s health
        </Button>
      </div>
      <Card
        className="episode-head"
        title={
          <>
            <Activity size={18} aria-hidden /> {f.title}
          </>
        }
        actions={<Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label="Edit the episode" onClick={() => setEditing({ what: 'episode' })} />}
      >
        <div className="row">
          {closed ? <Badge>Closed {f.closed}</Badge> : <Badge tone="accent">Open</Badge>}
          {inHospital && !f.discharged && !closed && <Badge tone="warning">In hospital</Badge>}
          <span className="muted small">
            Started {whenShort(parseStamp(f.started), now)}
            {!closed && ` · ${span(now - parseStamp(f.started))} ago`}
          </span>
        </div>
        {f.symptoms && <p className="pre-wrap small">{f.symptoms}</p>}
        {closed && (
          <p className="small">
            <strong>Outcome:</strong> {[f.outcome, f.diagnosis && `diagnosis: ${f.diagnosis}`, f.outcomeNotes].filter(Boolean).join(' · ')}
          </p>
        )}
        {!closed && (
          <div className="row episode-add" role="group" aria-label="Add to the timeline">
            {types.map(([t, label]) => (
              <Button key={t} variant="secondary" onClick={() => setEditing({ what: 'entry', type: t })}>
                {t === 'dose' ? 'Dose given' : label}
              </Button>
            ))}
          </div>
        )}
        <div className="row">
          {!closed && !inHospital && (
            <Button variant="ghost" icon={<BedDouble size={16} aria-hidden />} onClick={() => setEditing({ what: 'hospital' })}>
              Admitted to hospital
            </Button>
          )}
          {!closed && (
            <Button variant="ghost" icon={<CheckCircle2 size={16} aria-hidden />} onClick={() => setEditing({ what: 'close' })}>
              Close the episode
            </Button>
          )}
          {closed && (
            <Button variant="ghost" icon={<RotateCcw size={16} aria-hidden />} busy={reopen.busy} onClick={() => void reopen.run()}>
              Reopen
            </Button>
          )}
          <Button variant="ghost" icon={<Trash2 size={16} aria-hidden />} busy={remove.busy} onClick={() => void remove.run()}>
            Delete
          </Button>
        </div>
        {(remove.error || reopen.error) && <Banner kind="error">{remove.error || reopen.error}</Banner>}
      </Card>

      <Card
        title={
          <>
            <Pill size={18} aria-hidden /> Medicine plans
          </>
        }
        actions={!closed && <Button variant="ghost" icon={<Plus size={16} aria-hidden />} aria-label="Add a medicine plan" onClick={() => setEditing({ what: 'plan' })} />}
      >
        {plans.length === 0 && <p className="muted small">Add each medicine as the doctor prescribed it: the dose, how often, and for how long. The hub then shows the next dose and reminds both parents.</p>}
        <ul className="item-list">
          {plans.map((p) => (
            <PlanRow
              key={p.id}
              plan={p}
              doses={doses}
              now={now}
              closed={closed}
              onGive={() => setEditing({ what: 'entry', type: 'dose', preset: { planId: p.id } })}
              onEdit={() => setEditing({ what: 'plan', record: p })}
            />
          ))}
        </ul>
      </Card>

      {inHospital && (
        <Card
          title={
            <>
              <BedDouble size={18} aria-hidden /> Hospital stay
            </>
          }
          actions={<Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label="Edit the hospital stay" onClick={() => setEditing({ what: 'hospital' })} />}
        >
          <p>
            <strong>{f.hospitalName}</strong>
            {f.ward && ` · ${f.ward}`}
          </p>
          <p className="muted small">
            Admitted {whenShort(parseStamp(f.admitted), now)}
            {f.discharged && ` · discharged ${whenShort(parseStamp(f.discharged), now)}`}
          </p>
          {f.hospitalNotes && <p className="pre-wrap small">{f.hospitalNotes}</p>}
          {f.discharged ? (
            <>
              {f.dischargeSummary && <p className="pre-wrap small">{f.dischargeSummary}</p>}
              {f.medicinesHome && (
                <p className="pre-wrap small">
                  <strong>Medicines home:</strong> {f.medicinesHome}
                </p>
              )}
              <div className="row">
                <Button variant="ghost" onClick={() => setEditing({ what: 'discharge' })}>
                  Edit the discharge
                </Button>
              </div>
            </>
          ) : (
            !closed && (
              <div className="row">
                <Button variant="secondary" onClick={() => setEditing({ what: 'discharge' })}>
                  Discharged
                </Button>
              </div>
            )
          )}
          {episode.content.documents.length > 0 && <Documents ctx={ctx} documents={episode.content.documents} />}
        </Card>
      )}

      {temps.length > 0 && (
        <Card title="Temperature">
          <div className="episode-chart">
            <TrendChart title="Temperature" unit="°C" points={temps.map((t) => ({ date: t.at, value: t.value }))} label={(d) => whenShort(parseStamp(d), now)} />
          </div>
        </Card>
      )}

      <Card
        title={
          <>
            <ClipboardList size={18} aria-hidden /> Timeline
          </>
        }
        actions={
          entries.length > 0 && (
            <select className="select select-small" aria-label="Show" value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">Everything</option>
              {ENTRY_TYPES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          )
        }
      >
        {entries.length === 0 && <p className="muted small">Nothing logged yet. Add observations, doses, what the doctor said, tests and photos as they happen.</p>}
        <ul className="timeline">
          {shown.map((e) => {
            const ef = e.content.fields
            return (
              <li key={e.id}>
                <span className="timeline-icon" aria-hidden>
                  {ef.type === 'dose' ? <Pill size={14} /> : ef.type === 'vitals' ? <Activity size={14} /> : <ClipboardList size={14} />}
                </span>
                <div className="item-main">
                  <div className="muted small">
                    {whenShort(parseStamp(ef.at), now)} · {optionLabel(ENTRY_TYPES, ef.type ?? 'note')}
                    {ef.by && ` · ${ef.by}`}
                  </div>
                  {entrySummary(ef) && <div>{entrySummary(ef)}</div>}
                  {ef.override && <div className="small field-error">Given against a warning: {ef.override}</div>}
                  {ef.skipReason && <div className="small muted">Why not: {ef.skipReason}</div>}
                  {[ef.said, ef.instructions, ef.questions && `Questions: ${ef.questions}`, ef.note].filter(Boolean).map((t) => (
                    <div key={t} className="pre-wrap small">
                      {t}
                    </div>
                  ))}
                  {e.content.documents.length > 0 && <Documents ctx={ctx} documents={e.content.documents} />}
                </div>
                <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit the ${optionLabel(ENTRY_TYPES, ef.type ?? 'note').toLowerCase()} at ${ef.at?.replace('T', ' ')}`} onClick={() => setEditing({ what: 'entry', type: (ef.type ?? 'note') as EntryType, record: e })} />
              </li>
            )
          })}
        </ul>
      </Card>

      {editing?.what === 'entry' && (
        <EntryDialog ctx={ctx} person={person} episodeId={episodeId} type={editing.type} record={editing.record} preset={editing.preset} plans={plans} doses={doses} contacts={contacts} onClose={done} />
      )}
      {editing?.what === 'plan' && <PlanDialog ctx={ctx} person={person} episodeId={episodeId} record={editing.record} contacts={contacts} onClose={done} />}
      {editing?.what === 'episode' && <EpisodeDialog ctx={ctx} person={person} record={episode} onClose={done} />}
      {(editing?.what === 'hospital' || editing?.what === 'discharge') && <HospitalDialog ctx={ctx} person={person} episode={episode} discharge={editing.what === 'discharge'} onClose={done} />}
      {editing?.what === 'close' && <CloseDialog ctx={ctx} person={person} episode={episode} plans={plans} onClose={done} />}
    </div>
  )
}

function PlanRow({ plan, doses, now, closed, onGive, onEdit }: { plan: Rec; doses: Dose[]; now: number; closed: boolean; onGive: () => void; onEdit: () => void }) {
  const f = plan.content.fields
  const s = planStatus({ id: plan.id, fields: f }, doses, now)
  const next = nextDoseText(plan, doses, now)
  return (
    <li>
      <div className="item-main">
        <div>
          <strong>{f.medicine}</strong> <span className="small">{planSummary(f)}</span>
          {s.phase === 'ended' && <Badge>{f.stoppedAt ? 'Stopped' : 'Finished'}</Badge>}
          {s.phase === 'before' && <Badge>Starts {whenShort(planStart(f), now)}</Badge>}
        </div>
        <div className="muted small">
          {s.last ? `Last given ${whenShort(s.last.at, now)} (${span(now - s.last.at)} ago)` : 'None given yet'}
          {` · ${s.inLast24} in the last 24 hours`}
          {f.until && ` · until ${f.until}`}
        </div>
        {!closed && next && <div className={`small ${next.late ? 'field-error' : ''}`}>{next.text.replace(`${f.medicine}: `, 'Next: ')}</div>}
        {s.missed > 0 && (
          <div className="small field-error">
            {s.missed} dose{s.missed === 1 ? '' : 's'} missed
          </div>
        )}
      </div>
      {!closed && s.phase !== 'ended' && (
        <Button variant="secondary" onClick={onGive} aria-label={`Log a dose of ${f.medicine}`}>
          Give
        </Button>
      )}
      <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit the plan for ${f.medicine}`} onClick={onEdit} />
    </li>
  )
}

const planStart = (f: Record<string, string>) => parseStamp(f.start)

// ---- timeline entries ------------------------------------------------------------------------

const AT: FieldDef = { key: 'at', label: 'When', type: 'datetime' }
const ENTRY_FIELDS: Record<EntryType, FieldDef[]> = {
  observation: [
    AT,
    { key: 'temperature', label: 'Temperature (°C)', type: 'number' },
    { key: 'pain', label: 'Pain (0 none – 10 worst)', type: 'select', options: [['', '—'], ...Array.from({ length: 11 }, (_, i): [string, string] => [String(i), String(i)])] },
    { key: 'eating', label: 'Eating', type: 'select', options: INTAKE },
    { key: 'drinking', label: 'Drinking', type: 'select', options: INTAKE },
    { key: 'nappies', label: 'Wet nappies since the last entry', type: 'number' },
    { key: 'note', label: 'Notes', type: 'textarea' },
  ],
  dose: [],
  doctor: [
    AT,
    { key: 'contactId', label: 'Doctor (from Contacts)', type: 'contact' },
    { key: 'who', label: 'Or their name', placeholder: 'e.g. Dr Naidoo, the locum at the after-hours clinic' },
    { key: 'diagnosis', label: 'Diagnosis' },
    { key: 'said', label: 'What they said', type: 'textarea' },
    { key: 'instructions', label: 'Instructions', type: 'textarea', placeholder: 'e.g. Fluids, come back if the fever lasts past Friday' },
  ],
  test: [AT, { key: 'what', label: 'Test', required: true, placeholder: 'e.g. Blood test, chest X-ray, urine' }, { key: 'result', label: 'Result', type: 'textarea' }],
  note: [AT, { key: 'note', label: 'Note', type: 'textarea' }],
  vitals: [
    AT,
    { key: 'temperature', label: 'Temperature (°C)', type: 'number' },
    { key: 'heartRate', label: 'Heart rate (per minute)', type: 'number' },
    { key: 'breathing', label: 'Breathing rate (per minute)', type: 'number' },
    { key: 'oxygen', label: 'Oxygen saturation (%)', type: 'number' },
    { key: 'bp', label: 'Blood pressure', placeholder: 'e.g. 110/70' },
    { key: 'weight', label: 'Weight (kg)', type: 'number' },
    { key: 'note', label: 'Notes', type: 'textarea' },
  ],
  round: [
    AT,
    { key: 'who', label: 'Who', placeholder: 'e.g. Dr Patel and the registrar' },
    { key: 'decisions', label: 'What was decided', type: 'textarea' },
    { key: 'questions', label: 'Questions to ask', type: 'textarea' },
    { key: 'note', label: 'Notes', type: 'textarea' },
  ],
  feeling: [AT, { key: 'feeling', label: 'How they are feeling', type: 'select', options: FEELINGS }, { key: 'note', label: 'In their words, or what you notice', type: 'textarea' }],
}

function EntryDialog({
  ctx,
  person,
  episodeId,
  type,
  record,
  preset,
  plans,
  doses,
  contacts,
  onClose,
}: {
  ctx: HubContext
  person: Person
  episodeId: string
  type: EntryType
  record?: Rec
  preset?: Record<string, string>
  plans: Rec[]
  doses: Dose[]
  contacts: Contact[]
  onClose: (changed?: boolean) => void
}) {
  const [fields, setFields] = useState<Record<string, string>>(() => {
    if (record) return { ...record.content.fields }
    const initial: Record<string, string> = { type, at: nowStamp(), episodeId, ...(preset ?? {}) }
    if (type === 'feeling') initial.feeling = 'same'
    const plan = plans.find((p) => p.id === initial.planId) ?? (type === 'dose' && plans.length === 1 ? plans[0] : undefined)
    if (plan) Object.assign(initial, { planId: plan.id, medicine: plan.content.fields.medicine ?? '', amount: plan.content.fields.amount ?? '' })
    return initial
  })
  const [documents, setDocuments] = useState<LinkedDocument[]>(record?.content.documents ?? [])
  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }))
  const plan = plans.find((p) => p.id === fields.planId)
  const at = parseStamp(fields.at)
  const warnings = type === 'dose' && plan && fields.skipped !== 'yes' && !Number.isNaN(at) ? doseWarnings({ id: plan.id, fields: plan.content.fields }, doses, at, record?.id) : []

  const save = useAction(async () => {
    if (Number.isNaN(parseStamp(fields.at))) throw new Error('When is needed.')
    for (const d of ENTRY_FIELDS[type]) if (d.required && !fields[d.key]?.trim()) throw new Error(`${d.label} is needed.`)
    if (type === 'dose' && !fields.medicine?.trim()) throw new Error('Which medicine is needed.')
    if (warnings.length > 0 && !fields.override?.trim()) throw new Error('Say why it is being given anyway (for example, the doctor said so), or change the time.')
    const out = { ...fields }
    if (warnings.length === 0) delete out.override
    if (out.skipped !== 'yes') delete out.skipReason
    if (!record) out.by = ctx.user.displayName
    await saveHealth(ctx, person.id, 'entry', out, documents, record)
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!record || !window.confirm('Delete this from the timeline?')) return
    await ctx.platform.api.del(`/api/health/records/${record.id}`)
    onClose(true)
  })

  const label = optionLabel(ENTRY_TYPES, type)
  return (
    <Dialog open title={`${record ? 'Edit' : 'Add'}: ${label.toLowerCase()} · ${person.displayName}`} onClose={() => onClose()}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save.run()
        }}
      >
        {type === 'dose' ? (
          <>
            <FieldInput def={AT} value={fields.at ?? ''} onChange={(v) => set('at', v)} contacts={[]} />
            <div className="field">
              <label htmlFor="dose-plan">Medicine</label>
              <select
                id="dose-plan"
                className="select"
                value={fields.planId ?? ''}
                onChange={(e) => {
                  const p = plans.find((x) => x.id === e.target.value)
                  setFields((f) => ({ ...f, planId: e.target.value, medicine: p?.content.fields.medicine ?? '', amount: p?.content.fields.amount ?? '' }))
                }}
              >
                <option value="">Not in a plan</option>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.content.fields.medicine}
                  </option>
                ))}
              </select>
            </div>
            {!fields.planId && <FieldInput def={{ key: 'medicine', label: 'Which medicine', required: true }} value={fields.medicine ?? ''} onChange={(v) => set('medicine', v)} contacts={[]} />}
            {plan && <p className="muted small">Prescribed: {planSummary(plan.content.fields)}</p>}
            <FieldInput def={{ key: 'amount', label: 'Amount given', placeholder: 'e.g. 5 ml' }} value={fields.amount ?? ''} onChange={(v) => set('amount', v)} contacts={[]} />
            <FieldInput def={{ key: 'skipped', label: 'Not given (refused, vomited, or on the doctor’s advice)', type: 'checkbox' }} value={fields.skipped ?? ''} onChange={(v) => set('skipped', v)} contacts={[]} />
            {fields.skipped === 'yes' && <FieldInput def={{ key: 'skipReason', label: 'Why not' }} value={fields.skipReason ?? ''} onChange={(v) => set('skipReason', v)} contacts={[]} />}
            {warnings.length > 0 && (
              <Banner kind="warning">
                {warnings.map((w) => (
                  <div key={w}>{w}</div>
                ))}
                <div className="small">These come from the prescription as you entered it. If a doctor said otherwise, say so below.</div>
              </Banner>
            )}
            {warnings.length > 0 && (
              <FieldInput def={{ key: 'override', label: 'Why it is being given anyway', placeholder: 'e.g. Dr Naidoo said to give it now' }} value={fields.override ?? ''} onChange={(v) => set('override', v)} contacts={[]} />
            )}
          </>
        ) : (
          ENTRY_FIELDS[type].map((d) => <FieldInput key={d.key} def={d} value={fields[d.key] ?? ''} onChange={(v) => set(d.key, v)} contacts={contacts} />)
        )}
        {type === 'observation' && <SymptomPicker value={fields.symptoms ?? ''} onChange={(v) => set('symptoms', v)} />}
        <AttachDocuments ctx={ctx} documents={documents} onChange={setDocuments} />
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <div className="row">
          <Button type="submit" busy={save.busy}>
            {warnings.length > 0 ? 'Save anyway' : 'Save'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => onClose()}>
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

function SymptomPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const chosen = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const [other, setOther] = useState('')
  const toggle = (s: string) => onChange((chosen.includes(s) ? chosen.filter((x) => x !== s) : [...chosen, s]).join(', '))
  return (
    <fieldset className="radio-group">
      <legend>Symptoms</legend>
      <div className="row chips">
        {[...SYMPTOMS, ...chosen.filter((c) => !SYMPTOMS.includes(c))].map((s) => (
          <button key={s} type="button" className={`chip ${chosen.includes(s) ? 'chip-on' : ''}`} aria-pressed={chosen.includes(s)} onClick={() => toggle(s)}>
            {s}
          </button>
        ))}
      </div>
      <div className="row">
        <input className="qi-search" aria-label="Another symptom" placeholder="Another symptom" maxLength={60} value={other} onChange={(e) => setOther(e.target.value)} />
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            if (other.trim() && !chosen.includes(other.trim())) onChange([...chosen, other.trim().replace(/,/g, ' ')].join(', '))
            setOther('')
          }}
        >
          Add
        </Button>
      </div>
    </fieldset>
  )
}

// ---- medicine plans --------------------------------------------------------------------------

function PlanDialog({ ctx, person, episodeId, record, contacts, onClose }: { ctx: HubContext; person: Person; episodeId: string; record?: Rec; contacts: Contact[]; onClose: (changed?: boolean) => void }) {
  const [fields, setFields] = useState<Record<string, string>>(() => (record ? { ...record.content.fields } : { episodeId, mode: 'interval', start: nowStamp() }))
  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }))
  const save = useAction(async () => {
    if (!fields.medicine?.trim()) throw new Error('Which medicine is needed.')
    if (fields.mode === 'interval' && !(Number(fields.everyHours) > 0)) throw new Error('Say every how many hours.')
    if (fields.mode === 'times' && !/\d{2}:\d{2}/.test(fields.times ?? '')) throw new Error('Give the times of day, for example 08:00, 14:00, 20:00.')
    if (Number.isNaN(parseStamp(fields.start))) throw new Error('When the first dose is (or was) is needed.')
    const out = { ...fields }
    if (out.mode !== 'interval') delete out.everyHours
    if (out.mode !== 'times') delete out.times
    await saveHealth(ctx, person.id, 'plan', out, [], record)
    onClose(true)
  })
  const stop = useAction(async () => {
    if (!record || !window.confirm(`Stop ${fields.medicine} now? No more doses will be reminded.`)) return
    await saveHealth(ctx, person.id, 'plan', { ...fields, stoppedAt: nowStamp() }, [], record)
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!record || !window.confirm('Delete this plan? Doses already logged stay in the timeline.')) return
    await ctx.platform.api.del(`/api/health/records/${record.id}`)
    onClose(true)
  })
  const defs: FieldDef[] = [
    { key: 'medicine', label: 'Medicine', required: true, placeholder: 'e.g. Paracetamol syrup 120 mg/5 ml' },
    { key: 'amount', label: 'Dose', placeholder: 'e.g. 5 ml; 1 tablet' },
    { key: 'mode', label: 'How often', type: 'select', options: PLAN_MODES },
    ...(fields.mode === 'interval' ? [{ key: 'everyHours', label: 'Every how many hours', type: 'number' } as FieldDef] : []),
    ...(fields.mode === 'times' ? [{ key: 'times', label: 'Times of day', placeholder: 'e.g. 08:00, 14:00, 20:00' } as FieldDef] : []),
    { key: 'minGapHours', label: 'At least how many hours apart', type: 'number', hint: fields.mode === 'interval' ? 'Leave empty to use “every how many hours”.' : 'Only if the prescription says.' },
    { key: 'maxPer24', label: 'At most how many doses in 24 hours', type: 'number', hint: 'Only if the prescription says.' },
    { key: 'start', label: 'First dose', type: 'datetime' },
    { key: 'until', label: 'Last day', type: 'date', hint: 'e.g. for a 7-day course. Leave empty if it runs until stopped.' },
    { key: 'prescriberId', label: 'Prescribed by', type: 'contact' },
    { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'e.g. With food. Shake well. Keep in the fridge.' },
  ]
  return (
    <Dialog open title={`${record ? 'Edit' : 'Add'} a medicine plan · ${person.displayName}`} onClose={() => onClose()}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save.run()
        }}
      >
        <p className="muted small">Enter it exactly as prescribed. The hub only warns from what you enter here; it never suggests a dose.</p>
        {defs.map((d) => (
          <FieldInput key={d.key} def={d} value={fields[d.key] ?? ''} onChange={(v) => set(d.key, v)} contacts={contacts} />
        ))}
        {fields.stoppedAt && <p className="muted small">Stopped {fields.stoppedAt.replace('T', ' ')}.</p>}
        {(save.error || stop.error || remove.error) && <Banner kind="error">{save.error || stop.error || remove.error}</Banner>}
        <div className="row">
          <Button type="submit" busy={save.busy}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
          {record && !fields.stoppedAt && (
            <Button type="button" variant="secondary" busy={stop.busy} onClick={() => void stop.run()}>
              Stop now
            </Button>
          )}
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

// ---- hospital, discharge and closing ---------------------------------------------------------

function HospitalDialog({ ctx, person, episode, discharge, onClose }: { ctx: HubContext; person: Person; episode: Rec; discharge: boolean; onClose: (changed?: boolean) => void }) {
  const [fields, setFields] = useState<Record<string, string>>(() => {
    const f = { ...episode.content.fields }
    if (!discharge && !f.admitted) f.admitted = nowStamp()
    if (discharge && !f.discharged) f.discharged = nowStamp()
    return f
  })
  const [documents, setDocuments] = useState<LinkedDocument[]>(episode.content.documents)
  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }))
  const save = useAction(async () => {
    if (!discharge && !fields.hospitalName?.trim()) throw new Error('Which hospital is needed.')
    await saveHealth(ctx, person.id, 'episode', { ...fields, hospital: 'yes' }, documents, episode)
    onClose(true)
  })
  const defs: FieldDef[] = discharge
    ? [
        { key: 'discharged', label: 'Discharged', type: 'datetime' },
        { key: 'dischargeSummary', label: 'Discharge summary', type: 'textarea', placeholder: 'What the doctors said, follow-ups, what to watch for' },
        { key: 'medicinesHome', label: 'Medicines to take home', type: 'textarea', hint: 'Add each one as a medicine plan too, to be reminded.' },
      ]
    : [
        { key: 'hospitalName', label: 'Hospital', required: true },
        { key: 'ward', label: 'Ward and bed' },
        { key: 'admitted', label: 'Admitted', type: 'datetime' },
        { key: 'hospitalNotes', label: 'Notes', type: 'textarea', placeholder: 'e.g. Visiting hours, the ward’s phone number, who the doctor in charge is' },
      ]
  return (
    <Dialog open title={`${discharge ? 'Discharge' : 'Hospital stay'} · ${person.displayName}`} onClose={() => onClose()}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save.run()
        }}
      >
        {defs.map((d) => (
          <FieldInput key={d.key} def={d} value={fields[d.key] ?? ''} onChange={(v) => set(d.key, v)} contacts={[]} />
        ))}
        {!discharge && !episode.content.fields.hospital && <p className="muted small">The timeline then also takes vitals, ward rounds and how they are feeling.</p>}
        {discharge && <AttachDocuments ctx={ctx} documents={documents} onChange={setDocuments} />}
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <div className="row">
          <Button type="submit" busy={save.busy}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

const OUTCOMES: [string, string][] = [
  ['Recovered', 'Recovered'],
  ['Getting better', 'Getting better'],
  ['Ongoing condition', 'Became an ongoing condition'],
  ['Referred', 'Referred to a specialist'],
  ['Other', 'Other'],
]

function CloseDialog({ ctx, person, episode, plans, onClose }: { ctx: HubContext; person: Person; episode: Rec; plans: Rec[]; onClose: (changed?: boolean) => void }) {
  const today = nowStamp().slice(0, 10)
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...episode.content.fields, closed: today, outcome: episode.content.fields.outcome || 'Recovered' }))
  const [addCondition, setAddCondition] = useState(false)
  const [addMedicines, setAddMedicines] = useState<string[]>([])
  const set = (k: string, v: string) => setFields((f) => ({ ...f, [k]: v }))
  const save = useAction(async () => {
    if (addCondition && !fields.diagnosis?.trim()) throw new Error('Give the diagnosis to add it to Conditions.')
    const started = (episode.content.fields.started ?? today).slice(0, 10)
    if (addCondition) {
      await saveHealth(ctx, person.id, 'condition', { name: fields.diagnosis!, since: started, status: fields.outcome === 'Recovered' ? 'resolved' : 'ongoing', notes: `From the episode “${fields.title}”.` })
    }
    for (const p of plans.filter((x) => addMedicines.includes(x.id))) {
      const f = p.content.fields
      await saveHealth(ctx, person.id, 'medicine', {
        name: f.medicine ?? '',
        dose: planSummary(f),
        reason: fields.diagnosis || fields.title || '',
        prescriberId: f.prescriberId ?? '',
        start: (f.start ?? '').slice(0, 10),
        end: f.until ?? '',
        notes: f.notes ?? '',
      })
    }
    await saveHealth(ctx, person.id, 'episode', { ...fields, status: 'closed' }, episode.content.documents, episode)
    onClose(true)
  })
  const defs: FieldDef[] = [
    { key: 'closed', label: 'Closed on', type: 'date' },
    { key: 'outcome', label: 'Outcome', type: 'select', options: OUTCOMES },
    { key: 'diagnosis', label: 'Diagnosis', placeholder: 'e.g. Tonsillitis' },
    { key: 'outcomeNotes', label: 'Notes', type: 'textarea', placeholder: 'e.g. Follow-up in 2 weeks if the cough is still there' },
  ]
  return (
    <Dialog open title={`Close the episode · ${person.displayName}`} onClose={() => onClose()}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save.run()
        }}
      >
        {defs.map((d) => (
          <FieldInput key={d.key} def={d} value={fields[d.key] ?? ''} onChange={(v) => set(d.key, v)} contacts={[]} />
        ))}
        <fieldset className="radio-group">
          <legend>Keep in the health record</legend>
          <label className="check">
            <input type="checkbox" checked={addCondition} onChange={(e) => setAddCondition(e.target.checked)} />
            <span>Add the diagnosis to Conditions</span>
          </label>
          {plans.map((p) => (
            <label key={p.id} className="check">
              <input type="checkbox" checked={addMedicines.includes(p.id)} onChange={(e) => setAddMedicines(e.target.checked ? [...addMedicines, p.id] : addMedicines.filter((x) => x !== p.id))} />
              <span>Add {p.content.fields.medicine} to Medicines</span>
            </label>
          ))}
        </fieldset>
        <p className="muted small">The episode stays under Past episodes with its whole timeline. Dose reminders stop.</p>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <div className="row">
          <Button type="submit" busy={save.busy}>
            Close the episode
          </Button>
          <Button type="button" variant="ghost" onClick={() => onClose()}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

// ---- on the home page ------------------------------------------------------------------------

/**
 * Open episodes on the home page, for parents, while the family vault is
 * open on this device (the details are end-to-end encrypted). Nothing shows
 * when it is locked or nobody is ill.
 */
export function OpenEpisodesCard({ ctx }: { ctx: HubContext }) {
  const [items, setItems] = useState<{ id: string; title: string; whose: string; hospital: boolean; next: { text: string; late: boolean }[] }[]>([])
  useEffect(() => {
    let live = true
    const load = async () => {
      const key = vault.use()
      if (!key) return setItems([])
      const raw = await ctx.platform.api.get<{ profiles: Person[]; records: StoredHealthRecord[] }>('/api/health/records')
      const records: Rec[] = []
      for (const r of raw.records) {
        try {
          records.push({ ...r, content: await decryptHealth(key, r) })
        } catch {
          // not for this family key
        }
      }
      const open = records.filter((r) => r.content.kind === 'episode' && r.content.fields.status !== 'closed')
      if (!live) return
      setItems(
        open.map((e) => {
          const { plans, doses } = episodeParts(records, e.id)
          return {
            id: e.id,
            title: e.content.fields.title ?? 'Episode',
            whose: raw.profiles.find((p) => p.id === e.profileId)?.displayName ?? '',
            hospital: e.content.fields.hospital === 'yes' && !e.content.fields.discharged,
            next: plans.map((p) => nextDoseText(p, doses, Date.now())).filter((x): x is { text: string; late: boolean } => !!x),
          }
        }),
      )
    }
    void load().catch(() => undefined)
    const t = setInterval(() => void load().catch(() => undefined), 60_000)
    const off = vault.subscribe(() => void load().catch(() => undefined))
    return () => {
      live = false
      clearInterval(t)
      off()
    }
  }, [ctx.platform.api])
  if (items.length === 0) return null
  return (
    <Card
      className="episodes-open"
      title={
        <>
          <Activity size={18} aria-hidden /> {items.length === 1 ? 'Unwell' : 'Episodes open'}
        </>
      }
    >
      <ul className="item-list">
        {items.map((i) => (
          <li key={i.id}>
            <button className="item-main link-row" onClick={() => navigate(`/health/episodes/${encodeURIComponent(i.id)}`)}>
              <div>
                <strong>{i.whose}</strong> · {i.title}
                {i.hospital && <Badge tone="warning">In hospital</Badge>}
              </div>
              {i.next.map((n) => (
                <div key={n.text} className={`small ${n.late ? 'field-error' : 'muted'}`}>
                  <Pill size={12} aria-hidden /> {n.text}
                </div>
              ))}
            </button>
          </li>
        ))}
      </ul>
    </Card>
  )
}
