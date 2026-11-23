/**
 * Outside calendars (phase 4c), for parents: the Calendar inbox (accept or
 * ignore events from subscriptions and imports), subscriptions by link, a
 * one-off .ics import, and South African public holidays on or off.
 */
import { Check, FileUp, Home, Inbox, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { timeAgo } from '../format.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Dialog, Field, Spinner, useAction, useLoad } from '../ui.tsx'
import { colourOf, dayOf, FAMILY, formatDay, whenText, type Person } from './model.ts'

export interface InboxItem {
  id: string
  subscriptionId: string | null
  source: string
  status: 'new' | 'changed' | 'cancelled'
  defaultTags: string[]
  event: { title: string; allDay: boolean; start: string; end: string; location: string; notes: string }
}

interface Sub {
  id: string
  name: string
  host: string
  tags: string[]
  autoAccept: boolean
  lastFetchAt: number | null
  lastOkAt: number | null
  lastError: string | null
}

function TagPicker({ people, value, onChange }: { people: Person[]; value: string[]; onChange: (tags: string[]) => void }) {
  const toggle = (t: string) => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t])
  return (
    <div className="row" role="group" aria-label="Tags">
      <button type="button" className={`chip ${value.includes(FAMILY) ? 'chip-on' : ''}`} aria-pressed={value.includes(FAMILY)} onClick={() => toggle(FAMILY)}>
        <Home size={14} aria-hidden /> Family
      </button>
      {people.map((p) => (
        <button key={p.id} type="button" className={`chip ${value.includes(p.id) ? 'chip-on' : ''}`} aria-pressed={value.includes(p.id)} onClick={() => toggle(p.id)}>
          <span className="tag-dot" style={{ ['--tag' as string]: colourOf(people, p.id) }} aria-hidden /> {p.displayName}
        </button>
      ))}
    </div>
  )
}

const STATUS: Record<InboxItem['status'], { label: string; tone: 'accent' | 'warning' | 'neutral' }> = {
  new: { label: 'New', tone: 'accent' },
  changed: { label: 'Changed', tone: 'warning' },
  cancelled: { label: 'Cancelled', tone: 'warning' },
}

