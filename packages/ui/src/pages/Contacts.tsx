/**
 * Family Contacts: the parents' shared address book. Stored encrypted with
 * the server key (docs/DATA-PROTECTION.md, "Family Contacts").
 */
import { Download, Mail, Phone, Plus, Search, Trash2, UserRound } from 'lucide-react'
import { useMemo, useState } from 'react'
import { ApiError } from '../api.ts'
import { saveFromApi } from '../download.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, Field, PageHeader, Spinner, useAction, useLoad } from '../ui.tsx'

export const CATEGORIES = {
  family: 'Family',
  friend: 'Friends',
  school: 'School',
  health: 'Health',
  insurance: 'Insurance & finance',
  services: 'Services & trades',
  other: 'Other',
} as const
type Category = keyof typeof CATEGORIES
const PHONE_LABELS = { mobile: 'Mobile', home: 'Home', work: 'Work', other: 'Other' } as const
type PhoneLabel = keyof typeof PHONE_LABELS

export interface Contact {
  id: string
  version: number
  name: string
  organisation: string
  role: string
  category: Category
  phones: { label: PhoneLabel; number: string }[]
  emails: string[]
  address: string
  note: string
}

export const useContacts = (ctx: HubContext) => useLoad(() => ctx.platform.api.get<{ contacts: Contact[] }>('/api/contacts'), [ctx.platform.api])

/** "Gran Tester (Family)" or "Ballito Plumbing · Plumber". */
export const contactSummary = (c: Contact) => [c.organisation && c.organisation !== c.name ? c.organisation : '', c.role].filter(Boolean).join(' · ')

export function ContactsPage({ ctx }: { ctx: HubContext }) {
  if (ctx.user.role !== 'admin') {
    return (
      <div className="page">
        <PageHeader title="Contacts" />
        <Card>
          <p>The family address book is kept by the parents.</p>
        </Card>
      </div>
    )
  }
  return <ContactsBody ctx={ctx} />
}

