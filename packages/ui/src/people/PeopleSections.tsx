/**
 * The people-and-dates parts of a contact (phase 3): important dates with
 * their reminders, "about them", and family and other relationships.
 */
import { Pencil, Plus, Trash2, UserPlus, X } from 'lucide-react'
import { useState } from 'react'
import type { Api } from '../api.ts'
import { Banner, Button, useAction } from '../ui.tsx'
import {
  DATE_KINDS,
  formatImportantDate,
  MONTHS,
  RELATION_LABELS,
  REMIND_LABELS,
  joinDate,
  relativesOf,
  splitDate,
  type DateKind,
  type ImportantDate,
  type Relation,
  type RelationKind,
  type Remind,
} from './dates.ts'

export interface Parent {
  id: string
  displayName: string
}

export interface About {
  howWeMet: string
  interests: string
  food: string
  sizes: string
}

export const emptyAbout = (): About => ({ howWeMet: '', interests: '', food: '', sizes: '' })

/** Day, month and an optional year. */
function DayMonthYear({ value, onChange, label }: { value: string; onChange: (date: string) => void; label: string }) {
  const { year, month, day } = splitDate(value)
  // What is typed in the year box, kept while it is not yet four digits.
  const [yearText, setYearText] = useState(year)
  const fullYear = (y: string) => (/^\d{4}$/.test(y) ? y : '')
  const set = (y: string, m: number, d: number) => onChange(joinDate(fullYear(y), m || 1, d || 1))
  return (
    <div className="row date-row" role="group" aria-label={label}>
      <select className="select select-small" aria-label={`${label}: day`} value={day || 1} onChange={(e) => set(yearText, month, Number(e.target.value))}>
        {Array.from({ length: 31 }, (_, i) => (
          <option key={i + 1} value={i + 1}>
            {i + 1}
          </option>
        ))}
      </select>
      <select className="select select-small" aria-label={`${label}: month`} value={month || 1} onChange={(e) => set(yearText, Number(e.target.value), day)}>
        {MONTHS.map((m, i) => (
          <option key={m} value={i + 1}>
            {m}
          </option>
        ))}
      </select>
      <input
        className="qi-search year-input"
        aria-label={`${label}: year (optional)`}
        inputMode="numeric"
        placeholder="Year (optional)"
        maxLength={4}
        value={yearText}
        onChange={(e) => {
          const y = e.target.value.replace(/\D/g, '').slice(0, 4)
          setYearText(y)
          set(y, month, day)
        }}
      />
    </div>
  )
}

