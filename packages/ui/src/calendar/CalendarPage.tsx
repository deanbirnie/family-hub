/**
 * The family calendar (phase 4): events tagged by person (each with a colour)
 * or Family; my view, a person's view, or everyone's; month, week and agenda.
 * Everyone in the family sees, adds and edits every event. Events go out to
 * other calendar apps only as .ics files.
 */
import { CalendarDays, CalendarPlus, ChevronLeft, ChevronRight, Download, FileText, Home, MapPin, Palette, Pencil, Plus, Repeat as RepeatIcon, Trash2, User } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { ApiError } from '../api.ts'
import { saveFromApi } from '../download.ts'
import type { HubContext } from '../Shell.tsx'
import { Banner, Button, Card, Dialog, Field, PageHeader, Spinner, useAction, useLoad } from '../ui.tsx'
import {
  addDays,
  addMonths,
  colourOf,
  daysBetween,
  dayOf,
  FAMILY,
  FAMILY_COLOUR,
  formatDay,
  formatMonth,
  isOn,
  PALETTE,
  repeatText,
  shows,
  startOfMonth,
  startOfWeek,
  timeOf,
  today,
  WEEKDAY_SHORT,
  WEEKDAYS,
  whenText,
  weekdayIndex,
  type Occurrence,
  type Person,
  type Repeat,
  type ViewOf,
  type Weekday,
} from './model.ts'

type Layout = 'month' | 'week' | 'agenda'

const narrow = () => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 700px)').matches

export function usePeople(ctx: HubContext) {
  return useLoad(() => ctx.platform.api.get<{ people: Person[]; me: string | null }>('/api/calendar/people'), [ctx.platform.api])
}

/** A tag as a coloured chip. */
export function TagChip({ people, tag }: { people: Person[]; tag: string }) {
  const name = tag === FAMILY ? 'Family' : (people.find((p) => p.id === tag)?.displayName ?? 'Someone')
  return (
    <span className="tag-chip" style={{ ['--tag' as string]: colourOf(people, tag) }}>
      {tag === FAMILY ? <Home size={12} aria-hidden /> : <span className="tag-dot" aria-hidden />}
      {name}
    </span>
  )
}

/** The event's colour stripe: one band per tag. */
function stripe(people: Person[], tags: string[]) {
  const colours = tags.map((t) => colourOf(people, t))
  if (colours.length <= 1) return `linear-gradient(${colours[0] ?? FAMILY_COLOUR}, ${colours[0] ?? FAMILY_COLOUR})`
  const step = 100 / colours.length
  return `linear-gradient(${colours.map((c, i) => `${c} ${i * step}%, ${c} ${(i + 1) * step}%`).join(', ')})`
}

function EventPill({ o, people, onOpen }: { o: Occurrence; people: Person[]; onOpen: (o: Occurrence) => void }) {
  return (
    <button className="event-pill" style={{ ['--stripe' as string]: stripe(people, o.tags) }} onClick={() => onOpen(o)} title={`${o.title} · ${whenText(o)}`}>
      {!o.allDay && <span className="event-time">{timeOf(o.start)}</span>}
      <span className="event-title">{o.title}</span>
    </button>
  )
}