export function InboxDialog({ ctx, people, onClose }: { ctx: HubContext; people: Person[]; onClose: (changed: boolean) => void }) {
  const { api } = ctx.platform
  const [items, setItems] = useState<InboxItem[] | null>(null)
  const [tags, setTags] = useState<Record<string, string[]>>({})
  const [changed, setChanged] = useState(false)
  const load = useLoad(async () => {
    const r = await api.get<{ items: InboxItem[] }>('/api/calendar/inbox')
    setItems(r.items)
    return r
  }, [api])
  const act = useAction(async (path: string, body: unknown = {}) => {
    const r = await api.post<{ items: InboxItem[] }>(path, body)
    setItems(r.items)
    setChanged(true)
  })
  const list = items ?? []
  return (
    <Dialog open title="Calendar inbox" onClose={() => onClose(changed)}>
      <div className="stack">
        <p className="muted">Events from outside calendars and imports wait here. Nothing is added to the family calendar until you accept it.</p>
        {!items && !load.error && <Spinner />}
        {items && list.length === 0 && <p>Nothing waiting.</p>}
        {list.length > 1 && (
          <div className="row">
            <Button variant="secondary" icon={<Check size={16} aria-hidden />} busy={act.busy} onClick={() => void act.run('/api/calendar/inbox/all', { action: 'accept' })}>
              Accept all {list.length}
            </Button>
            <Button variant="ghost" icon={<X size={16} aria-hidden />} busy={act.busy} onClick={() => void act.run('/api/calendar/inbox/all', { action: 'ignore' })}>
              Ignore all
            </Button>
          </div>
        )}
        <ul className="item-list inbox-list">
          {list.map((i) => (
            <li key={i.id} className="stack-sm">
              <div className="item-main">
                <div>
                  <strong>{i.event.title}</strong> <Badge tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Badge>
                </div>
                <div className="muted small">
                  {formatDay(dayOf(i.event.start), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}, {whenText(i.event)}
                  {i.event.location && ` · ${i.event.location}`} · from {i.source}
                </div>
                {i.status === 'changed' && <div className="small">Accepting updates the event here; ignoring keeps yours as it is.</div>}
                {i.status === 'cancelled' && <div className="small">Cancelled at the source. Accepting removes it here; ignoring keeps it.</div>}
              </div>
              {i.status === 'new' && <TagPicker people={people} value={tags[i.id] ?? i.defaultTags} onChange={(t) => setTags({ ...tags, [i.id]: t })} />}
              <div className="row">
                <Button
                  icon={<Check size={16} aria-hidden />}
                  busy={act.busy}
                  aria-label={`Accept ${i.event.title}`}
                  onClick={() => void act.run(`/api/calendar/inbox/${i.id}/accept`, i.status === 'new' ? { tags: tags[i.id] ?? i.defaultTags } : {})}
                >
                  {i.status === 'cancelled' ? 'Remove it' : 'Accept'}
                </Button>
                <Button variant="ghost" busy={act.busy} aria-label={`Ignore ${i.event.title}`} onClick={() => void act.run(`/api/calendar/inbox/${i.id}/ignore`)}>
                  {i.status === 'new' ? 'Ignore' : 'Keep ours'}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {(load.error || act.error) && <Banner kind="error">{load.error || act.error}</Banner>}
        <div className="row">
          <Button variant="ghost" onClick={() => onClose(changed)}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

export function OutsideDialog({ ctx, people, onClose }: { ctx: HubContext; people: Person[]; onClose: (changed: boolean) => void }) {
  const { api } = ctx.platform
  const subs = useLoad(() => api.get<{ subscriptions: Sub[] }>('/api/calendar/subscriptions'), [api])
  const settings = useLoad(() => api.get<{ holidays: boolean }>('/api/calendar/settings'), [api])
  const [form, setForm] = useState({ name: '', url: '', tags: [FAMILY], autoAccept: false })
  const [message, setMessage] = useState('')
  const [changed, setChanged] = useState(false)

  const add = useAction(async () => {
    const r = await api.post<{ subscription: Sub; added: number }>('/api/calendar/subscriptions', form)
    setForm({ name: '', url: '', tags: [FAMILY], autoAccept: false })
    setMessage(r.subscription.lastError ? `Saved, but: ${r.subscription.lastError}` : form.autoAccept ? 'Subscribed: its events are on the calendar.' : `Subscribed: ${r.added} ${r.added === 1 ? 'event is' : 'events are'} waiting in the inbox.`)
    setChanged(true)
    subs.reload()
  })
  const refresh = useAction(async (s: Sub) => {
    const r = await api.post<{ subscription: Sub; added: number }>(`/api/calendar/subscriptions/${s.id}/refresh`)
    setMessage(r.subscription.lastError ? r.subscription.lastError : `${s.name}: ${r.added} new or changed in the inbox.`)
    setChanged(true)
    subs.reload()
  })
  const toggleAuto = useAction(async (s: Sub) => {
    await api.request('PUT', `/api/calendar/subscriptions/${s.id}`, { autoAccept: !s.autoAccept })
    subs.reload()
  })
  const remove = useAction(async (s: Sub) => {
    if (!window.confirm(`Stop following “${s.name}”?`)) return
    const events = window.confirm(`Also remove the events accepted from “${s.name}”? (Cancel keeps them.)`)
    await api.del(`/api/calendar/subscriptions/${s.id}${events ? '?removeEvents=1' : ''}`)
    setChanged(true)
    subs.reload()
  })
  const holidays = useAction(async (on: boolean) => {
    await api.request('PUT', '/api/calendar/settings', { holidays: on })
    setChanged(true)
    settings.reload()
  })
  const importFile = useAction(async (file: File) => {
    if (file.size > 5 * 1024 * 1024) throw new Error('That file is too big (over 5 MB).')
    const r = await api.post<{ added: number; skipped: number }>('/api/calendar/import', { ics: await file.text() })
    setMessage(`${r.added} ${r.added === 1 ? 'event is' : 'events are'} waiting in the inbox${r.skipped ? ` (${r.skipped} past, cancelled or already here were left out)` : ''}.`)
    setChanged(true)
  })
  const error = subs.error || settings.error || add.error || refresh.error || toggleAuto.error || remove.error || holidays.error || importFile.error

  return (
    <Dialog open title="Outside calendars" onClose={() => onClose(changed)}>
      <div className="stack">
        {settings.data && (
          <label className="check">
            <input type="checkbox" checked={settings.data.holidays} onChange={(e) => void holidays.run(e.target.checked)} />
            <span>Show South African public holidays (worked out by the hub; tagged Family)</span>
          </label>
        )}

        <fieldset className="radio-group">
          <legend>Calendars you follow</legend>
          {subs.data?.subscriptions.length === 0 && <p className="muted small">None yet. Add a school, club or other calendar by its link.</p>}
          <ul className="item-list">
            {subs.data?.subscriptions.map((s) => (
              <li key={s.id}>
                <div className="item-main">
                  <div>
                    {s.name} <span className="muted small">· {s.host}</span>
                  </div>
                  <div className={`small ${s.lastError ? 'field-error' : 'muted'}`}>
                    {s.lastError ? `Last try failed: ${s.lastError}` : s.lastOkAt ? `Updated ${timeAgo(s.lastOkAt)}` : 'Not fetched yet'}
                  </div>
                  <label className="check small">
                    <input type="checkbox" checked={s.autoAccept} onChange={() => void toggleAuto.run(s)} />
                    <span>Always accept from this calendar</span>
                  </label>
                </div>
                <Button variant="ghost" icon={<RefreshCw size={16} aria-hidden />} aria-label={`Refresh ${s.name}`} busy={refresh.busy} onClick={() => void refresh.run(s)} />
                <Button variant="ghost" icon={<Trash2 size={16} aria-hidden />} aria-label={`Stop following ${s.name}`} onClick={() => void remove.run(s)} />
              </li>
            ))}
          </ul>
        </fieldset>

        <form
          className="stack-sm date-entry"
          onSubmit={(e) => {
            e.preventDefault()
            void add.run()
          }}
        >
          <strong>Follow a calendar</strong>
          <Field label="Name" placeholder="e.g. Ballito Primary terms" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} />
          <Field
            label="Link (https:// or webcal://)"
            placeholder="https://…/calendar.ics"
            value={form.url}
            onChange={(e) => setForm({ ...form, url: e.target.value })}
            required
            hint="Kept encrypted: some links contain a private key. The hub checks it every 6 hours."
          />
          <div className="field">
            <span className="small">Tag its events</span>
            <TagPicker people={people} value={form.tags} onChange={(tags) => setForm({ ...form, tags })} />
          </div>
          <label className="check">
            <input type="checkbox" checked={form.autoAccept} onChange={(e) => setForm({ ...form, autoAccept: e.target.checked })} />
            <span>Always accept (skip the inbox): only for calendars you trust</span>
          </label>
          <Button type="submit" icon={<Plus size={16} aria-hidden />} busy={add.busy} disabled={!form.name.trim() || !form.url.trim() || form.tags.length === 0}>
            Follow
          </Button>
        </form>

        <div className="stack-sm">
          <strong>Import a file once</strong>
          <p className="muted small">An .ics file (e.g. exported from Google Calendar). Its events go to the inbox; the file is not kept.</p>
          <label className="btn btn-secondary file-pick">
            <FileUp size={16} aria-hidden />
            <span>{importFile.busy ? 'Reading…' : 'Choose an .ics file'}</span>
            <input
              type="file"
              accept=".ics,text/calendar"
              aria-label="Calendar file"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void importFile.run(f)
              }}
            />
          </label>
        </div>
        {message && <Banner kind="success">{message}</Banner>}
        {error && <Banner kind="error">{error}</Banner>}
        <div className="row">
          <Button variant="ghost" onClick={() => onClose(changed)}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** The inbox button, with how many are waiting (parents only). */
export function InboxButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <Button variant={count ? 'primary' : 'ghost'} icon={<Inbox size={16} aria-hidden />} onClick={onClick}>
      Inbox{count ? ` (${count})` : ''}
    </Button>
  )
}
