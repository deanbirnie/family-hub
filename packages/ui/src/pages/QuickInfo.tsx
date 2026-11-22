/**
 * Quick Info: the family's reference card, for parents. Everything shown here
 * is decrypted on this device from the family vault; the server only ever
 * has ciphertext (docs/DATA-PROTECTION.md, "Quick Info").
 */
import { Copy, Eye, EyeOff, FileText, Home, Pencil, Phone, Plus, Siren, Trash2, UserPlus } from 'lucide-react'
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { ApiError } from '../api.ts'
import { formatDate } from '../format.ts'
import {
  checkSaId,
  decryptRecord,
  encryptRecord,
  mask,
  PERSON_KINDS,
  SECTIONS,
  type Kind,
  type LinkedDocument,
  type RecordContent,
  type SectionDef,
  type StoredRecord,
} from '../quickinfo/model.ts'
import { syncReminders } from '../quickinfo/reminders.ts'
import type { HubContext } from '../Shell.tsx'
import { contactSummary, type Contact } from './Contacts.tsx'
import { Badge, Banner, Button, Card, Dialog, Field, PageHeader, Spinner, errorText, useAction } from '../ui.tsx'
import { vault } from '../vault/store.ts'
import { useVaultUnlocked, VaultCard } from '../vault/VaultCard.tsx'

interface Profile {
  id: string
  displayName: string
  userId: string | null
  /** Emergency contacts (Family Contacts IDs). */
  emergency: { primary: string | null; backup: string | null }
}

/** The address book, for showing and choosing linked contacts. */
const ContactsList = createContext<Contact[]>([])

interface Loaded {
  profiles: Profile[]
  records: (StoredRecord & { content: RecordContent })[]
}

const CLIPBOARD_CLEAR_MS = 30_000

/** Copies a value, then clears the clipboard 30 seconds later (if it still holds that value). */
async function copySensitive(text: string): Promise<void> {
  await navigator.clipboard?.writeText(text)
  setTimeout(() => {
    void navigator.clipboard
      ?.readText()
      .then((now) => (now === text ? navigator.clipboard.writeText('') : undefined))
      .catch(() => navigator.clipboard?.writeText('').catch(() => undefined))
  }, CLIPBOARD_CLEAR_MS)
}

export function QuickInfoPage({ ctx }: { ctx: HubContext }) {
  const unlocked = useVaultUnlocked()
  if (ctx.user.role !== 'admin') {
    return (
      <div className="page">
        <PageHeader title="Quick Info" />
        <Card>
          <p>Quick Info holds the family’s ID numbers, medical aid and policy details. It is kept for parents only.</p>
        </Card>
      </div>
    )
  }
  return (
    <div className="page">
      <PageHeader title="Quick Info" subtitle="ID numbers, medical aid, passports, vehicles and policies: encrypted, for parents only." />
      {unlocked ? <QuickInfoBody ctx={ctx} /> : <VaultCard ctx={ctx} />}
    </div>
  )
}