export function CalendarPage({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const people = usePeople(ctx)
  const [layout, setLayout] = useState<Layout>(() => (narrow() ? 'agenda' : 'month'))
  const [anchor, setAnchor] = useState(today())
  const [view, setView] = useState<ViewOf>({ kind: 'me' })
  const [viewing, setViewing] = useState<Occurrence | null>(null)
  const [editing, setEditing] = useState<{ occurrence: Occurrence | null; day: string } | null>(null)
  const [exporting, setExporting] = useState(false)
  const [colours, setColours] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)

  const range = useMemo(() => {
    if (layout === 'month') {
      const first = startOfWeek(startOfMonth(anchor))
      return { from: first, to: addDays(first, 41) }
    }
    if (layout === 'week') return { from: startOfWeek(anchor), to: addDays(startOfWeek(anchor), 6) }
    return { from: anchor, to: addDays(anchor, 59) }
  }, [layout, anchor])
  const events = useLoad(() => api.get<{ events: Occurrence[] }>(`/api/calendar/events?from=${range.from}&to=${range.to}`), [api, range.from, range.to])

  const list = people.data?.people ?? []
  const me = people.data?.me ?? null
  const shown = (events.data?.events ?? []).filter((o) => shows(view, me, o))
  const onDay = (day: string) => shown.filter((o) => isOn(o, day)).sort((a, b) => Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start))

  const move = (dir: -1 | 1) => setAnchor(layout === 'month' ? addMonths(anchor, dir) : layout === 'week' ? addDays(anchor, 7 * dir) : addDays(anchor, 60 * dir))
  const title = layout === 'month' ? formatMonth(anchor) : layout === 'week' ? `Week of ${formatDay(range.from, { day: 'numeric', month: 'long' })}` : `From ${formatDay(anchor, { day: 'numeric', month: 'long' })}`
  const reload = () => events.reload()

  return (
    <div className="page">
      <PageHeader
        title="Calendar"
        subtitle="The family’s plans, tagged by person. Everyone sees, adds and edits."
        actions={
          <div className="row">
            <Button icon={<Plus size={16} aria-hidden />} onClick={() => setEditing({ occurrence: null, day: selected ?? today() })}>
              New event
            </Button>
            <Button variant="secondary" icon={<Download size={16} aria-hidden />} onClick={() => setExporting(true)}>
              Send out
            </Button>
            {ctx.user.role === 'admin' && (
              <Button variant="ghost" icon={<Palette size={16} aria-hidden />} onClick={() => setColours(true)}>
                Colours
              </Button>
            )}
          </div>
        }
      />
      {people.data && (
        <div className="row chips" role="group" aria-label="Whose calendar">
          {me && (
            <button className={`chip ${view.kind === 'me' ? 'chip-on' : ''}`} aria-pressed={view.kind === 'me'} onClick={() => setView({ kind: 'me' })}>
              <User size={14} aria-hidden /> Mine
            </button>
          )}
          {list
            .filter((p) => p.id !== me)
            .map((p) => (
              <button
                key={p.id}
                className={`chip ${view.kind === 'person' && view.id === p.id ? 'chip-on' : ''}`}
                aria-pressed={view.kind === 'person' && view.id === p.id}
                onClick={() => setView({ kind: 'person', id: p.id })}
              >
                <span className="tag-dot" style={{ ['--tag' as string]: colourOf(list, p.id) }} aria-hidden /> {p.displayName}
              </button>
            ))}
          <button className={`chip ${view.kind === 'everyone' || (view.kind === 'me' && !me) ? 'chip-on' : ''}`} aria-pressed={view.kind === 'everyone'} onClick={() => setView({ kind: 'everyone' })}>
            Everyone
          </button>
        </div>
      )}
      {people.data && !me && list.length > 0 && view.kind === 'me' && (
        <p className="muted small">You are not one of the calendar’s people yet, so this shows Family events. A parent can link you in Quick Info (Add a person).</p>
      )}
      {people.data && list.length === 0 && (
        <Banner kind="info">Nobody to tag yet: a parent adds the family’s people in Quick Info (Add a person). Until then, events can be tagged Family.</Banner>
      )}

      <Card>
        <div className="row cal-toolbar">
          <div className="row" role="group" aria-label="Layout">
            {(['month', 'week', 'agenda'] as Layout[]).map((l) => (
              <button key={l} className={`chip ${layout === l ? 'chip-on' : ''}`} aria-pressed={layout === l} onClick={() => setLayout(l)}>
                {l === 'month' ? 'Month' : l === 'week' ? 'Week' : 'Agenda'}
              </button>
            ))}
          </div>
          <div className="row cal-nav">
            <Button variant="ghost" icon={<ChevronLeft size={18} aria-hidden />} aria-label="Earlier" onClick={() => move(-1)} />
            <Button variant="ghost" onClick={() => setAnchor(today())}>
              Today
            </Button>
            <Button variant="ghost" icon={<ChevronRight size={18} aria-hidden />} aria-label="Later" onClick={() => move(1)} />
            <strong className="cal-title">{title}</strong>
          </div>
        </div>
        {events.error && <Banner kind="error">{events.error}</Banner>}
        {!events.data && !events.error && <Spinner />}
        {events.data && people.data && layout === 'month' && (
          <MonthGrid anchor={anchor} from={range.from} onDay={onDay} people={list} selected={selected} onSelect={setSelected} onOpen={setViewing} />
        )}
        {events.data && people.data && layout === 'month' && selected && (
          <DayList day={selected} items={onDay(selected)} people={list} onOpen={setViewing} onAdd={() => setEditing({ occurrence: null, day: selected })} />
        )}
        {events.data && people.data && layout === 'week' && (
          <div className="cal-week">
            {Array.from({ length: 7 }, (_, i) => addDays(range.from, i)).map((day) => (
              <DayList key={day} day={day} items={onDay(day)} people={list} onOpen={setViewing} onAdd={() => setEditing({ occurrence: null, day })} compact />
            ))}
          </div>
        )}
        {events.data && people.data && layout === 'agenda' && (
          <div className="cal-agenda">
            {Array.from({ length: 60 }, (_, i) => addDays(range.from, i))
              .filter((day) => onDay(day).length > 0)
              .map((day) => (
                <DayList key={day} day={day} items={onDay(day)} people={list} onOpen={setViewing} />
              ))}
            {shown.length === 0 && <p className="muted">Nothing in the next 60 days{view.kind === 'everyone' ? '' : ' in this view'}.</p>}
          </div>
        )}
      </Card>

      {viewing && people.data && (
        <EventView
          ctx={ctx}
          o={viewing}
          people={list}
          onClose={() => setViewing(null)}
          onEdit={() => {
            setEditing({ occurrence: viewing, day: viewing.day })
            setViewing(null)
          }}
          onChanged={() => {
            setViewing(null)
            reload()
          }}
        />
      )}
      {editing && people.data && (
        <EventEditor
          ctx={ctx}
          people={list}
          me={me}
          occurrence={editing.occurrence}
          day={editing.day}
          onClose={(changed) => {
            setEditing(null)
            if (changed) reload()
          }}
        />
      )}
      {exporting && people.data && <SendOutDialog ctx={ctx} people={list} me={me} onClose={() => setExporting(false)} />}
      {colours && people.data && <ColoursDialog ctx={ctx} people={list} onClose={() => (setColours(false), people.reload())} />}
    </div>
  )
}

