/**
 * Outside calendars, with approval (docs/ROADMAP.md, phase 4c).
 *
 * - A parent subscribes by link (school terms, sport fixtures). The hub
 *   fetches it every 6 hours (fetch-ics.ts: https only, never the home
 *   network, size and time limits).
 * - Nothing goes straight in: new events wait in the Calendar inbox to be
 *   accepted (with the subscription's tags, or others) or ignored, unless the
 *   subscription is set to always accept. An accepted event that is moved or
 *   cancelled at the source comes back to the inbox as Changed or Cancelled.
 * - A one-off .ics import goes through the same inbox.
 * - Clean-up: inbox items older than 30 days, and subscribed events that
 *   ended more than 30 days ago, are removed.
 *
 * Subscription links (which can contain secret tokens) and inbox items are
 * sealed with the server key; which outside events were accepted or ignored
 * is kept by a hash of their source ID.
 */
import { createHash } from 'node:crypto'
import type { Api, Services } from '../app.ts'
import { checkLink, FetchProblem } from '../fetch-ics.ts'
import { HttpError, readJson, str } from '../http.ts'
import { parseIcs, type IcsEvent } from '../ics.ts'
import { localNow } from '../schedule.ts'
import { newId } from '../secrets.ts'
import { FAMILY, type CalEvent } from './calendar.ts'

export interface Subscription {
  name: string
  url: string
  tags: string[]
  autoAccept: boolean
}

interface SubRow {
  id: string
  sealed: string
  created_at: number
  last_fetch_at: number | null
  last_ok_at: number | null
  last_error: string | null
}

interface InboxItem {
  event: IcsEvent
  status: 'new' | 'changed' | 'cancelled'
}

interface LinkRow {
  uid_hash: string
  subscription_id: string | null
  event_id: string | null
  state: 'accepted' | 'ignored'
  fingerprint: string
}

const HOLIDAYS_SETTING = 'calendar_holidays'
const REFRESH_MS = 6 * 3_600_000
const MAX_SUBSCRIPTIONS = 30
const DAY = 86_400_000

const sha = (v: string) => createHash('sha256').update(v).digest('base64url')
const uidHash = (subscriptionId: string | null, uid: string) => sha(`${subscriptionId ?? 'import'}\n${uid}`)
const fingerprint = (e: IcsEvent) => sha(JSON.stringify([e.title, e.allDay, e.start, e.end, e.location, e.notes, e.repeat, e.cancelled]))
const dayOf = (v: string) => v.slice(0, 10)
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)

export function holidaysOn(s: Services): boolean {
  return ((s.db.prepare('SELECT value FROM settings WHERE key = ?').get(HOLIDAYS_SETTING) as { value: string } | undefined)?.value ?? '1') === '1'
}

const openSub = (s: Services, r: Pick<SubRow, 'id' | 'sealed'>) => JSON.parse(s.serverKey.open(r.sealed, 'calendar-subscription', r.id)) as Subscription
const sealSub = (s: Services, id: string, sub: Subscription) => s.serverKey.seal(JSON.stringify(sub), 'calendar-subscription', id)
const openItem = (s: Services, r: { id: string; sealed: string }) => JSON.parse(s.serverKey.open(r.sealed, 'calendar-inbox', r.id)) as InboxItem
const sealEvent = (s: Services, id: string, e: CalEvent) => s.serverKey.seal(JSON.stringify(e), 'event', id)
const openEvent = (s: Services, id: string): CalEvent | null => {
  const r = s.db.prepare('SELECT sealed FROM events WHERE id = ?').get(id) as { sealed: string } | undefined
  return r ? (JSON.parse(s.serverKey.open(r.sealed, 'event', id)) as CalEvent) : null
}

/** Puts an item in the inbox, replacing any earlier one for the same outside event. */
function toInbox(s: Services, subscriptionId: string | null, hash: string, item: InboxItem): void {
  s.db.prepare('DELETE FROM calendar_inbox WHERE uid_hash = ?').run(hash)
  const id = newId()
  s.db.prepare('INSERT INTO calendar_inbox (id, subscription_id, uid_hash, sealed, created_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    subscriptionId,
    hash,
    s.serverKey.seal(JSON.stringify(item), 'calendar-inbox', id),
    s.now(),
  )
}