function QuickInfoBody({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const [data, setData] = useState<Loaded | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ kind: Kind; profileId: string | null; record?: Loaded['records'][number] } | null>(null)
  const [addingPerson, setAddingPerson] = useState(false)
  const [contacts, setContacts] = useState<Contact[]>([])

  const load = useCallback(async () => {
    setError('')
    try {
      const [raw, book] = await Promise.all([
        api.get<{ profiles: Profile[]; records: StoredRecord[] }>('/api/quick-info'),
        api.get<{ contacts: Contact[] }>('/api/contacts'),
      ])
      setContacts(book.contacts)
      const key = vault.use()
      if (!key) return
      const records = await Promise.all(
        raw.records.map(async (r) => {
          try {
            return { ...r, content: await decryptRecord(key, r) }
          } catch {
            return { ...r, content: { fields: { _error: 'This record could not be opened with the family key.' }, documents: [] } }
          }
        }),
      )
      setData({ profiles: raw.profiles, records })
      // Keeps expiry reminders in step with the records (only dates leave the device).
      void syncReminders(api, records).catch(() => undefined)
    } catch (e) {
      setError(errorText(e))
    }
  }, [api])

  useEffect(() => {
    void load()
  }, [load])

  if (error) return <Banner kind="error">{error}</Banner>
  if (!data) return <Spinner />
  const recordsOf = (profileId: string | null, kind: Kind) => data.records.filter((r) => r.profileId === profileId && r.kind === kind)
  const household = recordsOf(null, 'household')[0]

  return (
    <ContactsList.Provider value={contacts}>
      <Card
        title={
          <>
            <Home size={18} aria-hidden /> {SECTIONS.household.title}
          </>
        }
      >
        <SectionView
          ctx={ctx}
          def={SECTIONS.household}
          records={household ? [household] : []}
          onAdd={() => setEditing({ kind: 'household', profileId: null })}
          onEdit={(r) => setEditing({ kind: 'household', profileId: null, record: r })}
        />
      </Card>

      {data.profiles.map((p) => (
        <PersonCard key={p.id} ctx={ctx} profile={p} recordsOf={recordsOf} onEdit={setEditing} onChanged={() => void load()} />
      ))}

      <div>
        <Button variant="secondary" icon={<UserPlus size={16} aria-hidden />} onClick={() => setAddingPerson(true)}>
          Add a person
        </Button>
      </div>

      {addingPerson && <AddPersonDialog ctx={ctx} profiles={data.profiles} onClose={(changed) => (setAddingPerson(false), changed && void load())} />}
      {editing && <EditDialog ctx={ctx} {...editing} onClose={(changed) => (setEditing(null), changed && void load())} />}
    </ContactsList.Provider>
  )
}

function PersonCard({
  ctx,
  profile,
  recordsOf,
  onEdit,
  onChanged,
}: {
  ctx: HubContext
  profile: Profile
  recordsOf: (profileId: string | null, kind: Kind) => Loaded['records']
  onEdit: (e: { kind: Kind; profileId: string; record?: Loaded['records'][number] }) => void
  onChanged: () => void
}) {
  const remove = useAction(async () => {
    if (!window.confirm(`Remove ${profile.displayName} and everything recorded about them from Quick Info?`)) return
    await ctx.platform.api.del(`/api/quick-info/profiles/${profile.id}`)
    onChanged()
  })
  return (
    <Card
      title={profile.displayName}
      actions={<Button variant="ghost" busy={remove.busy} icon={<Trash2 size={18} aria-hidden />} aria-label={`Remove ${profile.displayName}`} onClick={() => void remove.run()} />}
    >
      {remove.error && <Banner kind="error">{remove.error}</Banner>}
      <div className="qi-sections">
        {PERSON_KINDS.map((kind) => (
          <SectionView
            key={kind}
            ctx={ctx}
            def={SECTIONS[kind]}
            records={recordsOf(profile.id, kind)}
            onAdd={() => onEdit({ kind, profileId: profile.id })}
            onEdit={(r) => onEdit({ kind, profileId: profile.id, record: r })}
          />
        ))}
        <EmergencySection ctx={ctx} profile={profile} onChanged={onChanged} />
      </div>
    </Card>
  )
}

