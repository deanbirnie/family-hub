/**
 * The family calendar (docs/ROADMAP.md, phase 4).
 *
 * - Everyone in the family sees, adds and edits every event.
 * - An event is tagged with one or more people (the family's people, the
 *   same as Quick Info's, each with a colour) or "family".
 * - Everything about an event, times included, is one value sealed with the
 *   server key and bound to its ID (docs/DATA-PROTECTION.md, "Family
 *   calendar"); a family's events are few enough to open and filter in memory.
 * - Repeating events (recurrence.ts) can be changed for one day, from a day
 *   on, or entirely.
 * - Nothing outside reads the calendar live: events go out as .ics files.
 */
import type { Api, Services } from '../app.ts'
import { HttpError, readJson, str } from '../http.ts'
import { addDays, dayNum, occurrences, toRRule, WEEKDAYS, type Repeat, type Weekday } from '../recurrence.ts'
import { newId } from '../secrets.ts'
import { escapeText, fold } from '../vcard.ts'
import { contactDates } from './contacts.ts'
import { parseDate } from '../schedule.ts'

export const FAMILY = 'family'

/** Changes to one day of a repeating event, keyed by the day it was due. */
export interface Exception {
  cancelled?: boolean
  title?: string
  allDay?: boolean
  start?: string
  end?: string
  tags?: string[]
  location?: string
  notes?: string
}

export interface CalEvent {
  title: string
  allDay: boolean
  /** YYYY-MM-DD (all-day) or YYYY-MM-DDTHH:MM, in the family's time zone. */
  start: string
  /** Same form; for all-day events the last day (inclusive). */
  end: string
  /** "family", or the IDs of the family's people. */
  tags: string[]
  location: string
  notes: string
  contactId: string | null
  fileId: string | null
  /** The linked file's name when it was linked (files are shared with everyone). */
  fileName: string | null
  repeat: Repeat | null
  exceptions: Record<string, Exception>
  /** Minutes before the start to remind (0 = at the time). */
  reminders?: number[]
}

/** Reminder choices: at the time, 15 minutes, 1 hour, 1 day, 1 week before. */
export const REMINDER_MINUTES = [0, 15, 60, 1440, 10080]