export function DatesEditor({ dates, onChange, parents }: { dates: ImportantDate[]; onChange: (dates: ImportantDate[]) => void; parents: Parent[] }) {
  const update = (i: number, change: Partial<ImportantDate>) => onChange(dates.map((d, j) => (j === i ? { ...d, ...change } : d)))
  return (
    <fieldset className="radio-group">
      <legend>Important dates</legend>
      {dates.length === 0 && <p className="muted small">Birthdays, anniversaries and other dates, with reminders. The year is optional.</p>}
      {dates.map((d, i) => (
        <div key={d.id ?? i} className="date-entry stack-sm">
          <div className="row">
            <select className="select select-small" aria-label={`Date ${i + 1} kind`} value={d.kind} onChange={(e) => update(i, { kind: e.target.value as DateKind })}>
              {Object.entries(DATE_KINDS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            {d.kind === 'other' && (
              <input className="qi-search" aria-label={`Date ${i + 1} name`} placeholder="e.g. Name day" maxLength={60} value={d.label} onChange={(e) => update(i, { label: e.target.value })} />
            )}
            <Button type="button" variant="ghost" icon={<Trash2 size={16} aria-hidden />} aria-label={`Remove date ${i + 1}`} onClick={() => onChange(dates.filter((_, j) => j !== i))} />
          </div>
          <DayMonthYear label={`Date ${i + 1}`} value={d.date} onChange={(date) => update(i, { date })} />
          <div className="row">
            <select className="select" aria-label={`Date ${i + 1} reminder`} value={d.remind} onChange={(e) => update(i, { remind: e.target.value as Remind })}>
              {Object.entries(REMIND_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            {d.remind !== 'off' && parents.length > 1 && (
              <select className="select" aria-label={`Date ${i + 1} reminder for`} value={d.remindFor} onChange={(e) => update(i, { remindFor: e.target.value })}>
                <option value="all">For both of us</option>
                {parents.map((p) => (
                  <option key={p.id} value={p.id}>
                    Only {p.displayName}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
      ))}
      {dates.length < 10 && (
        <Button
          type="button"
          variant="ghost"
          icon={<Plus size={16} aria-hidden />}
          onClick={() => onChange([...dates, { kind: dates.some((d) => d.kind === 'birthday') ? 'anniversary' : 'birthday', label: '', date: '--01-01', remind: 'week', remindFor: 'all' }])}
        >
          Add a date
        </Button>
      )}
    </fieldset>
  )
}

export function AboutEditor({ about, onChange }: { about: About; onChange: (about: About) => void }) {
  const [open, setOpen] = useState(() => Object.values(about).some(Boolean))
  if (!open) {
    return (
      <Button type="button" variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => setOpen(true)}>
        About them (how you met, interests, food, sizes)
      </Button>
    )
  }
  const field = (key: keyof About, label: string, placeholder: string, max: number) => (
    <div className="field">
      <label htmlFor={`about-${key}`}>{label}</label>
      <textarea id={`about-${key}`} className="textarea" rows={2} maxLength={max} placeholder={placeholder} value={about[key]} onChange={(e) => onChange({ ...about, [key]: e.target.value })} />
    </div>
  )
  return (
    <fieldset className="radio-group">
      <legend>About them</legend>
      {field('howWeMet', 'How we know them', 'e.g. University friends; Thandi’s godmother', 500)}
      {field('interests', 'Interests', 'e.g. Hiking, Liverpool FC, gardening', 500)}
      {field('food', 'Food and drink', 'e.g. Vegetarian; allergic to nuts; likes red wine', 500)}
      {field('sizes', 'Clothing and shoe sizes', 'e.g. Age 7–8, shoe 13', 300)}
    </fieldset>
  )
}

export interface Member {
  id: string
  name: string
  date: string | null
  remind: string
  remindFor: string
  alsoOf: string | null
}

interface Named {
  id: string
  name: string
  category: string
  members: Member[]
}

/** For an existing contact: their family and other relationships, with quick add. */
export function RelativesSection({
  api,
  contact,
  contacts,
  relations,
  onChanged,
  onOpen,
}: {
  api: Api
  contact: Named
  contacts: Named[]
  relations: Relation[]
  onChanged: () => void
  onOpen: (id: string) => void
}) {
  const relatives = relativesOf(contact.id, relations)
  const byId = new Map(contacts.map((c) => [c.id, c]))
  const [adding, setAdding] = useState<null | 'link' | 'child' | 'partner'>(null)
  const [kind, setKind] = useState<RelationKind>('child')
  const [label, setLabel] = useState('')
  const [other, setOther] = useState('')
  const [name, setName] = useState('')
  const [birthday, setBirthday] = useState('--01-01')
  const [knowBirthday, setKnowBirthday] = useState(true)

  const remove = useAction(async (id: string) => {
    await api.del(`/api/contacts/relations/${id}`)
    onChanged()
  })
  const link = useAction(async () => {
    if (!other) throw new Error('Choose who.')
    // "<other> is <contact>'s <kind>"
    await api.post('/api/contacts/relations', { a: other, b: contact.id, kind, label })
    setAdding(null)
    setOther('')
    setLabel('')
    onChanged()
  })
  // Partners of this contact: a child added here can be shown under them too.
  const partners = relatives.filter((r) => r.relation.kind === 'partner').map((r) => byId.get(r.other)).filter((c): c is Named => !!c)
  const [alsoOf, setAlsoOf] = useState(true)
  const [editingMember, setEditingMember] = useState<Member | null>(null)
  const quickAdd = useAction(async (as: 'child' | 'partner') => {
    if (!name.trim()) throw new Error('Type their name.')
    if (as === 'child') {
      // A child is kept on this contact (not a contact of their own), with their birthday.
      await api.post(`/api/contacts/${contact.id}/members`, {
        name: name.trim(),
        date: knowBirthday ? birthday : null,
        alsoOf: alsoOf && partners[0] ? partners[0].id : null,
      })
    } else {
      const created = await api.post<{ contact: { id: string } }>('/api/contacts', {
        name: name.trim(),
        category: contact.category === 'family' ? 'family' : contact.category === 'friend' ? 'friend' : 'other',
        dates: knowBirthday ? [{ kind: 'birthday', date: birthday, remind: 'week', remindFor: 'all' }] : [],
      })
      await api.post('/api/contacts/relations', { a: created.contact.id, b: contact.id, kind: as })
    }
    setAdding(null)
    setName('')
    setBirthday('--01-01')
    onChanged()
  })
  const saveMember = useAction(async () => {
    if (!editingMember) return
    const owner = contacts.find((c) => c.members.some((m) => m.id === editingMember.id))
    if (!owner) return
    await api.request('PUT', `/api/contacts/${owner.id}/members/${editingMember.id}`, editingMember)
    setEditingMember(null)
    onChanged()
  })
  const removeMember = useAction(async (owner: Named, m: Member) => {
    if (!window.confirm(`Remove ${m.name}? Their birthday reminders stop.`)) return
    await api.del(`/api/contacts/${owner.id}/members/${m.id}`)
    onChanged()
  })
  // Children kept here, and those kept on a partner's contact and shown here too.
  const children = [
    ...contact.members.map((m) => ({ m, owner: contact })),
    ...contacts.filter((c) => c.id !== contact.id).flatMap((c) => c.members.filter((m) => m.alsoOf === contact.id).map((m) => ({ m, owner: c }))),
  ]
  const candidates = contacts.filter((c) => c.id !== contact.id && !relatives.some((r) => r.other === c.id))
  const error = remove.error || link.error || quickAdd.error || saveMember.error || removeMember.error

  return (
    <fieldset className="radio-group">
      <legend>Family and relationships</legend>
      {relatives.length === 0 && children.length === 0 && <p className="muted small">Link partners, children, parents and friends to see who belongs with whom.</p>}
      {children.length > 0 && (
        <ul className="relatives">
          {children.map(({ m, owner }) =>
            editingMember?.id === m.id ? (
              <li key={m.id} className="date-entry">
                <input className="qi-search" aria-label="Child’s name" value={editingMember.name} maxLength={100} onChange={(e) => setEditingMember({ ...editingMember, name: e.target.value })} />
                <DayMonthYear label="Birthday" value={editingMember.date ?? '--01-01'} onChange={(date) => setEditingMember({ ...editingMember, date })} />
                <div className="row">
                  <Button type="button" busy={saveMember.busy} onClick={() => void saveMember.run()}>
                    Save
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setEditingMember(null)}>
                    Cancel
                  </Button>
                </div>
              </li>
            ) : (
              <li key={m.id}>
                <span className="muted small">Child</span>
                <span>
                  {m.name}
                  {m.date && <span className="muted small"> · {formatImportantDate(m.date)}</span>}
                  {owner.id !== contact.id && <span className="muted small"> · kept on {owner.name}</span>}
                </span>
                <span className="row">
                  <Button type="button" variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${m.name}`} onClick={() => setEditingMember(m)} />
                  <Button type="button" variant="ghost" icon={<X size={16} aria-hidden />} aria-label={`Remove ${m.name}`} onClick={() => void removeMember.run(owner, m)} />
                </span>
              </li>
            ),
          )}
        </ul>
      )}
      {relatives.length > 0 && (
        <ul className="relatives">
          {relatives.map((r) => (
            <li key={r.relation.id}>
              <span className="muted small">{r.label}</span>
              <button type="button" className="link" onClick={() => onOpen(r.other)}>
                {byId.get(r.other)?.name ?? 'Someone removed'}
              </button>
              <Button
                type="button"
                variant="ghost"
                icon={<X size={16} aria-hidden />}
                aria-label={`Unlink ${byId.get(r.other)?.name ?? 'them'}`}
                onClick={() => void remove.run(r.relation.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {adding === null && (
        <div className="row">
          <Button type="button" variant="ghost" icon={<UserPlus size={16} aria-hidden />} onClick={() => setAdding('child')}>
            Add a child
          </Button>
          <Button type="button" variant="ghost" icon={<UserPlus size={16} aria-hidden />} onClick={() => setAdding('partner')}>
            Add a partner
          </Button>
          {candidates.length > 0 && (
            <Button type="button" variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => setAdding('link')}>
              Link someone in Contacts
            </Button>
          )}
        </div>
      )}
      {(adding === 'child' || adding === 'partner') && (
        <div className="stack-sm date-entry">
          <input className="qi-search" aria-label={adding === 'child' ? 'Child’s name' : 'Partner’s name'} placeholder="Name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          <label className="check">
            <input type="checkbox" checked={knowBirthday} onChange={(e) => setKnowBirthday(e.target.checked)} />
            <span>I know their birthday</span>
          </label>
          {knowBirthday && <DayMonthYear label="Birthday" value={birthday} onChange={setBirthday} />}
          {adding === 'child' && partners[0] && (
            <label className="check">
              <input type="checkbox" checked={alsoOf} onChange={(e) => setAlsoOf(e.target.checked)} />
              <span>Also {partners[0].name}’s child (shown under both)</span>
            </label>
          )}
          {adding === 'child' && <p className="muted small">Kept on {contact.name}’s contact, not in the main list. Birthdays remind a week before.</p>}
          <div className="row">
            <Button type="button" busy={quickAdd.busy} onClick={() => void quickAdd.run(adding)}>
              Add {adding === 'child' ? 'child' : 'partner'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {adding === 'link' && (
        <div className="stack-sm date-entry">
          <div className="row">
            <select className="select" aria-label="Who" value={other} onChange={(e) => setOther(e.target.value)}>
              <option value="">Choose someone…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="muted small">is {contact.name}’s</span>
            <select className="select select-small" aria-label="Relationship" value={kind} onChange={(e) => setKind(e.target.value as RelationKind)}>
              {Object.entries(RELATION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.toLowerCase()}
                </option>
              ))}
            </select>
            {kind === 'other' && <input className="qi-search" aria-label="What relationship" placeholder="e.g. godmother" maxLength={40} value={label} onChange={(e) => setLabel(e.target.value)} />}
          </div>
          <div className="row">
            <Button type="button" busy={link.busy} onClick={() => void link.run()}>
              Link
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <Banner kind="error">{error}</Banner>}
    </fieldset>
  )
}