function EmergencySection({ ctx, profile, onChanged }: { ctx: HubContext; profile: Profile; onChanged: () => void }) {
  const contacts = useContext(ContactsList)
  const [editing, setEditing] = useState(false)
  const [choice, setChoice] = useState(profile.emergency)
  const save = useAction(async () => {
    await ctx.platform.api.request('PUT', `/api/quick-info/profiles/${profile.id}/emergency`, choice)
    setEditing(false)
    onChanged()
  })
  const set = profile.emergency.primary || profile.emergency.backup
  return (
    <section className="qi-section" aria-label="Emergency contacts">
      <div className="row-between">
        <h3>
          <Siren size={16} aria-hidden /> Emergency contacts
        </h3>
        {!editing && (
          <Button variant="ghost" icon={set ? <Pencil size={16} aria-hidden /> : <Plus size={16} aria-hidden />} onClick={() => (setChoice(profile.emergency), setEditing(true))}>
            {set ? 'Change' : 'Choose emergency contacts'}
          </Button>
        )}
      </div>
      {!editing && set && (
        <dl className="facts qi-facts">
          {profile.emergency.primary && <LinkedContact label="First call" contactId={profile.emergency.primary} />}
          {profile.emergency.backup && <LinkedContact label="If no answer" contactId={profile.emergency.backup} />}
        </dl>
      )}
      {editing && (
        <div className="stack-sm">
          {contacts.length === 0 && <p className="muted small">Add people in Contacts first.</p>}
          <ContactSelect label="First call" value={choice.primary ?? ''} onChange={(v) => setChoice({ ...choice, primary: v || null })} />
          <ContactSelect label="If no answer" value={choice.backup ?? ''} onChange={(v) => setChoice({ ...choice, backup: v || null })} />
          {save.error && <Banner kind="error">{save.error}</Banner>}
          <div className="row">
            <Button busy={save.busy} onClick={() => void save.run()}>
              Save
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

/** A contact linked from a record: its name, what it is, and a number to call. */
function LinkedContact({ label, contactId }: { label: string; contactId: string }) {
  const c = useContext(ContactsList).find((x) => x.id === contactId)
  const phone = c?.phones[0]
  return (
    <>
      <dt>{label}</dt>
      <dd className="qi-value">
        {c ? (
          <>
            <span className="qi-text">
              {c.name}
              {contactSummary(c) && <span className="muted small"> · {contactSummary(c)}</span>}
            </span>
            {phone && (
              <a className="btn btn-ghost" href={`tel:${phone.number.replace(/[^0-9+]/g, '')}`} aria-label={`Call ${c.name}`}>
                <Phone size={16} aria-hidden />
                <span>{phone.number}</span>
              </a>
            )}
          </>
        ) : (
          <span className="muted">This contact has been deleted.</span>
        )}
      </dd>
    </>
  )
}

function ContactSelect({ label, hint, value, onChange }: { label: string; hint?: string; value: string; onChange: (id: string) => void }) {
  const contacts = useContext(ContactsList)
  const id = `contact-${label.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">None</option>
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {contactSummary(c) ? ` (${contactSummary(c)})` : ''}
          </option>
        ))}
      </select>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  )
}

function SectionView({
  ctx,
  def,
  records,
  onAdd,
  onEdit,
}: {
  ctx: HubContext
  def: SectionDef
  records: Loaded['records']
  onAdd: () => void
  onEdit: (r: Loaded['records'][number]) => void
}) {
  const canAdd = def.many || records.length === 0
  return (
    <section className="qi-section" aria-label={def.title}>
      <div className="row-between">
        <h3>{def.kind === 'household' ? 'Address' : def.title}</h3>
        {canAdd && (
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={onAdd}>
            {def.addLabel}
          </Button>
        )}
      </div>
      {records.map((r) => (
        <div key={r.id} className="qi-record">
          {r.content.fields._error ? (
            <Banner kind="error">{r.content.fields._error}</Banner>
          ) : (
            <dl className="facts qi-facts">
              {def.fields
                .filter((f) => r.content.fields[f.key])
                .map((f) =>
                  f.type === 'contact' ? (
                    <LinkedContact key={f.key} label={f.label} contactId={r.content.fields[f.key]!} />
                  ) : (
                    <FieldValue key={f.key} label={f.label} value={r.content.fields[f.key]!} sensitive={f.sensitive} date={f.type === 'date'} />
                  ),
                )}
            </dl>
          )}
          {r.content.documents.length > 0 && <LinkedDocuments ctx={ctx} documents={r.content.documents} />}
          <div className="row">
            <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${def.title.toLowerCase()}`} onClick={() => onEdit(r)}>
              Edit
            </Button>
            <span className="muted small">Updated {formatDate(r.updatedAt)}</span>
          </div>
        </div>
      ))}
    </section>
  )
}

