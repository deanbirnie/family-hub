/**
 * Keeping in touch (phase 3): "stay in touch" reminders, a dated timeline of
 * notes and life events, and gift ideas and gifts given, for one contact.
 */
import { CheckCircle2, Gift as GiftIcon, MessageCircle, Plus, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Api } from '../api.ts'
import { Badge, Banner, Button, useAction } from '../ui.tsx'
import { formatImportantDate } from './dates.ts'
import type { Parent } from './PeopleSections.tsx'

export interface KeepInTouch {
  everyDays: number
  since: string | null
  lastContact: string | null
  remindFor: string
}

export const emptyKeepInTouch = (): KeepInTouch => ({ everyDays: 0, since: null, lastContact: null, remindFor: 'all' })

const INTERVALS: Record<number, string> = { 0: 'No reminder', 14: 'Every 2 weeks', 30: 'Every month', 60: 'Every 2 months', 90: 'Every 3 months', 182: 'Every 6 months', 365: 'Every year' }

type NoteKind = 'note' | 'event' | 'contact'
type LifeEvent = 'new_job' | 'moved' | 'new_baby' | 'engaged' | 'married' | 'graduated' | 'retired' | 'passed_away' | 'other'
export const LIFE_EVENTS: Record<LifeEvent, string> = {
  new_job: 'New job',
  moved: 'Moved house',
  new_baby: 'New baby',
  engaged: 'Engaged',
  married: 'Married',
  graduated: 'Graduated',
  retired: 'Retired',
  passed_away: 'Passed away',
  other: 'Something else',
}

interface Note {
  id: string
  date: string
  kind: NoteKind
  lifeEvent: LifeEvent | null
  text: string
}

interface Gift {
  id: string
  idea: string
  occasion: string
  status: 'idea' | 'bought' | 'wrapped' | 'given'
  date: string | null
  link: string
  note: string
  amount: number | null
  forDate: string | null
  plannedId: string | null
}

interface TimelineData {
  notes: Note[]
  gifts: Gift[]
}