interface EventRow {
  id: string
  sealed: string
  version: number
  created_at: number
  updated_at: number
  updated_by: string | null
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/
const MAX_EVENTS = 20000

const validDay = (d: string) => {
  if (!DATE.test(d)) return false
  const [y, m, day] = d.split('-').map(Number) as [number, number, number]
  const t = new Date(Date.UTC(y, m - 1, day))
  return t.getUTCMonth() === m - 1 && t.getUTCDate() === day && y >= 1900 && y <= 2200
}
const validTime = (t: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t)
const dateOf = (v: string) => v.slice(0, 10)
const timeOf = (v: string) => (v.length > 10 ? v.slice(11) : '')

function text(o: Record<string, unknown>, key: string, max: number): string {
  const v = o[key]
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new HttpError(400, `"${key}" must be text.`, 'invalid')
  const t = v.trim()
  if (t.length > max) throw new HttpError(400, `"${key}" is too long.`, 'invalid')
  return t
}

/** Checks start and end for an all-day or timed event; returns them tidied. */
function times(o: Record<string, unknown>, allDay: boolean): { start: string; end: string } {
  const start = typeof o.start === 'string' ? o.start : ''
  let end = typeof o.end === 'string' && o.end ? o.end : start
  if (allDay) {
    if (!validDay(start) || !validDay(end)) throw new HttpError(400, 'Choose the days.', 'invalid')
  } else {
    if (!DATETIME.test(start) || !validDay(dateOf(start)) || !validTime(timeOf(start))) throw new HttpError(400, 'Choose a start date and time.', 'invalid')
    if (!DATETIME.test(end) || !validDay(dateOf(end)) || !validTime(timeOf(end))) end = start
  }
  if (end < start) throw new HttpError(400, 'The end is before the start.', 'invalid')
  if (dayNum(dateOf(end)) - dayNum(dateOf(start)) > 366) throw new HttpError(400, 'An event can last a year at most.', 'invalid')
  return { start, end }
}

function repeatFrom(raw: unknown, start: string): Repeat | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, '"repeat" must be an object.', 'invalid')
  const r = raw as Record<string, unknown>
  const freq = r.freq as Repeat['freq']
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(freq)) throw new HttpError(400, 'Choose how often it repeats.', 'invalid')
  const interval = r.interval === undefined ? 1 : r.interval
  if (typeof interval !== 'number' || !Number.isInteger(interval) || interval < 1 || interval > 99) throw new HttpError(400, 'Repeat every 1 to 99.', 'invalid')
  const repeat: Repeat = { freq, interval }
  if (freq === 'weekly' && r.byDay !== undefined) {
    if (!Array.isArray(r.byDay) || r.byDay.length === 0 || r.byDay.some((d) => !WEEKDAYS.includes(d as Weekday))) throw new HttpError(400, 'Choose the days of the week.', 'invalid')
    repeat.byDay = WEEKDAYS.filter((d) => (r.byDay as string[]).includes(d))
  }
  if (freq === 'monthly') repeat.monthlyBy = r.monthlyBy === 'weekday' ? 'weekday' : 'date'
  if (r.until !== undefined && r.until !== null && r.until !== '') {
    if (typeof r.until !== 'string' || !validDay(r.until) || r.until < dateOf(start)) throw new HttpError(400, 'The repeat must end after it starts.', 'invalid')
    repeat.until = r.until
  } else if (r.count !== undefined && r.count !== null && r.count !== '') {
    if (typeof r.count !== 'number' || !Number.isInteger(r.count) || r.count < 1 || r.count > 1000) throw new HttpError(400, 'Repeat 1 to 1000 times.', 'invalid')
    repeat.count = r.count
  }
  return repeat
}

  /** One day's occurrence of an event, with that day's changes applied. */
export function occurrenceOfEvent(id: string, version: number, e: CalEvent, day: string, people: Set<string>, isParent: boolean) {
    const span = dayNum(dateOf(e.end)) - dayNum(dateOf(e.start))
    const x = e.exceptions[day] ?? {}
    const allDay = x.allDay ?? e.allDay
    const start = x.start ?? (e.allDay ? day : `${day}T${timeOf(e.start)}`)
    const end = x.end ?? (e.allDay ? addDays(day, span) : `${addDays(day, span)}T${timeOf(e.end)}`)
    return {
      eventId: id,
      version,
      day,
      title: x.title ?? e.title,
      allDay,
      start,
      end,
      // Tags of people since removed are left out.
      tags: (x.tags ?? e.tags).filter((t) => t === FAMILY || people.has(t)),
      location: x.location ?? e.location,
      notes: x.notes ?? e.notes,
      // Contacts are the parents' address book.
      contactId: isParent ? e.contactId : null,
      fileId: e.fileId,
      fileName: e.fileName ?? null,
      repeat: e.repeat,
      reminders: e.reminders ?? [],
      changed: day in e.exceptions,
    }
}

/** Every occurrence overlapping [from, to]. */
export function eventOccurrences(s: Services, from: string, to: string, isParent: boolean) {
    const people = new Set((s.db.prepare('SELECT id FROM family_profiles').all() as { id: string }[]).map((p) => p.id))
    const out: ReturnType<typeof occurrenceOfEvent>[] = []
    for (const r of s.db.prepare('SELECT id, sealed, version FROM events').all() as unknown as EventRow[]) {
      const e = JSON.parse(s.serverKey.open(r.sealed, 'event', r.id)) as CalEvent
      const span = dayNum(dateOf(e.end)) - dayNum(dateOf(e.start))
      for (const day of occurrences(dateOf(e.start), e.repeat, addDays(from, -span - 1), to)) {
        const x = e.exceptions[day]
        if (x?.cancelled) continue
        const o = occurrenceOfEvent(r.id, r.version, e, day, people, isParent)
        if (dateOf(o.end) < from || dateOf(o.start) > to) continue
        out.push(o)
      }
    }
    return out.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title))
  }