function MonthGrid({
  anchor,
  from,
  onDay,
  people,
  selected,
  onSelect,
  onOpen,
}: {
  anchor: string
  from: string
  onDay: (day: string) => Occurrence[]
  people: Person[]
  selected: string | null
  onSelect: (day: string) => void
  onOpen: (o: Occurrence) => void
}) {
  const month = anchor.slice(0, 7)
  const now = today()
  return (
    <div className="cal-month" role="grid" aria-label={formatMonth(anchor)}>
      {WEEKDAY_SHORT.map((d) => (
        <div key={d} className="cal-weekday" role="columnheader">
          {d}
        </div>
      ))}
      {Array.from({ length: 42 }, (_, i) => addDays(from, i)).map((day) => {
        const items = onDay(day)
        return (
          <div
            key={day}
            role="gridcell"
            className={`cal-day ${day.slice(0, 7) === month ? '' : 'cal-day-out'} ${day === now ? 'cal-day-today' : ''} ${day === selected ? 'cal-day-selected' : ''}`}
          >
            <button className="cal-day-num" onClick={() => onSelect(day)} aria-label={`${formatDay(day)}${items.length ? `, ${items.length} events` : ''}`}>
              {Number(day.slice(8))}
            </button>
            {items.slice(0, 3).map((o) => (
              <EventPill key={`${o.eventId}-${o.day}`} o={o} people={people} onOpen={onOpen} />
            ))}
            {items.length > 3 && (
              <button className="link small" onClick={() => onSelect(day)}>
                +{items.length - 3} more
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}

function DayList({ day, items, people, onOpen, onAdd, compact }: { day: string; items: Occurrence[]; people: Person[]; onOpen: (o: Occurrence) => void; onAdd?: () => void; compact?: boolean }) {
  return (
    <section className={`cal-daylist ${day === today() ? 'cal-daylist-today' : ''}`} aria-label={formatDay(day)}>
      <div className="row cal-daylist-head">
        <strong>{formatDay(day, compact ? { weekday: 'short', day: 'numeric' } : { weekday: 'long', day: 'numeric', month: 'long' })}</strong>
        {onAdd && <Button variant="ghost" icon={<Plus size={16} aria-hidden />} aria-label={`New event on ${formatDay(day)}`} onClick={onAdd} />}
      </div>
      {items.length === 0 && <p className="muted small">Nothing planned.</p>}
      <ul className="cal-items">
        {items.map((o) => (
          <li key={`${o.eventId}-${o.day}`}>
            <button className="cal-item" style={{ ['--stripe' as string]: stripe(people, o.tags) }} onClick={() => onOpen(o)}>
              <span className="cal-item-when muted small">{whenText(o)}</span>
              <span className="cal-item-title">
                {o.title}
                {o.repeat && <RepeatIcon size={12} aria-label="Repeats" />}
              </span>
              <span className="cal-item-tags">
                {o.tags.map((t) => (
                  <TagChip key={t} people={people} tag={t} />
                ))}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

// ---- one event ----------------------------------------------------------------------------

type Scope = 'one' | 'following' | 'all'

function ScopeChoice({ verb, onChoose, onCancel }: { verb: string; onChoose: (s: Scope) => void; onCancel: () => void }) {
  return (
    <div className="stack-sm date-entry">
      <p>This event repeats. {verb}:</p>
      <div className="row">
        <Button type="button" variant="secondary" onClick={() => onChoose('one')}>
          Just this one
        </Button>
        <Button type="button" variant="secondary" onClick={() => onChoose('following')}>
          This and following
        </Button>
        <Button type="button" variant="secondary" onClick={() => onChoose('all')}>
          All of them
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function EventView({ ctx, o, people, onClose, onEdit, onChanged }: { ctx: HubContext; o: Occurrence; people: Person[]; onClose: () => void; onEdit: () => void; onChanged: () => void }) {
  const { api } = ctx.platform
  const [choosing, setChoosing] = useState(false)
  const contact = useLoad(
    () => (o.contactId ? api.get<{ contacts: { id: string; name: string; phones: { number: string }[] }[] }>('/api/contacts').then((r) => r.contacts.find((c) => c.id === o.contactId) ?? null) : Promise.resolve(null)),
    [o.contactId],
  )
  const remove = useAction(async (scope: Scope) => {
    if (scope === 'all' && !o.repeat && !window.confirm(`Delete “${o.title}”?`)) return
    await api.del(`/api/calendar/events/${o.eventId}?scope=${scope}&day=${o.day}`)
    onChanged()
  })
  const send = useAction(async () => {
    await saveFromApi(ctx.platform, `/api/calendar/export/event-${o.eventId}.ics`, `${o.title}.ics`)
  })
  const openFile = useAction(async () => {
    if (!o.fileId) return
    if (ctx.platform.downloadFile) return ctx.platform.downloadFile({ id: o.fileId, name: o.fileName ?? 'document', mediaType: 'application/octet-stream' }, 'open')
    const blob = await api.fileBlob(o.fileId)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = o.fileName ?? 'document'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  })
  return (
    <Dialog open title={o.title} onClose={onClose}>
      <div className="stack">
        <div>
          <div>{formatDay(dayOf(o.start))}</div>
          <div className="muted">{whenText(o)}</div>
          {o.repeat && (
            <div className="muted small">
              <RepeatIcon size={12} aria-hidden /> {repeatText(o.repeat)}
              {o.changed && ' (this day changed)'}
            </div>
          )}
        </div>
        <div className="row">
          {o.tags.map((t) => (
            <TagChip key={t} people={people} tag={t} />
          ))}
        </div>
        {o.location && (
          <div className="row">
            <MapPin size={16} aria-hidden /> {o.location}
          </div>
        )}
        {o.notes && <div className="pre-wrap">{o.notes}</div>}
        {contact.data && (
          <div className="muted small">
            Contact: {contact.data.name}
            {contact.data.phones[0] && (
              <>
                {' · '}
                <a href={`tel:${contact.data.phones[0].number.replace(/[^0-9+]/g, '')}`}>{contact.data.phones[0].number}</a>
              </>
            )}
          </div>
        )}
        {o.fileId && (
          <Button variant="secondary" icon={<FileText size={16} aria-hidden />} busy={openFile.busy} onClick={() => void openFile.run()}>
            {o.fileName ?? 'Linked document'}
          </Button>
        )}
        {choosing && <ScopeChoice verb="Delete" onChoose={(scope) => void remove.run(scope)} onCancel={() => setChoosing(false)} />}
        {(remove.error || send.error || openFile.error) && <Banner kind="error">{remove.error || send.error || openFile.error}</Banner>}
        {!choosing && (
          <div className="row">
            <Button icon={<Pencil size={16} aria-hidden />} onClick={onEdit}>
              Edit
            </Button>
            <Button variant="secondary" icon={<CalendarPlus size={16} aria-hidden />} busy={send.busy} onClick={() => void send.run()}>
              Add to my calendar
            </Button>
            <Button variant="danger" icon={<Trash2 size={16} aria-hidden />} busy={remove.busy} onClick={() => (o.repeat ? setChoosing(true) : void remove.run('all'))}>
              Delete
            </Button>
          </div>
        )}
      </div>
    </Dialog>
  )
}

const REPEAT_PRESETS: Record<string, Repeat | null> = {
  none: null,
  daily: { freq: 'daily', interval: 1 },
  weekly: { freq: 'weekly', interval: 1 },
  fortnightly: { freq: 'weekly', interval: 2 },
  monthly: { freq: 'monthly', interval: 1, monthlyBy: 'date' },
  yearly: { freq: 'yearly', interval: 1 },
}

function EventEditor({ ctx, people, me, occurrence, day, onClose }: { ctx: HubContext; people: Person[]; me: string | null; occurrence: Occurrence | null; day: string; onClose: (changed: boolean) => void }) {
  const { api } = ctx.platform
  const isParent = ctx.user.role === 'admin'
  const o = occurrence
  const [form, setForm] = useState(() => ({
    title: o?.title ?? '',
    allDay: o?.allDay ?? false,
    startDay: o ? dayOf(o.start) : day,
    startTime: o && !o.allDay ? timeOf(o.start) : '09:00',
    endDay: o ? dayOf(o.end) : day,
    endTime: o && !o.allDay ? timeOf(o.end) : '10:00',
    tags: o?.tags ?? (me ? [me] : [FAMILY]),
    location: o?.location ?? '',
    notes: o?.notes ?? '',
    contactId: o?.contactId ?? '',
    fileId: o?.fileId ?? '',
    fileName: o?.fileName ?? '',
    repeat: (o?.repeat ?? null) as Repeat | null,
    endsKind: (o?.repeat?.until ? 'until' : o?.repeat?.count ? 'count' : 'never') as 'never' | 'until' | 'count',
  }))
  const [choosing, setChoosing] = useState(false)
  const [fileQuery, setFileQuery] = useState('')
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }))
  const contacts = useLoad(() => (isParent ? api.get<{ contacts: { id: string; name: string }[] }>('/api/contacts').then((r) => r.contacts) : Promise.resolve([])), [isParent])
  const files = useLoad(
    () => (fileQuery.trim().length >= 2 ? api.get<{ items: { id: string; name: string; kind: string }[] }>(`/api/files?${new URLSearchParams({ q: fileQuery.trim() })}`).then((r) => r.items.filter((i) => i.kind === 'file').slice(0, 8)) : Promise.resolve([])),
    [fileQuery],
  )

  // Keep the end after the start as the start moves.
  useEffect(() => {
    if (form.endDay < form.startDay) set('endDay', form.startDay)
    else if (!form.allDay && form.endDay === form.startDay && form.endTime < form.startTime) set('endTime', form.startTime)
  }, [form.startDay, form.startTime])

  const preset = (() => {
    const r = form.repeat
    if (!r) return 'none'
    const match = Object.entries(REPEAT_PRESETS).find(([, p]) => p && p.freq === r.freq && p.interval === r.interval && !(r.byDay && r.byDay.length > 1) && (r.monthlyBy ?? 'date') === (p.monthlyBy ?? 'date'))
    return match ? match[0] : 'custom'
  })()

  const body = () => {
    const repeat = form.repeat
      ? {
          ...form.repeat,
          until: form.endsKind === 'until' ? (form.repeat.until ?? addDays(form.startDay, 90)) : null,
          count: form.endsKind === 'count' ? (form.repeat.count ?? 10) : null,
        }
      : null
    return {
      title: form.title,
      allDay: form.allDay,
      start: form.allDay ? form.startDay : `${form.startDay}T${form.startTime}`,
      end: form.allDay ? form.endDay : `${form.endDay}T${form.endTime}`,
      tags: form.tags,
      location: form.location,
      notes: form.notes,
      contactId: isParent ? form.contactId || null : (o?.contactId ?? null),
      fileId: form.fileId || null,
      repeat,
    }
  }
  const save = useAction(async (scope: Scope = 'all') => {
    if (form.tags.length === 0) throw new Error('Tag who it is for, or Family.')
    try {
      if (!o) {
        await api.post('/api/calendar/events', body())
      } else {
        // The whole series is changed from its own start: keep that unless this is one day or the days that follow.
        let b = body()
        if (scope === 'all' && o.repeat) {
          // The form shows this day; the series starts on its first day. Move both ends by the same number of days.
          const series = await api.get<{ event: { start: string } }>(`/api/calendar/events/${o.eventId}`)
          const delta = daysBetween(o.day, dayOf(series.event.start))
          const shift = (v: string) => `${addDays(dayOf(v), delta)}${v.slice(10)}`
          b = { ...b, start: shift(b.start), end: shift(b.end) }
        }
        await api.request('PUT', `/api/calendar/events/${o.eventId}`, { ...b, baseVersion: o.version, scope, day: o.day })
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'edit_conflict') throw new Error(`${e.message} Your changes were not saved.`)
      throw e
    }
    onClose(true)
  })
  const toggleTag = (t: string) => set('tags', form.tags.includes(t) ? form.tags.filter((x) => x !== t) : [...form.tags, t])
  const weekday = WEEKDAYS[weekdayIndex(form.startDay)]!

  return (
    <Dialog open title={o ? 'Edit event' : 'New event'} onClose={() => onClose(false)}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          if (o?.repeat) setChoosing(true)
          else void save.run('all')
        }}
      >
        <Field label="Title" value={form.title} onChange={(e) => set('title', e.target.value)} required maxLength={200} autoComplete="off" placeholder="e.g. Dentist, Swimming, Braai at Gran’s" />
        <fieldset className="radio-group">
          <legend>Who is it for?</legend>
          <div className="row">
            <button type="button" className={`chip ${form.tags.includes(FAMILY) ? 'chip-on' : ''}`} aria-pressed={form.tags.includes(FAMILY)} onClick={() => toggleTag(FAMILY)}>
              <Home size={14} aria-hidden /> Family
            </button>
            {people.map((p) => (
              <button key={p.id} type="button" className={`chip ${form.tags.includes(p.id) ? 'chip-on' : ''}`} aria-pressed={form.tags.includes(p.id)} onClick={() => toggleTag(p.id)}>
                <span className="tag-dot" style={{ ['--tag' as string]: colourOf(people, p.id) }} aria-hidden /> {p.displayName}
              </button>
            ))}
          </div>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={form.allDay} onChange={(e) => set('allDay', e.target.checked)} />
          <span>All day</span>
        </label>
        <div className="row">
          <div className="field">
            <label htmlFor="ev-start">Starts</label>
            <input id="ev-start" className="qi-search" type="date" required value={form.startDay} onChange={(e) => set('startDay', e.target.value)} />
          </div>
          {!form.allDay && (
            <div className="field">
              <label htmlFor="ev-start-time">At</label>
              <input id="ev-start-time" className="qi-search year-input" type="time" required value={form.startTime} onChange={(e) => set('startTime', e.target.value)} />
            </div>
          )}
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="ev-end">Ends</label>
            <input id="ev-end" className="qi-search" type="date" required min={form.startDay} value={form.endDay} onChange={(e) => set('endDay', e.target.value)} />
          </div>
          {!form.allDay && (
            <div className="field">
              <label htmlFor="ev-end-time">At</label>
              <input id="ev-end-time" className="qi-search year-input" type="time" required value={form.endTime} onChange={(e) => set('endTime', e.target.value)} />
            </div>
          )}
        </div>
        <div className="field">
          <label htmlFor="ev-repeat">Repeats</label>
          <select
            id="ev-repeat"
            className="select"
            value={preset}
            onChange={(e) => {
              const v = e.target.value
              if (v === 'custom') set('repeat', { freq: 'weekly', interval: 1, byDay: [weekday] })
              else set('repeat', REPEAT_PRESETS[v] ? { ...REPEAT_PRESETS[v]! } : null)
            }}
          >
            <option value="none">Does not repeat</option>
            <option value="daily">Every day</option>
            <option value="weekly">Every week on {WEEKDAY_SHORT[weekdayIndex(form.startDay)]}</option>
            <option value="fortnightly">Every 2 weeks on {WEEKDAY_SHORT[weekdayIndex(form.startDay)]}</option>
            <option value="monthly">Every month on the {Number(form.startDay.slice(8))}</option>
            <option value="yearly">Every year</option>
            <option value="custom">Custom…</option>
          </select>
        </div>
        {form.repeat && preset === 'custom' && (
          <div className="stack-sm date-entry">
            <div className="row">
              <span>Every</span>
              <input
                className="qi-search year-input"
                type="number"
                min={1}
                max={99}
                aria-label="Repeat every"
                value={form.repeat.interval}
                onChange={(e) => set('repeat', { ...form.repeat!, interval: Math.max(1, Math.min(99, Number(e.target.value) || 1)) })}
              />
              <select className="select select-small" aria-label="Repeat unit" value={form.repeat.freq} onChange={(e) => set('repeat', { ...form.repeat!, freq: e.target.value as Repeat['freq'] })}>
                <option value="daily">days</option>
                <option value="weekly">weeks</option>
                <option value="monthly">months</option>
                <option value="yearly">years</option>
              </select>
            </div>
            {form.repeat.freq === 'weekly' && (
              <div className="row" role="group" aria-label="On these days">
                {WEEKDAYS.map((d, i) => {
                  const on = (form.repeat!.byDay ?? [weekday]).includes(d)
                  return (
                    <button
                      key={d}
                      type="button"
                      className={`chip ${on ? 'chip-on' : ''}`}
                      aria-pressed={on}
                      onClick={() => {
                        const current = form.repeat!.byDay ?? [weekday]
                        const next = on ? current.filter((x) => x !== d) : [...current, d]
                        if (next.length) set('repeat', { ...form.repeat!, byDay: WEEKDAYS.filter((w) => next.includes(w)) as Weekday[] })
                      }}
                    >
                      {WEEKDAY_SHORT[i]}
                    </button>
                  )
                })}
              </div>
            )}
            {form.repeat.freq === 'monthly' && (
              <select className="select" aria-label="Monthly on" value={form.repeat.monthlyBy ?? 'date'} onChange={(e) => set('repeat', { ...form.repeat!, monthlyBy: e.target.value as 'date' | 'weekday' })}>
                <option value="date">On the {Number(form.startDay.slice(8))}</option>
                <option value="weekday">On the same weekday ({WEEKDAY_SHORT[weekdayIndex(form.startDay)]}, same week of the month)</option>
              </select>
            )}
          </div>
        )}
        {form.repeat && (
          <div className="row">
            <select className="select select-small" aria-label="Repeat ends" value={form.endsKind} onChange={(e) => set('endsKind', e.target.value as 'never' | 'until' | 'count')}>
              <option value="never">Never ends</option>
              <option value="until">Ends on</option>
              <option value="count">Ends after</option>
            </select>
            {form.endsKind === 'until' && (
              <input
                className="qi-search"
                type="date"
                aria-label="Repeat until"
                min={form.startDay}
                value={form.repeat.until ?? addDays(form.startDay, 90)}
                onChange={(e) => set('repeat', { ...form.repeat!, until: e.target.value })}
              />
            )}
            {form.endsKind === 'count' && (
              <>
                <input
                  className="qi-search year-input"
                  type="number"
                  min={1}
                  max={1000}
                  aria-label="Number of times"
                  value={form.repeat.count ?? 10}
                  onChange={(e) => set('repeat', { ...form.repeat!, count: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })}
                />
                <span>times</span>
              </>
            )}
          </div>
        )}
        <Field label="Where" value={form.location} onChange={(e) => set('location', e.target.value)} maxLength={300} autoComplete="off" />
        <div className="field">
          <label htmlFor="ev-notes">Notes</label>
          <textarea id="ev-notes" className="textarea" rows={3} maxLength={4000} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
        </div>
        {isParent && (contacts.data?.length ?? 0) > 0 && (
          <div className="field">
            <label htmlFor="ev-contact">Contact</label>
            <select id="ev-contact" className="select" value={form.contactId} onChange={(e) => set('contactId', e.target.value)}>
              <option value="">None</option>
              {contacts.data!.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label htmlFor="ev-file">Document</label>
          {form.fileId ? (
            <div className="row">
              <FileText size={16} aria-hidden /> {form.fileName || 'Linked document'}
              <Button type="button" variant="ghost" onClick={() => setForm((f) => ({ ...f, fileId: '', fileName: '' }))}>
                Remove
              </Button>
            </div>
          ) : (
            <>
              <input id="ev-file" className="qi-search" placeholder="Search Files, e.g. invitation" value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} />
              {(files.data ?? []).map((f) => (
                <button key={f.id} type="button" className="link" onClick={() => (setForm((x) => ({ ...x, fileId: f.id, fileName: f.name })), setFileQuery(''))}>
                  {f.name}
                </button>
              ))}
            </>
          )}
        </div>
        {choosing && (
          <ScopeChoice
            verb="Save changes to"
            onChoose={(scope) => {
              setChoosing(false)
              void save.run(scope)
            }}
            onCancel={() => setChoosing(false)}
          />
        )}
        {save.error && <Banner kind="error">{save.error}</Banner>}
        {!choosing && (
          <div className="row">
            <Button type="submit" busy={save.busy}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => onClose(false)}>
              Cancel
            </Button>
          </div>
        )}
      </form>
    </Dialog>
  )
}

// ---- sending out, and colours ----------------------------------------------------------------

function SendOutDialog({ ctx, people, me, onClose }: { ctx: HubContext; people: Person[]; me: string | null; onClose: () => void }) {
  const [from, setFrom] = useState(today())
  const [to, setTo] = useState(addDays(today(), 90))
  const [who, setWho] = useState(me ?? 'all')
  const [notes, setNotes] = useState(false)
  const save = useAction(async () => {
    if (to < from) throw new Error('The end is before the start.')
    const compact = (d: string) => d.replace(/-/g, '')
    await saveFromApi(ctx.platform, `/api/calendar/export/range-${compact(from)}-${compact(to)}-${who}${notes ? '-notes' : ''}.ics`, `family-hub ${from} to ${to}.ics`)
    onClose()
  })
  return (
    <Dialog open title="Send events out" onClose={onClose}>
      <div className="stack">
        <p>Saves an .ics file that your phone’s calendar, Google Calendar or Outlook can import. It is a copy: later changes here are not sent automatically.</p>
        <div className="field">
          <label htmlFor="send-who">Whose events</label>
          <select id="send-who" className="select" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="all">Everyone’s</option>
            <option value="family">Family events only</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}’s (and Family)
              </option>
            ))}
          </select>
        </div>
        <div className="row">
          <div className="field">
            <label htmlFor="send-from">From</label>
            <input id="send-from" className="qi-search" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="send-to">To</label>
            <input id="send-to" className="qi-search" type="date" min={from} max={addDays(from, 400)} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </div>
        <label className="check">
          <input type="checkbox" checked={notes} onChange={(e) => setNotes(e.target.checked)} />
          <span>Include notes (left out unless you tick this)</span>
        </label>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <div className="row">
          <Button busy={save.busy} icon={<CalendarDays size={16} aria-hidden />} onClick={() => void save.run()}>
            Save .ics file
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function ColoursDialog({ ctx, people, onClose }: { ctx: HubContext; people: Person[]; onClose: () => void }) {
  const [current, setCurrent] = useState(() => Object.fromEntries(people.map((p) => [p.id, colourOf(people, p.id)])))
  const save = useAction(async (id: string, colour: string) => {
    await ctx.platform.api.request('PUT', `/api/calendar/people/${id}/colour`, { colour })
    setCurrent((c) => ({ ...c, [id]: colour }))
  })
  return (
    <Dialog open title="Colours" onClose={onClose}>
      <div className="stack">
        <p className="muted">Each person’s colour on the calendar. Family events are always {''}
          <span className="tag-chip" style={{ ['--tag' as string]: FAMILY_COLOUR }}>
            <Home size={12} aria-hidden /> Family
          </span>
          .
        </p>
        {people.length === 0 && <p>Add the family’s people in Quick Info first (Add a person).</p>}
        {people.map((p) => (
          <div key={p.id} className="row">
            <span className="colour-name">{p.displayName}</span>
            <div className="row" role="group" aria-label={`${p.displayName}’s colour`}>
              {PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`swatch ${current[p.id] === c ? 'swatch-on' : ''}`}
                  style={{ background: c }}
                  aria-label={`${p.displayName}: colour ${c}`}
                  aria-pressed={current[p.id] === c}
                  onClick={() => void save.run(p.id, c)}
                />
              ))}
            </div>
          </div>
        ))}
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <div className="row">
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