const todayIso = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function KeepInTouchEditor({ value, onChange, parents }: { value: KeepInTouch; onChange: (v: KeepInTouch) => void; parents: Parent[] }) {
  return (
    <fieldset className="radio-group">
      <legend>Stay in touch</legend>
      <div className="row">
        <select className="select" aria-label="Catch up" value={value.everyDays} onChange={(e) => onChange({ ...value, everyDays: Number(e.target.value) })}>
          {Object.entries(INTERVALS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        {value.everyDays > 0 && parents.length > 1 && (
          <select className="select" aria-label="Catch-up reminder for" value={value.remindFor} onChange={(e) => onChange({ ...value, remindFor: e.target.value })}>
            <option value="all">For both of us</option>
            {parents.map((p) => (
              <option key={p.id} value={p.id}>
                Only {p.displayName}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="muted small">
        {value.lastContact ? `Last in touch: ${formatImportantDate(value.lastContact)}.` : 'No contact recorded yet.'}
        {value.everyDays > 0 && ' You are reminded when it is time to catch up; “We spoke” resets it.'}
      </p>
    </fieldset>
  )
}

/** For an existing contact: "We spoke", the timeline, and gifts. */
export function TimelineSection({
  api,
  contactId,
  onChanged,
  onAddAnniversary,
  onPassedAway,
}: {
  api: Api
  contactId: string
  /** After "We spoke" changed the contact itself. */
  onChanged: () => void
  onAddAnniversary: (date: string) => void
  onPassedAway: () => void
}) {
  const [data, setData] = useState<TimelineData | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState<null | 'note' | 'gift'>(null)
  const [note, setNote] = useState({ date: todayIso(), kind: 'note' as NoteKind, lifeEvent: 'new_job' as LifeEvent, text: '', extra: true })
  const [gift, setGift] = useState({ idea: '', occasion: '', link: '' })
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    api.get<TimelineData>(`/api/contacts/${contactId}/timeline`).then(setData, (e: unknown) => setError(e instanceof Error ? e.message : 'Could not load the timeline.'))
  }, [api, contactId])

  const spoke = useAction(async () => {
    setData(await api.post<TimelineData>(`/api/contacts/${contactId}/spoke`, {}))
    onChanged()
  })
  const addNote = useAction(async () => {
    const body = { date: note.date, kind: note.kind, lifeEvent: note.kind === 'event' ? note.lifeEvent : null, text: note.text }
    setData(await api.post<TimelineData>(`/api/contacts/${contactId}/notes`, body))
    if (note.kind === 'event' && note.extra && note.lifeEvent === 'married') onAddAnniversary(note.date)
    if (note.kind === 'event' && note.extra && note.lifeEvent === 'passed_away') onPassedAway()
    setNote({ date: todayIso(), kind: 'note', lifeEvent: 'new_job', text: '', extra: true })
    setAdding(null)
  })
  const removeNote = useAction(async (id: string) => {
    if (!window.confirm('Delete this entry?')) return
    setData(await api.del<TimelineData>(`/api/contacts/notes/${id}`))
  })
  const addGift = useAction(async () => {
    setData(await api.post<TimelineData>(`/api/contacts/${contactId}/gifts`, gift))
    setGift({ idea: '', occasion: '', link: '' })
    setAdding(null)
  })
  const given = useAction(async (g: Gift) => {
    setData(await api.request<TimelineData>('PUT', `/api/contacts/gifts/${g.id}`, { ...g, status: 'given', date: todayIso() }))
  })
  const removeGift = useAction(async (id: string) => {
    if (!window.confirm('Delete this gift?')) return
    setData(await api.del<TimelineData>(`/api/contacts/gifts/${id}`))
  })

  const notes = data?.notes ?? []
  const shown = showAll ? notes : notes.slice(0, 5)
  const ideas = (data?.gifts ?? []).filter((g) => g.status !== 'given')
  const givenGifts = (data?.gifts ?? []).filter((g) => g.status === 'given')
  const problem = error || spoke.error || addNote.error || removeNote.error || addGift.error || given.error || removeGift.error

  return (
    <>
      <fieldset className="radio-group">
        <legend>Timeline</legend>
        <div className="row">
          <Button type="button" variant="secondary" icon={<MessageCircle size={16} aria-hidden />} busy={spoke.busy} onClick={() => void spoke.run()}>
            We spoke today
          </Button>
          <Button type="button" variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => setAdding(adding === 'note' ? null : 'note')}>
            Add a note or life event
          </Button>
        </div>
        {adding === 'note' && (
          <div className="stack-sm date-entry">
            <div className="row">
              <select className="select select-small" aria-label="Kind of entry" value={note.kind} onChange={(e) => setNote({ ...note, kind: e.target.value as NoteKind })}>
                <option value="note">Note</option>
                <option value="event">Life event</option>
                <option value="contact">We were in touch</option>
              </select>
              {note.kind === 'event' && (
                <select className="select select-small" aria-label="Life event" value={note.lifeEvent} onChange={(e) => setNote({ ...note, lifeEvent: e.target.value as LifeEvent })}>
                  {Object.entries(LIFE_EVENTS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              )}
              <input className="qi-search year-input" type="date" aria-label="Entry date" value={note.date} max={todayIso()} onChange={(e) => setNote({ ...note, date: e.target.value })} />
            </div>
            <textarea
              className="textarea"
              rows={2}
              aria-label="Entry text"
              maxLength={4000}
              placeholder={note.kind === 'event' ? 'e.g. Started at Groote Schuur' : 'e.g. Lunch at the Waterfront; they’re expecting in May'}
              value={note.text}
              onChange={(e) => setNote({ ...note, text: e.target.value })}
            />
            {note.kind === 'event' && note.lifeEvent === 'married' && (
              <label className="check">
                <input type="checkbox" checked={note.extra} onChange={(e) => setNote({ ...note, extra: e.target.checked })} />
                <span>Add this as their anniversary (then Save the contact)</span>
              </label>
            )}
            {note.kind === 'event' && note.lifeEvent === 'passed_away' && (
              <label className="check">
                <input type="checkbox" checked={note.extra} onChange={(e) => setNote({ ...note, extra: e.target.checked })} />
                <span>Mark them as passed away (then Save the contact)</span>
              </label>
            )}
            {note.kind === 'event' && note.lifeEvent === 'new_baby' && <p className="muted small">Add the baby with “Add a child” under Family and relationships.</p>}
            <div className="row">
              <Button type="button" busy={addNote.busy} onClick={() => void addNote.run()}>
                Add to timeline
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(null)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {data && notes.length === 0 && <p className="muted small">Nothing yet. Notes, life events and times you were in touch show here, newest first.</p>}
        {shown.length > 0 && (
          <ul className="timeline">
            {shown.map((n) => (
              <li key={n.id}>
                <span className="timeline-icon" aria-hidden>
                  {n.kind === 'event' ? <Sparkles size={14} /> : n.kind === 'contact' ? <MessageCircle size={14} /> : <Plus size={14} />}
                </span>
                <div className="item-main">
                  <div className="muted small">
                    {formatImportantDate(n.date)}
                    {n.kind === 'event' && n.lifeEvent && <Badge tone="accent">{LIFE_EVENTS[n.lifeEvent]}</Badge>}
                    {n.kind === 'contact' && ' · in touch'}
                  </div>
                  {n.text && <div className="pre-wrap">{n.text}</div>}
                </div>
                <Button type="button" variant="ghost" icon={<Trash2 size={16} aria-hidden />} aria-label={`Delete the entry from ${formatImportantDate(n.date)}`} onClick={() => void removeNote.run(n.id)} />
              </li>
            ))}
          </ul>
        )}
        {notes.length > 5 && (
          <button type="button" className="link" onClick={() => setShowAll(!showAll)}>
            {showAll ? 'Show fewer' : `Show all ${notes.length}`}
          </button>
        )}
      </fieldset>

      <fieldset className="radio-group">
        <legend>Gifts</legend>
        {data && ideas.length === 0 && givenGifts.length === 0 && <p className="muted small">Gift ideas for them, and what you have given before.</p>}
        {ideas.length > 0 && (
          <ul className="timeline">
            {ideas.map((g) => (
              <li key={g.id}>
                <span className="timeline-icon" aria-hidden>
                  <GiftIcon size={14} />
                </span>
                <div className="item-main">
                  <div>
                    {g.link ? (
                      <a href={g.link} target="_blank" rel="noopener noreferrer">
                        {g.idea}
                      </a>
                    ) : (
                      g.idea
                    )}
                    {g.occasion && <span className="muted"> · {g.occasion}</span>}
                    {g.status !== 'idea' && <span className="muted"> · {g.status}</span>}
                  </div>
                </div>
                <Button type="button" variant="ghost" icon={<CheckCircle2 size={16} aria-hidden />} aria-label={`Mark ${g.idea} as given`} title="Mark as given" onClick={() => void given.run(g)} />
                <Button type="button" variant="ghost" icon={<Trash2 size={16} aria-hidden />} aria-label={`Delete ${g.idea}`} onClick={() => void removeGift.run(g.id)} />
              </li>
            ))}
          </ul>
        )}
        {givenGifts.length > 0 && (
          <>
            <div className="muted small">Given before</div>
            <ul className="timeline">
              {givenGifts.map((g) => (
                <li key={g.id}>
                  <span className="timeline-icon" aria-hidden>
                    <CheckCircle2 size={14} />
                  </span>
                  <div className="item-main">
                    <div>
                      {g.idea}
                      {g.occasion && <span className="muted"> · {g.occasion}</span>}
                    </div>
                    {g.date && <div className="muted small">{formatImportantDate(g.date)}</div>}
                  </div>
                  <Button type="button" variant="ghost" icon={<Trash2 size={16} aria-hidden />} aria-label={`Delete ${g.idea}`} onClick={() => void removeGift.run(g.id)} />
                </li>
              ))}
            </ul>
          </>
        )}
        {adding === 'gift' ? (
          <div className="stack-sm date-entry">
            <input className="qi-search" aria-label="Gift idea" placeholder="e.g. Hiking boots, size 9" maxLength={200} value={gift.idea} onChange={(e) => setGift({ ...gift, idea: e.target.value })} />
            <div className="row">
              <input className="qi-search" aria-label="Occasion" placeholder="Occasion (optional), e.g. Birthday" maxLength={60} value={gift.occasion} onChange={(e) => setGift({ ...gift, occasion: e.target.value })} />
              <input className="qi-search" aria-label="Link" type="url" placeholder="https:// link (optional)" maxLength={500} value={gift.link} onChange={(e) => setGift({ ...gift, link: e.target.value })} />
            </div>
            <div className="row">
              <Button type="button" busy={addGift.busy} onClick={() => void addGift.run()}>
                Add gift idea
              </Button>
              <Button type="button" variant="ghost" onClick={() => setAdding(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button type="button" variant="ghost" icon={<GiftIcon size={16} aria-hidden />} onClick={() => setAdding('gift')}>
            Add a gift idea
          </Button>
        )}
      </fieldset>
      {problem && <Banner kind="error">{problem}</Banner>}
    </>
  )
}