export function calendarRoutes(api: Api, s: Services): void {
  const { db } = s
  const signedIn = {} as const
  const parents = { admin: true } as const

  const peopleIds = () => new Set((db.prepare('SELECT id FROM family_profiles').all() as { id: string }[]).map((p) => p.id))
  const seal = (id: string, e: CalEvent) => s.serverKey.seal(JSON.stringify(e), 'event', id)
  const open = (r: Pick<EventRow, 'id' | 'sealed'>): CalEvent => JSON.parse(s.serverKey.open(r.sealed, 'event', r.id)) as CalEvent
  const find = (id: string) => {
    const r = db.prepare('SELECT * FROM events WHERE id = ?').get(id) as unknown as EventRow | undefined
    if (!r) throw new HttpError(404, 'That event has been deleted.', 'not_found')
    return r
  }

  const tagsFrom = (raw: unknown, people: Set<string>): string[] => {
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50 || raw.some((t) => typeof t !== 'string')) throw new HttpError(400, 'Tag who it is for (or Family).', 'invalid')
    const tags = [...new Set(raw as string[])]
    for (const t of tags) if (t !== FAMILY && !people.has(t)) throw new HttpError(400, 'Someone tagged is no longer in the family.', 'invalid')
    return tags
  }

  /** An event from a request, checked. */
  const eventFrom = (body: Record<string, unknown>, keep: Pick<CalEvent, 'exceptions'> | null): CalEvent => {
    const title = str(body, 'title', { max: 200 })
    const allDay = body.allDay === true
    const { start, end } = times(body, allDay)
    let contactId: string | null = null
    if (typeof body.contactId === 'string' && body.contactId) {
      if (!db.prepare('SELECT 1 FROM contacts WHERE id = ?').get(body.contactId)) throw new HttpError(400, 'That contact has been deleted.', 'invalid')
      contactId = body.contactId
    }
    let fileId: string | null = null
    let fileName: string | null = null
    if (typeof body.fileId === 'string' && body.fileId) {
      const f = db.prepare("SELECT name FROM files WHERE id = ? AND kind = 'file' AND deleted_at IS NULL").get(body.fileId) as { name: string } | undefined
      if (!f) throw new HttpError(400, 'That file has been deleted.', 'invalid')
      fileId = body.fileId
      fileName = f.name
    }
    return {
      title,
      allDay,
      start,
      end,
      tags: tagsFrom(body.tags, peopleIds()),
      location: text(body, 'location', 300),
      notes: text(body, 'notes', 4000),
      contactId,
      fileId,
      fileName,
      repeat: repeatFrom(body.repeat, start),
      exceptions: keep?.exceptions ?? {},
      reminders: (() => {
        const r = body.reminders ?? []
        if (!Array.isArray(r) || r.some((m) => !REMINDER_MINUTES.includes(m as number))) throw new HttpError(400, 'Unknown reminder choice.', 'invalid')
        return [...new Set(r as number[])].sort((x, y) => x - y)
      })(),
    }
  }

  const between = (from: string, to: string, isParent: boolean) => eventOccurrences(s, from, to, isParent)
  const occurrenceOf = occurrenceOfEvent

  const range = (url: URL) => {
    const from = url.searchParams.get('from') ?? ''
    const to = url.searchParams.get('to') ?? ''
    if (!validDay(from) || !validDay(to) || to < from) throw new HttpError(400, 'Give "from" and "to" dates.', 'invalid')
    if (dayNum(to) - dayNum(from) > 400) throw new HttpError(400, 'Ask for at most 400 days at a time.', 'invalid')
    return { from, to }
  }

  // ---- people ---------------------------------------------------------------------------

  /** The family's people, for tags and colours (names only; everyone may see them). */
  api.authed('GET', '/api/calendar/people', signedIn, (ctx) => {
    const rows = db.prepare('SELECT id, display_name, user_id, colour FROM family_profiles ORDER BY display_name COLLATE NOCASE, id').all() as {
      id: string
      display_name: string
      user_id: string | null
      colour: string | null
    }[]
    return {
      people: rows.map((p) => ({ id: p.id, displayName: p.display_name, userId: p.user_id, colour: p.colour })),
      me: rows.find((p) => p.user_id === ctx.user.id)?.id ?? null,
    }
  })

  api.authed('PUT', '/api/calendar/people/:id/colour', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const colour = body.colour
    if (colour !== null && (typeof colour !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(colour))) throw new HttpError(400, 'Choose a colour.', 'invalid')
    const changed = db.prepare('UPDATE family_profiles SET colour = ? WHERE id = ?').run(colour, ctx.params.id!)
    if (Number(changed.changes) !== 1) throw new HttpError(404, 'That person is no longer in the family.', 'not_found')
    return undefined
  })

  // ---- events ---------------------------------------------------------------------------

  /**
   * Birthdays and other dates from Contacts (and children kept on a contact),
   * read from the sealed contacts each time and never copied. Everyone sees
   * them (name and day only). Tagged Family, or the parent who is reminded.
   */
  const contactDays = (from: string, to: string) => {
    const byUser = new Map((db.prepare('SELECT id, user_id FROM family_profiles WHERE user_id IS NOT NULL').all() as { id: string; user_id: string }[]).map((p) => [p.user_id, p.id]))
    const out = []
    for (const d of contactDates(s)) {
      if (d.stopped) continue
      const p = parseDate(d.date)
      if (!p) continue
      for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
        const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
        const day = `${y}-${String(p.month).padStart(2, '0')}-${String(p.month === 2 && p.day === 29 && !leap ? 28 : p.day).padStart(2, '0')}`
        if (day < from || day > to) continue
        const years = p.year === null ? null : y - p.year
        out.push({
          eventId: `date:${d.key}`,
          kind: d.kind,
          readOnly: true,
          version: 0,
          day,
          title: d.title,
          detail: [d.of ? `${d.of}’s` : null, years && years > 0 ? (d.kind === 'birthday' ? `turns ${years}` : `${years} years`) : null].filter(Boolean).join(' · ') || null,
          allDay: true,
          start: day,
          end: day,
          tags: d.remindFor !== 'all' && byUser.has(d.remindFor) ? [byUser.get(d.remindFor)!] : [FAMILY],
          location: '',
          notes: '',
          contactId: null,
          fileId: null,
          fileName: null,
          repeat: null,
          reminders: [],
          changed: false,
        })
      }
    }
    return out
  }

  api.authed('GET', '/api/calendar/events', signedIn, (ctx) => {
    const { from, to } = range(ctx.url)
    const events = [...between(from, to, ctx.user.role === 'admin'), ...contactDays(from, to)]
    return { events: events.sort((a, b) => a.start.localeCompare(b.start) || a.title.localeCompare(b.title)) }
  })

  /** One event as stored (the whole series), for editing. */
  api.authed('GET', '/api/calendar/events/:id', signedIn, (ctx) => {
    const r = find(ctx.params.id!)
    const e = open(r)
    return { event: { id: r.id, version: r.version, ...e, contactId: ctx.user.role === 'admin' ? e.contactId : null } }
  })

  api.authed('POST', '/api/calendar/events', signedIn, async (ctx) => {
    const event = eventFrom(await readJson(ctx.req), null)
    if ((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n >= MAX_EVENTS) throw new HttpError(409, 'The calendar is full.', 'too_many')
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO events (id, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, 1, ?, ?, ?)').run(id, seal(id, event), now, now, ctx.user.id)
    s.audit('calendar.added', ctx, ctx.user.id)
    return { id }
  })

  /**
   * Changes an event: `scope` "all" (the whole series), "one" (just `day`),
   * or "following" (from `day` on, which splits the series). Only if nobody
   * changed it since `baseVersion`.
   */
  api.authed('PUT', '/api/calendar/events/:id', signedIn, async (ctx) => {
    const body = await readJson(ctx.req)
    const r = find(ctx.params.id!)
    const base = body.baseVersion
    if (typeof base !== 'number' || !Number.isInteger(base)) throw new HttpError(400, '"baseVersion" is required.', 'invalid')
    if (base !== r.version) throw new HttpError(409, 'Someone else changed this event while you were editing. Reload to see their changes.', 'edit_conflict')
    const current = open(r)
    const scope = body.scope ?? 'all'
    const day = typeof body.day === 'string' ? body.day : ''
    const now = s.now()
    const save = (id: string, e: CalEvent) =>
      db.prepare('UPDATE events SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?').run(seal(id, e), now, ctx.user.id, id, base)

    if (scope === 'all' || !current.repeat) {
      save(r.id, eventFrom(body, current))
    } else if (scope === 'one') {
      if (!validDay(day) || !occurrences(dateOf(current.start), current.repeat, day, day).length) throw new HttpError(400, 'That day is not part of the series.', 'invalid')
      const allDay = body.allDay === true
      const { start, end } = times(body, allDay)
      const x: Exception = {
        title: str(body, 'title', { max: 200 }),
        allDay,
        start,
        end,
        tags: tagsFrom(body.tags, peopleIds()),
        location: text(body, 'location', 300),
        notes: text(body, 'notes', 4000),
      }
      save(r.id, { ...current, exceptions: { ...current.exceptions, [day]: x } })
    } else if (scope === 'following') {
      if (!validDay(day) || day <= dateOf(current.start)) {
        save(r.id, eventFrom(body, current))
      } else {
        // End the old series the day before, and start a new one.
        const next = eventFrom(body, null)
        db.exec('BEGIN IMMEDIATE')
        try {
          save(r.id, { ...current, repeat: { ...current.repeat, until: addDays(day, -1), count: null } })
          const id = newId()
          db.prepare('INSERT INTO events (id, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, 1, ?, ?, ?)').run(id, seal(id, next), now, now, ctx.user.id)
          db.exec('COMMIT')
        } catch (e) {
          db.exec('ROLLBACK')
          throw e
        }
      }
    } else {
      throw new HttpError(400, 'Change all, one, or following.', 'invalid')
    }
    s.audit('calendar.changed', ctx, ctx.user.id)
    return undefined
  })

  /** Deletes an event: `scope` all, one (`day`), or following (`day` on). */
  api.authed('DELETE', '/api/calendar/events/:id', signedIn, (ctx) => {
    const r = find(ctx.params.id!)
    const e = open(r)
    const scope = ctx.url.searchParams.get('scope') ?? 'all'
    const day = ctx.url.searchParams.get('day') ?? ''
    if (scope === 'all' || !e.repeat || (scope === 'following' && day <= dateOf(e.start))) {
      db.prepare('DELETE FROM events WHERE id = ?').run(r.id)
    } else if (scope === 'one' || scope === 'following') {
      if (!validDay(day)) throw new HttpError(400, 'Which day?', 'invalid')
      const next: CalEvent =
        scope === 'one'
          ? { ...e, exceptions: { ...e.exceptions, [day]: { cancelled: true } } }
          : { ...e, repeat: { ...e.repeat, until: addDays(day, -1), count: null } }
      db.prepare('UPDATE events SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(seal(r.id, next), s.now(), ctx.user.id, r.id)
    } else {
      throw new HttpError(400, 'Delete all, one, or following.', 'invalid')
    }
    s.audit('calendar.removed', ctx, ctx.user.id)
    return undefined
  })

  // ---- sending events out (.ics) ---------------------------------------------------------

  const tz = () => s.config.timeZone
  const icsTime = (v: string, allDay: boolean) => (allDay ? `;VALUE=DATE:${v.replace(/-/g, '')}` : `;TZID=${tz()}:${v.replace(/-/g, '').replace(':', '')}00`)
  const stamp = () => new Date(s.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')

  function vevent(uid: string, o: { title: string; allDay: boolean; start: string; end: string; location: string; notes: string }, withNotes: boolean, extra: string[] = []): string[] {
    // All-day events end the day after (exclusive), as iCalendar expects.
    const end = o.allDay ? addDays(o.end, 1) : o.end
    const lines = ['BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${stamp()}`, `DTSTART${icsTime(o.start, o.allDay)}`, `DTEND${icsTime(end, o.allDay)}`, ...extra, `SUMMARY:${escapeText(o.title)}`]
    if (o.location) lines.push(`LOCATION:${escapeText(o.location)}`)
    if (withNotes && o.notes) lines.push(`DESCRIPTION:${escapeText(o.notes)}`)
    lines.push('END:VEVENT')
    return lines
  }
  const calendar = (events: string[][]) =>
    ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Family Hub//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', ...events.flat(), 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n'

  /**
   * - `event-<id>[-notes].ics`: one event, repeats included
   * - `range-<YYYYMMDD>-<YYYYMMDD>-<all|family|person ID>[-notes].ics`: the days in a range, for everyone, Family, or one person (with Family)
   */
  api.authed('GET', '/api/calendar/export/:file', signedIn, (ctx) => {
    const file = ctx.params.file!
    let body: string
    let name: string
    let m = /^event-([A-Za-z0-9_-]{16})(-notes)?\.ics$/.exec(file)
    if (m) {
      const r = find(m[1]!)
      const e = open(r)
      const withNotes = Boolean(m[2])
      const uid = `${r.id}@family-hub`
      const main = vevent(uid, e, withNotes, e.repeat ? [toRRule(dateOf(e.start), e.repeat)] : [])
      const extra: string[][] = []
      for (const [day, x] of Object.entries(e.exceptions)) {
        const recurrenceId = `RECURRENCE-ID${icsTime(e.allDay ? day : `${day}T${timeOf(e.start)}`, e.allDay)}`
        if (x.cancelled) main.splice(main.length - 1, 0, `EXDATE${icsTime(e.allDay ? day : `${day}T${timeOf(e.start)}`, e.allDay)}`)
        else {
          const o = occurrenceOf(r.id, r.version, e, day, peopleIds(), true)
          extra.push(vevent(uid, o, withNotes, [recurrenceId]))
        }
      }
      body = calendar([main, ...extra])
      name = `${e.title.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'event'}.ics`
    } else {
      m = /^range-(\d{8})-(\d{8})-(all|family|[A-Za-z0-9_-]{16})(-notes)?\.ics$/.exec(file)
      if (!m) throw new HttpError(404, 'Not found.', 'not_found')
      const iso = (v: string) => `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`
      const from = iso(m[1]!)
      const to = iso(m[2]!)
      if (!validDay(from) || !validDay(to) || to < from || dayNum(to) - dayNum(from) > 400) throw new HttpError(400, 'Choose up to 400 days.', 'invalid')
      const who = m[3]!
      const withNotes = Boolean(m[4])
      const list = between(from, to, true).filter((o) => who === 'all' || o.tags.includes(FAMILY) || o.tags.includes(who))
      body = calendar(list.map((o) => vevent(`${o.eventId}-${o.day}@family-hub`, o, withNotes)))
      name = `family-hub ${from} to ${to}.ics`
    }
    s.audit('calendar.exported', ctx, ctx.user.id)
    ctx.res.statusCode = 200
    ctx.res.setHeader('Content-Type', 'text/calendar; charset=utf-8')
    ctx.res.setHeader('Content-Disposition', `attachment; filename="event.ics"; filename*=UTF-8''${encodeURIComponent(name)}`)
    ctx.res.setHeader('Cache-Control', 'no-store')
    ctx.res.end(body)
    return undefined
  })
}