function FieldValue({ label, value, sensitive, date }: { label: string; value: string; sensitive?: boolean; date?: boolean }) {
  const [shown, setShown] = useState(!sensitive)
  const [copied, setCopied] = useState(false)
  const display = date && /^\d{4}-\d{2}-\d{2}$/.test(value) ? formatDate(Date.parse(`${value}T12:00:00`)) : value
  return (
    <>
      <dt>{label}</dt>
      <dd className="qi-value">
        <span className={sensitive && !shown ? 'qi-masked' : 'qi-text'} aria-label={sensitive && !shown ? `${label} (hidden)` : undefined}>
          {sensitive && !shown ? mask(value) : display}
        </span>
        {sensitive && (
          <button className="icon-btn" onClick={() => (vault.use(), setShown(!shown))} aria-label={shown ? `Hide ${label}` : `Show ${label}`} title={shown ? 'Hide' : 'Show'}>
            {shown ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
        <button
          className="icon-btn"
          aria-label={`Copy ${label}`}
          title={sensitive ? 'Copy (clears in 30 s)' : 'Copy'}
          onClick={() => {
            vault.use()
            void (sensitive ? copySensitive(value) : navigator.clipboard?.writeText(value)).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          <Copy size={16} />
        </button>
        {copied && <span className="muted small">{sensitive ? 'Copied; clears in 30 s' : 'Copied'}</span>}
      </dd>
    </>
  )
}

function LinkedDocuments({ ctx, documents }: { ctx: HubContext; documents: LinkedDocument[] }) {
  const open = useAction(async (d: LinkedDocument) => {
    if (ctx.platform.downloadFile) {
      await ctx.platform.downloadFile({ id: d.id, name: d.name, mediaType: 'application/octet-stream' }, 'open')
      return
    }
    const blob = await ctx.platform.api.fileBlob(d.id)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = d.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  })
  return (
    <div className="stack-sm">
      <div className="row">
        {documents.map((d) => (
          <Button key={d.id} variant="secondary" icon={<FileText size={16} aria-hidden />} onClick={() => void open.run(d)}>
            {d.name}
          </Button>
        ))}
      </div>
      {open.error && <Banner kind="error">{open.error}</Banner>}
    </div>
  )
}

// ---- editing -----------------------------------------------------------------------------

function EditDialog({
  ctx,
  kind,
  profileId,
  record,
  onClose,
}: {
  ctx: HubContext
  kind: Kind
  profileId: string | null
  record?: Loaded['records'][number]
  onClose: (changed: boolean) => void
}) {
  const def = SECTIONS[kind]
  const { api } = ctx.platform
  const [fields, setFields] = useState<Record<string, string>>(() => ({ ...(record?.content.fields ?? {}) }))
  const [documents, setDocuments] = useState<LinkedDocument[]>(() => record?.content.documents ?? [])
  const idCheck = fields.idNumber ? checkSaId(fields.idNumber) : null

  const save = useAction(async () => {
    if (idCheck && !idCheck.ok) throw new Error(idCheck.problem)
    const key = vault.use()
    if (!key) throw new Error('The family vault has locked. Open it again, then save.')
    const clean: Record<string, string> = {}
    for (const f of def.fields) if (fields[f.key]?.trim()) clean[f.key] = fields[f.key]!.trim()
    const ciphertext = await encryptRecord(key, kind, profileId, { fields: clean, documents })
    try {
      if (record) await api.request('PUT', `/api/quick-info/records/${record.id}`, { ciphertext, baseVersion: record.version })
      else await api.post('/api/quick-info/records', { kind, profileId, ciphertext })
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'edit_conflict' || e.code === 'record_exists')) {
        throw new Error(`${e.message} Your changes were not saved.`)
      }
      throw e
    }
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!record || !window.confirm(`Delete this ${def.title.toLowerCase().replace(/s$/, '')}?`)) return
    await api.del(`/api/quick-info/records/${record.id}`)
    onClose(true)
  })

  return (
    <Dialog open title={record ? `Edit ${def.title.toLowerCase()}` : def.addLabel} onClose={() => onClose(false)}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save.run()
        }}
      >
        {def.fields.map((f) =>
          f.type === 'contact' ? (
            <ContactSelect key={f.key} label={f.label} hint={f.hint} value={fields[f.key] ?? ''} onChange={(v) => setFields((prev) => ({ ...prev, [f.key]: v }))} />
          ) : (
          <Field
            key={f.key}
            label={f.label}
            type={f.type === 'date' ? 'date' : 'text'}
            inputMode={f.type === 'idNumber' ? 'numeric' : undefined}
            placeholder={f.placeholder}
            hint={f.key === 'idNumber' && idCheck?.ok ? `Valid. Date of birth: ${formatDate(Date.parse(`${idCheck.dateOfBirth}T12:00:00`))}` : f.hint}
            error={f.key === 'idNumber' && idCheck && !idCheck.ok ? idCheck.problem : undefined}
            value={fields[f.key] ?? ''}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              const value = e.target.value
              setFields((prev) => {
                const next = { ...prev, [f.key]: value }
                // Fill in the date of birth from a valid ID number, if it is still empty.
                if (f.key === 'idNumber' && !prev.dateOfBirth) {
                  const check = checkSaId(value)
                  if (check.ok) next.dateOfBirth = check.dateOfBirth
                }
                return next
              })
            }}
          />
          ),
        )}
        <DocumentPicker ctx={ctx} documents={documents} onChange={setDocuments} />
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <div className="row">
          <Button type="submit" busy={save.busy}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
          {record && (
            <Button type="button" variant="danger" busy={remove.busy} icon={<Trash2 size={16} aria-hidden />} onClick={() => void remove.run()}>
              Delete
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  )
}

