/**
 * Getting people in and out of Contacts (phase 3): vCard import with a
 * preview, exports (vCard, a birthdays calendar, address labels) for everyone
 * or one group, and managing groups.
 */
import { Download, FileUp, Pencil, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { Api } from '../api.ts'
import { saveFromApi } from '../download.ts'
import type { Platform } from '../platform.ts'
import { Badge, Banner, Button, Dialog, useAction } from '../ui.tsx'

export interface Group {
  id: string
  name: string
}

type Format = 'vcf' | 'ics' | 'csv'

export function ExportDialog({ platform, groups, contact, onClose }: { platform: Platform; groups: Group[]; contact?: { id: string; name: string }; onClose: () => void }) {
  const [notes, setNotes] = useState(false)
  const [scope, setScope] = useState('all')
  const [format, setFormat] = useState<Format>('vcf')
  const save = useAction(async () => {
    if (contact) {
      await saveFromApi(platform, `/api/contacts/export/${contact.id}${notes ? '-notes' : ''}.vcf`, `${contact.name}.vcf`)
    } else {
      const which = scope === 'all' ? 'all' : `group-${scope}`
      const label = scope === 'all' ? 'family-contacts' : (groups.find((g) => g.id === scope)?.name ?? 'contacts')
      const file = format === 'vcf' ? `${which}${notes ? '-notes' : ''}.vcf` : format === 'ics' ? `${which}-dates.ics` : `${which}-labels.csv`
      const name = format === 'vcf' ? `${label}.vcf` : format === 'ics' ? `${label} dates.ics` : `${label} addresses.csv`
      await saveFromApi(platform, `/api/contacts/export/${file}`, name)
    }
    onClose()
  })
  return (
    <Dialog open title={contact ? `Export ${contact.name}` : 'Export'} onClose={onClose}>
      <div className="stack">
        {!contact && (
          <>
            {groups.length > 0 && (
              <div className="field">
                <label htmlFor="export-scope">Who</label>
                <select id="export-scope" className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
                  <option value="all">Everyone</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>
                      Group: {g.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <fieldset className="radio-group">
              <legend>What</legend>
              <label className="check">
                <input type="radio" name="export-format" checked={format === 'vcf'} onChange={() => setFormat('vcf')} />
                <span>Contacts (.vcf) for phones, Google Contacts and Outlook, with birthdays and family</span>
              </label>
              <label className="check">
                <input type="radio" name="export-format" checked={format === 'ics'} onChange={() => setFormat('ics')} />
                <span>Birthdays and anniversaries (.ics) as yearly events for any calendar app</span>
              </label>
              <label className="check">
                <input type="radio" name="export-format" checked={format === 'csv'} onChange={() => setFormat('csv')} />
                <span>Address labels (.csv): names and postal addresses, for printing</span>
              </label>
            </fieldset>
          </>
        )}
        {contact && <p>Saves a vCard (.vcf) file, with their birthday and family, that phones, Google Contacts and Outlook can import.</p>}
        {(contact || format === 'vcf') && (
          <label className="check">
            <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} />
            <span>Include the shared notes (they are left out unless you tick this)</span>
          </label>
        )}
        <p className="muted small">Notes on the timeline and gift ideas are never exported.</p>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <div className="row">
          <Button busy={save.busy} icon={<Download size={16} aria-hidden />} onClick={() => void save.run()}>
            Save file
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

interface Preview {
  name: string
  organisation: string
  phones: { number: string }[]
  emails: string[]
  dates: { kind: string; date: string }[]
  related: { name: string }[]
  duplicateOf: string | null
  duplicateName: string | null
}

const CATEGORY_CHOICES: Record<string, string> = { family: 'Family', friend: 'Friends', school: 'School', health: 'Health', insurance: 'Insurance & finance', services: 'Services & trades', other: 'Other' }

export function ImportDialog({ api, groups, onClose }: { api: Api; groups: Group[]; onClose: (changed: boolean) => void }) {
  const [preview, setPreview] = useState<Preview[] | null>(null)
  const [chosen, setChosen] = useState<Set<number>>(new Set())
  const [category, setCategory] = useState('friend')
  const [groupId, setGroupId] = useState('')
  const [result, setResult] = useState<{ added: number; links: number; skipped: { name: string; reason: string }[] } | null>(null)

  const read = useAction(async (file: File) => {
    if (file.size > 5 * 1024 * 1024) throw new Error('That file is too big (over 5 MB).')
    const vcf = await file.text()
    const r = await api.post<{ contacts: Preview[] }>('/api/contacts/import/preview', { vcf })
    setPreview(r.contacts)
    // People who look like existing contacts are left out unless chosen.
    setChosen(new Set(r.contacts.flatMap((c, i) => (c.duplicateOf ? [] : [i]))))
  })
  const add = useAction(async () => {
    if (!preview) return
    const contacts = preview.filter((_, i) => chosen.has(i))
    if (contacts.length === 0) throw new Error('Tick who to add.')
    setResult(await api.post('/api/contacts/import', { contacts, category, groupId: groupId || null }))
  })
  const toggle = (i: number) => setChosen((s) => (s.has(i) ? new Set([...s].filter((x) => x !== i)) : new Set([...s, i])))

  if (result) {
    return (
      <Dialog open title="Import" onClose={() => onClose(true)}>
        <div className="stack">
          <Banner kind="success">
            Added {result.added} {result.added === 1 ? 'person' : 'people'}
            {result.links > 0 && `, and linked ${result.links} ${result.links === 1 ? 'relationship' : 'relationships'}`}.
          </Banner>
          {result.skipped.length > 0 && (
            <Banner kind="warning">
              Not added: {result.skipped.map((s) => `${s.name} (${s.reason})`).join('; ')}
            </Banner>
          )}
          <Button onClick={() => onClose(true)}>Done</Button>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog open title="Import contacts" onClose={() => onClose(false)}>
      <div className="stack">
        {!preview && (
          <>
            <p>
              Choose a vCard (.vcf) file: exported from Google Contacts, your phone’s contacts app, Apple Contacts or Monica. Birthdays, anniversaries and family names come
              with them. You see everyone before anything is added; the file itself is not kept.
            </p>
            <label className="btn btn-primary file-pick">
              <FileUp size={16} aria-hidden />
              <span>{read.busy ? 'Reading…' : 'Choose a .vcf file'}</span>
              <input
                type="file"
                accept=".vcf,text/vcard,text/x-vcard"
                aria-label="vCard file"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void read.run(f)
                }}
              />
            </label>
          </>
        )}
        {preview && (
          <>
            <p>
              {preview.length} {preview.length === 1 ? 'person' : 'people'} in the file. Untick anyone you do not want; people who look like someone already in Contacts are unticked.
            </p>
            <div className="row">
              <Button variant="ghost" onClick={() => setChosen(new Set(preview.map((_, i) => i)))}>
                Tick all
              </Button>
              <Button variant="ghost" onClick={() => setChosen(new Set())}>
                Untick all
              </Button>
            </div>
            <ul className="import-list">
              {preview.map((c, i) => (
                <li key={i}>
                  <label className="check">
                    <input type="checkbox" checked={chosen.has(i)} onChange={() => toggle(i)} aria-label={`Add ${c.name}`} />
                    <span>
                      <strong>{c.name}</strong>
                      {c.organisation && c.organisation !== c.name && <span className="muted"> · {c.organisation}</span>}
                      <span className="muted small">
                        {' '}
                        {[c.phones.length && `${c.phones.length} phone`, c.emails.length && `${c.emails.length} email`, c.dates.length && `${c.dates.length} date`, c.related.length && `${c.related.length} family`]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {c.duplicateName && <Badge tone="warning">Looks like {c.duplicateName}</Badge>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <div className="row">
              <div className="field">
                <label htmlFor="import-category">Category</label>
                <select id="import-category" className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
                  {Object.entries(CATEGORY_CHOICES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
              {groups.length > 0 && (
                <div className="field">
                  <label htmlFor="import-group">Add to group</label>
                  <select id="import-group" className="select" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                    <option value="">None</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <p className="muted small">Birthdays get a reminder a week before; other dates are added without reminders. Family names are linked when they match someone in Contacts.</p>
          </>
        )}
        {(read.error || add.error) && <Banner kind="error">{read.error || add.error}</Banner>}
        <div className="row">
          {preview && (
            <Button busy={add.busy} onClick={() => void add.run()}>
              Add {chosen.size} {chosen.size === 1 ? 'person' : 'people'}
            </Button>
          )}
          <Button variant="ghost" onClick={() => onClose(false)}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function GroupsDialog({ api, groups, onChanged, onClose }: { api: Api; groups: Group[]; onChanged: () => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null)
  const create = useAction(async () => {
    await api.post('/api/contacts/groups', { name })
    setName('')
    onChanged()
  })
  const rename = useAction(async () => {
    if (!renaming) return
    await api.request('PUT', `/api/contacts/groups/${renaming.id}`, { name: renaming.name })
    setRenaming(null)
    onChanged()
  })
  const remove = useAction(async (g: Group) => {
    if (!window.confirm(`Delete the group “${g.name}”? The people in it stay in Contacts.`)) return
    await api.del(`/api/contacts/groups/${g.id}`)
    onChanged()
  })
  return (
    <Dialog open title="Groups" onClose={onClose}>
      <div className="stack">
        <p className="muted">Groups such as “Book club”, “School parents” or “Christmas card list”. Filter and export by group; add people to groups when editing them.</p>
        {groups.length > 0 && (
          <ul className="item-list">
            {groups.map((g) => (
              <li key={g.id}>
                {renaming?.id === g.id ? (
                  <form
                    className="row grow"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void rename.run()
                    }}
                  >
                    <input className="qi-search" aria-label="Group name" value={renaming.name} maxLength={60} onChange={(e) => setRenaming({ id: g.id, name: e.target.value })} />
                    <Button type="submit" busy={rename.busy}>
                      Save
                    </Button>
                  </form>
                ) : (
                  <>
                    <div className="item-main">{g.name}</div>
                    <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Rename ${g.name}`} onClick={() => setRenaming(g)} />
                    <Button variant="ghost" icon={<Trash2 size={16} aria-hidden />} aria-label={`Delete ${g.name}`} onClick={() => void remove.run(g)} />
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault()
            void create.run()
          }}
        >
          <input className="qi-search" aria-label="New group name" placeholder="New group, e.g. Christmas card list" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          <Button type="submit" icon={<Plus size={16} aria-hidden />} busy={create.busy} disabled={!name.trim()}>
            Add group
          </Button>
        </form>
        {(create.error || rename.error || remove.error) && <Banner kind="error">{create.error || rename.error || remove.error}</Banner>}
        <div className="row">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