/** The hub's version of an outside event, tagged. */
function asEvent(e: IcsEvent, tags: string[], keep?: CalEvent | null): CalEvent {
  return {
    title: e.title,
    allDay: e.allDay,
    start: e.start,
    end: e.end < e.start ? e.start : e.end,
    tags,
    location: e.location,
    notes: e.notes,
    contactId: keep?.contactId ?? null,
    fileId: keep?.fileId ?? null,
    fileName: keep?.fileName ?? null,
    repeat: e.repeat,
    exceptions: keep && JSON.stringify(keep.repeat) === JSON.stringify(e.repeat) ? keep.exceptions : {},
    reminders: keep?.reminders ?? [],
  }
}

function createEvent(s: Services, e: CalEvent, userId: string | null): string {
  const id = newId()
  const now = s.now()
  s.db.prepare('INSERT INTO events (id, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, 1, ?, ?, ?)').run(id, sealEvent(s, id, e), now, now, userId)
  return id
}

const setLink = (s: Services, hash: string, subscriptionId: string | null, eventId: string | null, state: LinkRow['state'], fp: string) =>
  s.db
    .prepare(
      `INSERT INTO calendar_links (uid_hash, subscription_id, event_id, state, fingerprint) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (uid_hash) DO UPDATE SET event_id = excluded.event_id, state = excluded.state, fingerprint = excluded.fingerprint`,
    )
    .run(hash, subscriptionId, eventId, state, fp)

/** Live tags only (people may have been removed since). */
function liveTags(s: Services, tags: string[]): string[] {
  const people = new Set((s.db.prepare('SELECT id FROM family_profiles').all() as { id: string }[]).map((p) => p.id))
  const out = tags.filter((t) => t === FAMILY || people.has(t))
  return out.length ? out : [FAMILY]
}

/** Fetches one subscription and brings the inbox up to date. Returns how many inbox items it added. */
export async function syncSubscription(s: Services, id: string): Promise<number> {
  const row = s.db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(id) as unknown as SubRow | undefined
  if (!row) return 0
  const sub = openSub(s, row)
  const now = s.now()
  let text: string
  try {
    text = await s.icsFetch(checkLink(sub.url))
  } catch (e) {
    const message = e instanceof FetchProblem ? e.message : 'The calendar could not be read.'
    s.db.prepare('UPDATE calendar_subscriptions SET last_fetch_at = ?, last_error = ? WHERE id = ?').run(now, message, id)
    return 0
  }
  const today = localNow(now, s.config.timeZone).date
  const links = new Map((s.db.prepare('SELECT * FROM calendar_links WHERE subscription_id = ?').all(id) as unknown as LinkRow[]).map((l) => [l.uid_hash, l]))
  const seen = new Set<string>()
  let added = 0
  for (const e of parseIcs(text, s.config.timeZone)) {
    const hash = uidHash(id, e.uid)
    seen.add(hash)
    const link = links.get(hash)
    if (link?.state === 'ignored') continue
    if (!e.repeat && dayOf(e.end) < today) continue // already over
    const fp = fingerprint(e)
    if (link) {
      // Accepted before; deleted here since: leave it be.
      if (!link.event_id || !openEvent(s, link.event_id)) continue
      if (fp === link.fingerprint) continue
      toInbox(s, id, hash, { event: e, status: e.cancelled ? 'cancelled' : 'changed' })
      added++
      continue
    }
    if (e.cancelled) continue
    if (sub.autoAccept) {
      setLink(s, hash, id, createEvent(s, asEvent(e, liveTags(s, sub.tags)), null), 'accepted', fp)
      continue
    }
    const existing = s.db.prepare('SELECT id, sealed FROM calendar_inbox WHERE uid_hash = ?').get(hash) as { id: string; sealed: string } | undefined
    if (existing && fingerprint(openItem(s, existing).event) === fp) continue
    toInbox(s, id, hash, { event: e, status: 'new' })
    added++
  }
  // Accepted events that are no longer in the calendar (and not yet over): cancelled at the source.
  for (const link of links.values()) {
    if (seen.has(link.uid_hash) || link.state !== 'accepted' || !link.event_id) continue
    const ev = openEvent(s, link.event_id)
    if (!ev || (!ev.repeat && dayOf(ev.end) < today)) continue
    if (s.db.prepare('SELECT 1 FROM calendar_inbox WHERE uid_hash = ?').get(link.uid_hash)) continue
    toInbox(s, id, link.uid_hash, {
      event: { uid: '', title: ev.title, allDay: ev.allDay, start: ev.start, end: ev.end, location: ev.location, notes: ev.notes, repeat: ev.repeat, cancelled: true },
      status: 'cancelled',
    })
    added++
  }
  s.db.prepare('UPDATE calendar_subscriptions SET last_fetch_at = ?, last_ok_at = ?, last_error = NULL WHERE id = ?').run(now, now, id)
  return added
}