/** Links scans from the shared documents (which every family member can open). */
function DocumentPicker({ ctx, documents, onChange }: { ctx: HubContext; documents: LinkedDocument[]; onChange: (d: LinkedDocument[]) => void }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<LinkedDocument[] | null>(null)
  const search = useAction(async () => {
    const r = await ctx.platform.api.get<{ items: { id: string; name: string; kind: string }[] }>(`/api/files?${new URLSearchParams({ q: query.trim() })}`)
    setResults(r.items.filter((i) => i.kind === 'file').map((i) => ({ id: i.id, name: i.name })))
  })
  return (
    <fieldset className="radio-group">
      <legend>Linked documents</legend>
      {documents.length > 0 && (
        <ul className="item-list">
          {documents.map((d) => (
            <li key={d.id}>
              <FileText size={18} aria-hidden />
              <div className="item-main">{d.name}</div>
              <Button type="button" variant="ghost" aria-label={`Unlink ${d.name}`} icon={<Trash2 size={16} aria-hidden />} onClick={() => onChange(documents.filter((x) => x.id !== d.id))} />
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">Link a scan from Files. Note: Files are shared with the whole family, not only parents.</p>
      <div className="row">
        <input className="qi-search" aria-label="Search documents" placeholder="Search Files by name" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Button type="button" variant="secondary" busy={search.busy} disabled={!query.trim()} onClick={() => void search.run()}>
          Search
        </Button>
      </div>
      {search.error && <Banner kind="error">{search.error}</Banner>}
      {results && results.length === 0 && <p className="muted small">No documents match.</p>}
      {results && results.length > 0 && (
        <ul className="item-list">
          {results
            .filter((r) => !documents.some((d) => d.id === r.id))
            .map((r) => (
              <li key={r.id}>
                <FileText size={18} aria-hidden />
                <div className="item-main">{r.name}</div>
                <Button type="button" variant="secondary" onClick={() => onChange([...documents, r])}>
                  Link
                </Button>
              </li>
            ))}
        </ul>
      )}
    </fieldset>
  )
}

function AddPersonDialog({ ctx, profiles, onClose }: { ctx: HubContext; profiles: Profile[]; onClose: (changed: boolean) => void }) {
  const { api } = ctx.platform
  const [members, setMembers] = useState<{ id: string; displayName: string }[]>([])
  const [name, setName] = useState('')
  const [userId, setUserId] = useState('')
  useEffect(() => {
    api.get<{ members: { id: string; displayName: string }[] }>('/api/members').then(
      (r) => setMembers(r.members.filter((m) => !profiles.some((p) => p.userId === m.id))),
      () => undefined,
    )
  }, [api, profiles])
  const add = useAction(async () => {
    await api.post('/api/quick-info/profiles', { displayName: name, userId: userId || null })
    onClose(true)
  })
  return (
    <Dialog open title="Add a person" onClose={() => onClose(false)}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void add.run()
        }}
      >
        {members.length > 0 && (
          <div className="stack-sm">
            <p className="muted small">A family member with an account:</p>
            <div className="row">
              {members.map((m) => (
                <Button
                  key={m.id}
                  type="button"
                  variant={userId === m.id ? 'primary' : 'secondary'}
                  onClick={() => {
                    setUserId(m.id)
                    setName(m.displayName)
                  }}
                >
                  {m.displayName}
                </Button>
              ))}
            </div>
            <p className="muted small">Or someone without an account, such as a child:</p>
          </div>
        )}
        <Field label="Name" value={name} onChange={(e) => (setName(e.target.value), setUserId(''))} required maxLength={60} />
        {userId && <Badge tone="accent">Linked to their account</Badge>}
        {add.error && <Banner kind="error">{add.error}</Banner>}
        <div className="row">
          <Button type="submit" busy={add.busy}>
            Add
          </Button>
          <Button type="button" variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