function ContactsBody({ ctx }: { ctx: HubContext }) {
  const contacts = useContacts(ctx)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<Category | 'all'>('all')
  const [editing, setEditing] = useState<Contact | 'new' | null>(null)
  const [exporting, setExporting] = useState(false)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (contacts.data?.contacts ?? []).filter(
      (c) =>
        (category === 'all' || c.category === category) &&
        (!q || [c.name, c.organisation, c.role, ...c.phones.map((p) => p.number), ...c.emails].some((v) => v.toLowerCase().includes(q))),
    )
  }, [contacts.data, query, category])

  return (
    <div className="page">
      <PageHeader
        title="Contacts"
        subtitle="The family’s shared address book: family and friends, school, doctors, insurers and trades."
        actions={
          <div className="row">
            <Button icon={<Plus size={16} aria-hidden />} onClick={() => setEditing('new')}>
              Add contact
            </Button>
            <Button variant="secondary" icon={<Download size={16} aria-hidden />} disabled={!contacts.data?.contacts.length} onClick={() => setExporting(true)}>
              Export
            </Button>
          </div>
        }
      />
      {contacts.error && <Banner kind="error">{contacts.error}</Banner>}
      {!contacts.data && !contacts.error && <Spinner />}
      {contacts.data && (
        <Card>
          <div className="row">
            <div className="contacts-search">
              <Search size={16} aria-hidden />
              <input aria-label="Search contacts" placeholder="Search by name, number or email" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          </div>
          <div className="row chips" role="group" aria-label="Category">
            {(['all', ...Object.keys(CATEGORIES)] as (Category | 'all')[]).map((c) => (
              <button key={c} className={`chip ${category === c ? 'chip-on' : ''}`} aria-pressed={category === c} onClick={() => setCategory(c)}>
                {c === 'all' ? 'All' : CATEGORIES[c]}
              </button>
            ))}
          </div>
          {contacts.data.contacts.length === 0 && <p className="muted">No contacts yet. Add the people and places the family needs to reach.</p>}
          {contacts.data.contacts.length > 0 && shown.length === 0 && <p className="muted">No contacts match.</p>}
          <ul className="contact-list">
            {shown.map((c) => (
              <li key={c.id}>
                <button className="contact-row" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                  <span className="avatar avatar-lg" aria-hidden>
                    <UserRound size={18} />
                  </span>
                  <span className="contact-main">
                    <strong>{c.name}</strong>
                    {contactSummary(c) && <span className="muted small">{contactSummary(c)}</span>}
                  </span>
                  <Badge>{CATEGORIES[c.category]}</Badge>
                </button>
                <div className="contact-actions">
                  {c.phones.map((p) => (
                    <a key={p.number} className="btn btn-ghost" href={`tel:${p.number.replace(/[^0-9+]/g, '')}`} aria-label={`Call ${c.name} (${PHONE_LABELS[p.label]})`}>
                      <Phone size={16} aria-hidden />
                      <span>{p.number}</span>
                    </a>
                  ))}
                  {c.emails.map((e) => (
                    <a key={e} className="btn btn-ghost" href={`mailto:${e}`} aria-label={`Email ${c.name}`}>
                      <Mail size={16} aria-hidden />
                      <span>{e}</span>
                    </a>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && (
        <ContactDialog
          ctx={ctx}
          contact={editing === 'new' ? null : editing}
          onClose={(changed) => {
            setEditing(null)
            if (changed) contacts.reload()
          }}
        />
      )}
      {exporting && <ExportDialog ctx={ctx} onClose={() => setExporting(false)} />}
    </div>
  )
}

function ExportDialog({ ctx, contact, onClose }: { ctx: HubContext; contact?: Contact; onClose: () => void }) {
  const [notes, setNotes] = useState(false)
  const save = useAction(async () => {
    const which = contact ? contact.id : 'all'
    await saveFromApi(ctx.platform, `/api/contacts/export/${which}${notes ? '-notes' : ''}.vcf`, contact ? `${contact.name}.vcf` : 'family-contacts.vcf')
    onClose()
  })
  return (
    <Dialog open title={contact ? `Export ${contact.name}` : 'Export the address book'} onClose={onClose}>
      <div className="stack">
        <p>Saves a vCard (.vcf) file that phones, Google Contacts and Outlook can import.</p>
        <label className="check">
          <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} />
          <span>Include the shared notes (they are left out unless you tick this)</span>
        </label>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <div className="row">
          <Button busy={save.busy} icon={<Download size={16} aria-hidden />} onClick={() => void save.run()}>
            Save .vcf file
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function ContactDialog({ ctx, contact, onClose }: { ctx: HubContext; contact: Contact | null; onClose: (changed: boolean) => void }) {
  const { api } = ctx.platform
  const [form, setForm] = useState(() => ({
    name: contact?.name ?? '',
    organisation: contact?.organisation ?? '',
    role: contact?.role ?? '',
    category: contact?.category ?? ('family' as Category),
    phones: contact?.phones.length ? contact.phones : [{ label: 'mobile' as PhoneLabel, number: '' }],
    emails: contact?.emails.length ? contact.emails : [''],
    address: contact?.address ?? '',
    note: contact?.note ?? '',
  }))
  const [exporting, setExporting] = useState(false)
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))
  const save = useAction(async () => {
    const body = { ...form, phones: form.phones.filter((p) => p.number.trim()), emails: form.emails.filter((e) => e.trim()) }
    try {
      if (contact) await api.request('PUT', `/api/contacts/${contact.id}`, { ...body, baseVersion: contact.version })
      else await api.post('/api/contacts', body)
    } catch (e) {
      if (e instanceof ApiError && e.code === 'edit_conflict') throw new Error(`${e.message} Your changes were not saved.`)
      throw e
    }
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!contact || !window.confirm(`Delete ${contact.name}? They are also removed as anyone’s emergency contact.`)) return
    await api.del(`/api/contacts/${contact.id}`)
    onClose(true)
  })
  if (exporting && contact) return <ExportDialog ctx={ctx} contact={contact} onClose={() => setExporting(false)} />
  return (
    <Dialog open title={contact ? `Edit ${contact.name}` : 'Add a contact'} onClose={() => onClose(false)}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save.run()
        }}
      >
        <Field label="Name" value={form.name} onChange={(e) => set('name', e.target.value)} required maxLength={100} autoComplete="off" />
        <Field label="Organisation" placeholder="e.g. Ballito Primary, Discovery Health" value={form.organisation} onChange={(e) => set('organisation', e.target.value)} maxLength={100} autoComplete="off" />
        <Field label="Role" placeholder="e.g. Grade 3 teacher, GP, plumber" value={form.role} onChange={(e) => set('role', e.target.value)} maxLength={100} autoComplete="off" />
        <div className="field">
          <label htmlFor="contact-category">Category</label>
          <select id="contact-category" className="select" value={form.category} onChange={(e) => set('category', e.target.value as Category)}>
            {Object.entries(CATEGORIES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="radio-group">
          <legend>Phone numbers</legend>
          {form.phones.map((p, i) => (
            <div key={i} className="row">
              <select className="select select-small" aria-label={`Phone ${i + 1} kind`} value={p.label} onChange={(e) => set('phones', form.phones.map((x, j) => (j === i ? { ...x, label: e.target.value as PhoneLabel } : x)))}>
                {Object.entries(PHONE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <input className="qi-search" aria-label={`Phone ${i + 1}`} inputMode="tel" placeholder="+27 82 123 4567" value={p.number} onChange={(e) => set('phones', form.phones.map((x, j) => (j === i ? { ...x, number: e.target.value } : x)))} />
            </div>
          ))}
          {form.phones.length < 5 && (
            <Button type="button" variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => set('phones', [...form.phones, { label: 'mobile', number: '' }])}>
              Another number
            </Button>
          )}
        </fieldset>
        <fieldset className="radio-group">
          <legend>Email</legend>
          {form.emails.map((e, i) => (
            <input key={i} className="qi-search" aria-label={`Email ${i + 1}`} type="email" value={e} onChange={(ev) => set('emails', form.emails.map((x, j) => (j === i ? ev.target.value : x)))} />
          ))}
          {form.emails.length < 3 && (
            <Button type="button" variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => set('emails', [...form.emails, ''])}>
              Another email
            </Button>
          )}
        </fieldset>
        <div className="field">
          <label htmlFor="contact-address">Address</label>
          <textarea id="contact-address" className="textarea" rows={2} value={form.address} onChange={(e) => set('address', e.target.value)} maxLength={400} />
        </div>
        <div className="field">
          <label htmlFor="contact-note">Shared note</label>
          <textarea id="contact-note" className="textarea" rows={3} placeholder="Only parents see this. Left out of exports unless you choose otherwise." value={form.note} onChange={(e) => set('note', e.target.value)} maxLength={2000} />
        </div>
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <div className="row">
          <Button type="submit" busy={save.busy}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
          {contact && (
            <>
              <Button type="button" variant="secondary" icon={<Download size={16} aria-hidden />} onClick={() => setExporting(true)}>
                Export
              </Button>
              <Button type="button" variant="danger" busy={remove.busy} icon={<Trash2 size={16} aria-hidden />} onClick={() => void remove.run()}>
                Delete
              </Button>
            </>
          )}
        </div>
      </form>
    </Dialog>
  )
}