const running = new WeakSet<Services>()

/** Refreshes subscriptions not fetched for 6 hours, and clears out old items. Safe to call often. */
export async function syncDue(s: Services): Promise<void> {
  if (running.has(s)) return
  running.add(s)
  try {
    const now = s.now()
    for (const r of s.db.prepare('SELECT id FROM calendar_subscriptions WHERE last_fetch_at IS NULL OR last_fetch_at < ?').all(now - REFRESH_MS) as { id: string }[]) {
      await syncSubscription(s, r.id)
    }
    s.db.prepare('DELETE FROM calendar_inbox WHERE created_at < ?').run(now - 30 * DAY)
    // Subscribed events that ended over 30 days ago.
    const cutoff = addDays(localNow(now, s.config.timeZone).date, -30)
    for (const l of s.db.prepare("SELECT * FROM calendar_links WHERE subscription_id IS NOT NULL AND state = 'accepted' AND event_id IS NOT NULL").all() as unknown as LinkRow[]) {
      const ev = openEvent(s, l.event_id!)
      if (ev && !ev.repeat && dayOf(ev.end) < cutoff) s.db.prepare('DELETE FROM events WHERE id = ?').run(l.event_id)
    }
  } finally {
    running.delete(s)
  }
}

export function calendarSyncRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const

  const findSub = (id: string) => {
    const r = db.prepare('SELECT * FROM calendar_subscriptions WHERE id = ?').get(id) as unknown as SubRow | undefined
    if (!r) throw new HttpError(404, 'That calendar has been removed.', 'not_found')
    return r
  }
  const tagsFrom = (raw: unknown, fallback: string[]): string[] => {
    if (raw === undefined || raw === null) return fallback
    if (!Array.isArray(raw) || raw.length === 0 || raw.some((t) => typeof t !== 'string')) throw new HttpError(400, 'Tag who it is for (or Family).', 'invalid')
    const people = new Set((db.prepare('SELECT id FROM family_profiles').all() as { id: string }[]).map((p) => p.id))
    for (const t of raw as string[]) if (t !== FAMILY && !people.has(t)) throw new HttpError(400, 'Someone tagged is no longer in the family.', 'invalid')
    return [...new Set(raw as string[])]
  }
  const subInfo = (r: SubRow) => {
    const sub = openSub(s, r)
    let host = ''
    try {
      host = new URL(sub.url).host
    } catch {
      host = ''
    }
    return { id: r.id, name: sub.name, host, tags: liveTags(s, sub.tags), autoAccept: sub.autoAccept, lastFetchAt: r.last_fetch_at, lastOkAt: r.last_ok_at, lastError: r.last_error }
  }
  const inbox = () => {
    const subs = new Map((db.prepare('SELECT * FROM calendar_subscriptions').all() as unknown as SubRow[]).map((r) => [r.id, openSub(s, r)]))
    return (db.prepare('SELECT * FROM calendar_inbox ORDER BY created_at').all() as { id: string; subscription_id: string | null; sealed: string }[])
      .map((r) => {
        const item = openItem(s, r)
        const sub = r.subscription_id ? subs.get(r.subscription_id) : null
        return { id: r.id, subscriptionId: r.subscription_id, source: sub?.name ?? 'Imported file', defaultTags: liveTags(s, sub?.tags ?? [FAMILY]), status: item.status, event: { ...item.event, uid: undefined } }
      })
      .sort((a, b) => a.event.start.localeCompare(b.event.start))
  }
  const findItem = (id: string) => {
    const r = db.prepare('SELECT * FROM calendar_inbox WHERE id = ?').get(id) as { id: string; subscription_id: string | null; uid_hash: string; sealed: string } | undefined
    if (!r) throw new HttpError(404, 'That has already been dealt with.', 'not_found')
    return r
  }

  /** Accepts one inbox item: adds the event, applies the change, or removes the cancelled event. */
  const accept = (r: ReturnType<typeof findItem>, tags: string[] | null, userId: string) => {
    const item = openItem(s, r)
    const link = db.prepare('SELECT * FROM calendar_links WHERE uid_hash = ?').get(r.uid_hash) as unknown as LinkRow | undefined
    const fp = fingerprint(item.event)
    if (item.status === 'new') {
      const sub = r.subscription_id ? openSub(s, findSub(r.subscription_id)) : null
      const id = createEvent(s, asEvent(item.event, liveTags(s, tags ?? sub?.tags ?? [FAMILY])), userId)
      setLink(s, r.uid_hash, r.subscription_id, id, 'accepted', fp)
    } else if (item.status === 'changed' && link?.event_id) {
      const current = openEvent(s, link.event_id)
      if (current) {
        db.prepare('UPDATE events SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(
          sealEvent(s, link.event_id, asEvent(item.event, current.tags, current)),
          s.now(),
          userId,
          link.event_id,
        )
      }
      setLink(s, r.uid_hash, r.subscription_id, link.event_id, 'accepted', fp)
    } else if (item.status === 'cancelled' && link?.event_id) {
      db.prepare('DELETE FROM events WHERE id = ?').run(link.event_id)
      setLink(s, r.uid_hash, r.subscription_id, null, 'ignored', fp)
    }
    db.prepare('DELETE FROM calendar_inbox WHERE id = ?').run(r.id)
  }
  /** Ignores one: never shown again (new), or keeps the hub's version (changed, cancelled). */
  const ignore = (r: ReturnType<typeof findItem>) => {
    const item = openItem(s, r)
    const link = db.prepare('SELECT * FROM calendar_links WHERE uid_hash = ?').get(r.uid_hash) as unknown as LinkRow | undefined
    setLink(s, r.uid_hash, r.subscription_id, link?.event_id ?? null, 'ignored', fingerprint(item.event))
    db.prepare('DELETE FROM calendar_inbox WHERE id = ?').run(r.id)
  }

  // ---- settings (public holidays) --------------------------------------------------------

  api.authed('GET', '/api/calendar/settings', {}, () => ({ holidays: holidaysOn(s) }))

  api.authed('PUT', '/api/calendar/settings', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    if (typeof body.holidays !== 'boolean') throw new HttpError(400, '"holidays" must be true or false.', 'invalid')
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(HOLIDAYS_SETTING, body.holidays ? '1' : '0')
    return { holidays: body.holidays }
  })

  // ---- subscriptions -------------------------------------------------------------------

  api.authed('GET', '/api/calendar/subscriptions', parents, () => ({
    subscriptions: (db.prepare('SELECT * FROM calendar_subscriptions ORDER BY created_at').all() as unknown as SubRow[]).map(subInfo),
  }))

  /** Subscribes to a calendar by link and fetches it at once (a problem is shown on the subscription). */
  api.authed('POST', '/api/calendar/subscriptions', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const name = str(body, 'name', { max: 80 })
    let url: URL
    try {
      url = checkLink(str(body, 'url', { max: 2000 }))
    } catch (e) {
      throw new HttpError(400, e instanceof FetchProblem ? e.message : 'That is not a link.', 'invalid')
    }
    if ((db.prepare('SELECT COUNT(*) AS n FROM calendar_subscriptions').get() as { n: number }).n >= MAX_SUBSCRIPTIONS) throw new HttpError(409, 'That is as many calendars as the hub follows.', 'too_many')
    const sub: Subscription = { name, url: url.toString(), tags: tagsFrom(body.tags, [FAMILY]), autoAccept: body.autoAccept === true }
    const id = newId()
    db.prepare('INSERT INTO calendar_subscriptions (id, sealed, created_at, created_by) VALUES (?, ?, ?, ?)').run(id, sealSub(s, id, sub), s.now(), ctx.user.id)
    s.audit('calendar.subscribed', ctx, ctx.user.id, url.host)
    const added = await syncSubscription(s, id)
    return { subscription: subInfo(findSub(id)), added }
  })

  api.authed('PUT', '/api/calendar/subscriptions/:id', parents, async (ctx) => {
    const r = findSub(ctx.params.id!)
    const current = openSub(s, r)
    const body = await readJson(ctx.req)
    const next: Subscription = {
      ...current,
      name: body.name === undefined ? current.name : str(body, 'name', { max: 80 }),
      tags: tagsFrom(body.tags, current.tags),
      autoAccept: typeof body.autoAccept === 'boolean' ? body.autoAccept : current.autoAccept,
    }
    db.prepare('UPDATE calendar_subscriptions SET sealed = ? WHERE id = ?').run(sealSub(s, r.id, next), r.id)
    return { subscription: subInfo(findSub(r.id)) }
  })

  api.authed('POST', '/api/calendar/subscriptions/:id/refresh', parents, async (ctx) => {
    const r = findSub(ctx.params.id!)
    const added = await syncSubscription(s, r.id)
    return { subscription: subInfo(findSub(r.id)), added }
  })

  /** Unsubscribes; with ?removeEvents=1, also removes the events accepted from it. */
  api.authed('DELETE', '/api/calendar/subscriptions/:id', parents, (ctx) => {
    const r = findSub(ctx.params.id!)
    if (ctx.url.searchParams.get('removeEvents') === '1') {
      for (const l of db.prepare("SELECT event_id FROM calendar_links WHERE subscription_id = ? AND state = 'accepted' AND event_id IS NOT NULL").all(r.id) as { event_id: string }[]) {
        db.prepare('DELETE FROM events WHERE id = ?').run(l.event_id)
      }
    }
    db.prepare('DELETE FROM calendar_subscriptions WHERE id = ?').run(r.id)
    s.audit('calendar.unsubscribed', ctx, ctx.user.id)
    return undefined
  })

  // ---- the inbox ---------------------------------------------------------------------------

  api.authed('GET', '/api/calendar/inbox', parents, () => ({ items: inbox() }))

  api.authed('POST', '/api/calendar/inbox/:id/accept', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    accept(findItem(ctx.params.id!), body.tags === undefined ? null : tagsFrom(body.tags, [FAMILY]), ctx.user.id)
    return { items: inbox() }
  })

  api.authed('POST', '/api/calendar/inbox/:id/ignore', parents, (ctx) => {
    ignore(findItem(ctx.params.id!))
    return { items: inbox() }
  })

  /** Accepts or ignores everything waiting (from one subscription, or all). */
  api.authed('POST', '/api/calendar/inbox/all', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const action = body.action
    if (action !== 'accept' && action !== 'ignore') throw new HttpError(400, 'Accept or ignore.', 'invalid')
    const only = typeof body.subscriptionId === 'string' ? body.subscriptionId : null
    const rows = db.prepare('SELECT * FROM calendar_inbox').all() as ReturnType<typeof findItem>[]
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const r of rows) {
        if (only && r.subscription_id !== only) continue
        if (action === 'accept') accept(r, null, ctx.user.id)
        else ignore(r)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    return { items: inbox() }
  })

  // ---- one-off import -------------------------------------------------------------------

  /** Reads an .ics file into the inbox (events still to come, or repeating). The file is not kept. */
  api.authed('POST', '/api/calendar/import', parents, async (ctx) => {
    const body = await readJson(ctx.req, 5 * 1024 * 1024)
    if (typeof body.ics !== 'string' || !body.ics.includes('BEGIN:VCALENDAR')) throw new HttpError(400, 'Choose a calendar (.ics) file.', 'invalid')
    const today = localNow(s.now(), s.config.timeZone).date
    let added = 0
    let skipped = 0
    for (const e of parseIcs(body.ics, s.config.timeZone, 5000)) {
      if (e.cancelled || (!e.repeat && dayOf(e.end) < today)) {
        skipped++
        continue
      }
      const hash = uidHash(null, e.uid)
      if (db.prepare('SELECT 1 FROM calendar_links WHERE uid_hash = ?').get(hash)) {
        skipped++
        continue
      }
      toInbox(s, null, hash, { event: e, status: 'new' })
      added++
    }
    s.audit('calendar.imported', ctx, ctx.user.id, `${added} to the inbox`)
    return { added, skipped }
  })
}
