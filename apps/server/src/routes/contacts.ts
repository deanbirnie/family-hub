/**
 * Family Contacts: one shared address book for the parents (family and
 * friends, schools, doctors, insurers, tradespeople), and each person's
 * emergency contacts.
 *
 * Everything about a contact is one value sealed with the server key (tier
 * S in docs/DATA-PROTECTION.md): a copy of the database or a backup alone
 * reveals nothing, while the server can still list, search and export the
 * contacts for signed-in parents (and, later, sync them to phones over
 * CardDAV). Each sealed value is bound to its contact ID.
 */
import type { Api, Services } from '../app.ts'
import { HttpError, readJson, str } from '../http.ts'
import { newId } from '../secrets.ts'
import { localNow, parseDate } from '../schedule.ts'

export const CATEGORIES = ['family', 'friend', 'school', 'health', 'insurance', 'services', 'other'] as const
export const PHONE_LABELS = ['mobile', 'home', 'work', 'other'] as const

export const DATE_KINDS = ['birthday', 'anniversary', 'memorial', 'other'] as const
/** How far ahead to remind: off, on the day, a week before (and on the day), a month before (then a week, then on the day). */
export const REMIND = { off: [], day: [0], week: [7, 0], month: [30, 7, 0] } as const satisfies Record<string, readonly number[]>
export type Remind = keyof typeof REMIND

export interface ImportantDate {
  id: string
  kind: (typeof DATE_KINDS)[number]
  /** For 'other' (and optionally the rest): "Name day", "Moved to Perth". */
  label: string
  /** YYYY-MM-DD, or --MM-DD when the year is not known. */
  date: string
  remind: Remind
  /** 'all' parents, or one parent's user ID. */
  remindFor: string
}

export interface About {
  howWeMet: string
  interests: string
  food: string
  sizes: string
}

/** "Catch up every few weeks / months". */
export const TOUCH_INTERVALS = [0, 14, 30, 60, 90, 182, 365] as const

export interface KeepInTouch {
  /** 0 = off. */
  everyDays: number
  /** When the interval was set (counts from here until the first "We spoke"). */
  since: string | null
  lastContact: string | null
  remindFor: string
}

export interface Contact {
  name: string
  organisation: string
  role: string
  category: (typeof CATEGORIES)[number]
  phones: { label: (typeof PHONE_LABELS)[number]; number: string }[]
  emails: string[]
  address: string
  note: string
  dates: ImportantDate[]
  deceased: boolean
  about: About
  keepInTouch: KeepInTouch
}

/** Fills in what contacts saved before phase 3 do not have. */
export function normalise(raw: Partial<Contact>): Contact {
  return {
    name: raw.name ?? '',
    organisation: raw.organisation ?? '',
    role: raw.role ?? '',
    category: raw.category ?? 'other',
    phones: raw.phones ?? [],
    emails: raw.emails ?? [],
    address: raw.address ?? '',
    note: raw.note ?? '',
    dates: raw.dates ?? [],
    deceased: raw.deceased ?? false,
    about: { howWeMet: '', interests: '', food: '', sizes: '', ...(raw.about ?? {}) },
    keepInTouch: { everyDays: 0, since: null, lastContact: null, remindFor: 'all', ...(raw.keepInTouch ?? {}) },
  }
}

function keepInTouchFrom(body: Record<string, unknown>, parents: Set<string>, previous: KeepInTouch | null, today: string): KeepInTouch {
  const k = (body.keepInTouch ?? {}) as Record<string, unknown>
  const everyDays = k.everyDays === undefined ? 0 : k.everyDays
  if (typeof everyDays !== 'number' || !(TOUCH_INTERVALS as readonly number[]).includes(everyDays)) throw new HttpError(400, 'Choose how often to catch up.', 'invalid')
  const remindFor = typeof k.remindFor === 'string' && k.remindFor ? k.remindFor : 'all'
  if (remindFor !== 'all' && !parents.has(remindFor)) throw new HttpError(400, 'Reminders go to a parent.', 'invalid')
  const given = typeof k.lastContact === 'string' && k.lastContact ? k.lastContact : null
  if (given && (given.startsWith('--') || !parseDate(given))) throw new HttpError(400, 'The last time you spoke must be a date.', 'invalid')
  // The later of what was sent and what is stored ("We spoke" may have happened while the form was open).
  const stored = previous?.lastContact ?? null
  const lastContact = given && stored ? (given > stored ? given : stored) : (given ?? stored)
  // The count starts when the interval is first set (or changed).
  const since = everyDays === 0 ? null : previous && previous.everyDays === everyDays && previous.since ? previous.since : today
  return { everyDays, since, lastContact, remindFor }
}

export const RELATION_KINDS = ['partner', 'child', 'parent', 'sibling', 'grandparent', 'grandchild', 'friend', 'colleague', 'other'] as const

/** "a is b's <kind>": Lwazi (a) is Thandi's (b) child. */
export interface Relation {
  a: string
  b: string
  kind: (typeof RELATION_KINDS)[number]
  /** For 'other': "godmother", "neighbour". */
  label: string
}

export const NOTE_KINDS = ['note', 'event', 'contact'] as const
export const LIFE_EVENTS = ['new_job', 'moved', 'new_baby', 'engaged', 'married', 'graduated', 'retired', 'passed_away', 'other'] as const

/** A timeline entry: a note, a life event, or a record of being in touch. */
export interface Note {
  date: string
  kind: (typeof NOTE_KINDS)[number]
  lifeEvent: (typeof LIFE_EVENTS)[number] | null
  text: string
}

/** A gift idea, or a gift given (with when). */
export interface Gift {
  idea: string
  occasion: string
  status: 'idea' | 'given'
  date: string | null
  link: string
  note: string
}

interface EntryRow {
  id: string
  contact_id: string
  sealed: string
  created_at: number
  updated_at: number
}

export interface ContactRow {
  id: string
  sealed: string
  profile_id: string | null
  version: number
  created_at: number
  updated_at: number
  updated_by: string | null
}

const MAX_CONTACTS = 2000

const text = (body: Record<string, unknown>, key: string, max: number): string => {
  const v = body[key]
  if (v === undefined || v === null) return ''
  if (typeof v !== 'string') throw new HttpError(400, `"${key}" must be text.`, 'invalid')
  const t = v.trim()
  if (t.length > max) throw new HttpError(400, `"${key}" is too long.`, 'invalid')
  return t
}

function datesFrom(body: Record<string, unknown>, parents: Set<string>): ImportantDate[] {
  const raw = body.dates === undefined || body.dates === null ? [] : body.dates
  if (!Array.isArray(raw)) throw new HttpError(400, '"dates" must be a list.', 'invalid')
  if (raw.length > 10) throw new HttpError(400, 'At most 10 dates for one person.', 'invalid')
  return raw.map((d) => {
    const o = (d ?? {}) as Record<string, unknown>
    const kind = (o.kind ?? 'birthday') as ImportantDate['kind']
    if (!DATE_KINDS.includes(kind)) throw new HttpError(400, 'Unknown kind of date.', 'invalid')
    const label = text(o, 'label', 60)
    if (kind === 'other' && !label) throw new HttpError(400, 'Name the date (e.g. "Name day").', 'invalid')
    const date = typeof o.date === 'string' ? o.date.trim() : ''
    if (!parseDate(date)) throw new HttpError(400, 'Dates need a real day and month (the year is optional).', 'invalid')
    const remind = (o.remind ?? 'week') as Remind
    if (!(remind in REMIND)) throw new HttpError(400, 'Unknown reminder choice.', 'invalid')
    const remindFor = typeof o.remindFor === 'string' && o.remindFor ? o.remindFor : 'all'
    if (remindFor !== 'all' && !parents.has(remindFor)) throw new HttpError(400, 'Reminders go to a parent.', 'invalid')
    const id = typeof o.id === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(o.id) ? o.id : newId()
    return { id, kind, label, date, remind, remindFor }
  })
}

/** A contact from a request, checked and tidied. `parents` are the user IDs reminders may go to. */
export function contactFrom(body: Record<string, unknown>, parents: Set<string> = new Set(), previous: Contact | null = null, today = '2000-01-01'): Contact {
  const name = str(body, 'name', { max: 100 })
  const category = (body.category ?? 'other') as Contact['category']
  if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Choose a category.', 'invalid')
  const phones = Array.isArray(body.phones) ? body.phones : []
  if (phones.length > 5) throw new HttpError(400, 'At most 5 phone numbers.', 'invalid')
  const emails = Array.isArray(body.emails) ? body.emails : []
  if (emails.length > 3) throw new HttpError(400, 'At most 3 email addresses.', 'invalid')
  return {
    name,
    organisation: text(body, 'organisation', 100),
    role: text(body, 'role', 100),
    category,
    phones: phones
      .map((p) => {
        const o = (p ?? {}) as Record<string, unknown>
        const label = (o.label ?? 'mobile') as Contact['phones'][number]['label']
        const number = typeof o.number === 'string' ? o.number.trim() : ''
        if (!PHONE_LABELS.includes(label)) throw new HttpError(400, 'Unknown kind of phone number.', 'invalid')
        if (number && !/^[0-9+()\-\s.]{3,40}$/.test(number)) throw new HttpError(400, `"${number}" is not a phone number.`, 'invalid')
        return { label, number }
      })
      .filter((p) => p.number),
    emails: emails
      .map((e) => (typeof e === 'string' ? e.trim() : ''))
      .filter(Boolean)
      .map((e) => {
        if (e.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new HttpError(400, `"${e}" is not an email address.`, 'invalid')
        return e
      }),
    address: text(body, 'address', 400),
    note: text(body, 'note', 2000),
    dates: datesFrom(body, parents),
    deceased: body.deceased === true,
    about: (() => {
      const a = (body.about ?? {}) as Record<string, unknown>
      if (typeof a !== 'object' || Array.isArray(a)) throw new HttpError(400, '"about" must be an object.', 'invalid')
      return { howWeMet: text(a, 'howWeMet', 500), interests: text(a, 'interests', 500), food: text(a, 'food', 500), sizes: text(a, 'sizes', 300) }
    })(),
    keepInTouch: keepInTouchFrom(body, parents, previous?.keepInTouch ?? null, today),
  }
}

// ---- vCard 3.0 -----------------------------------------------------------------------

const escape = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`)

/** Folds a line at 75 octets, as RFC 6350 asks, without splitting a character. */
function fold(line: string): string {
  const out: string[] = []
  let current = ''
  let bytes = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(current)
      current = ''
      bytes = 0
    }
    current += ch
    bytes += n
  }
  out.push(current)
  return out.join('\r\n ')
}

const TEL_TYPES: Record<Contact['phones'][number]['label'], string> = { mobile: 'CELL', home: 'HOME', work: 'WORK', other: 'VOICE' }

export function toVCard(c: Contact, withNotes: boolean): string {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escape(c.name)}`, `N:${escape(c.name)};;;;`]
  if (c.organisation) lines.push(`ORG:${escape(c.organisation)}`)
  if (c.role) lines.push(`TITLE:${escape(c.role)}`)
  for (const p of c.phones) lines.push(`TEL;TYPE=${TEL_TYPES[p.label]}:${escape(p.number)}`)
  for (const e of c.emails) lines.push(`EMAIL;TYPE=INTERNET:${escape(e)}`)
  if (c.address) lines.push(`ADR;TYPE=HOME:;;${escape(c.address)};;;;`)
  if (withNotes && c.note) lines.push(`NOTE:${escape(c.note)}`)
  lines.push('END:VCARD')
  return lines.map(fold).join('\r\n') + '\r\n'
}

/** Opens a contact row (sealed with the server key, bound to its ID). */
export const openContact = (s: Services, r: Pick<ContactRow, 'id' | 'sealed'>): Contact => normalise(JSON.parse(s.serverKey.open(r.sealed, 'contact', r.id)) as Partial<Contact>)

/** Every relationship (sealed, one per pair). */
export function allRelations(s: Services): (Relation & { id: string })[] {
  return (s.db.prepare('SELECT id, sealed FROM contact_relations ORDER BY created_at').all() as { id: string; sealed: string }[]).map((r) => ({
    id: r.id,
    ...(JSON.parse(s.serverKey.open(r.sealed, 'relation', r.id)) as Relation),
  }))
}

export function contactRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const
  const today = () => localNow(s.now(), s.config.timeZone).date
  const parentIds = () => new Set((db.prepare("SELECT id FROM users WHERE role = 'admin'").all() as { id: string }[]).map((u) => u.id))
  const seal = (id: string, c: Contact) => s.serverKey.seal(JSON.stringify(c), 'contact', id)
  const open = (r: ContactRow): Contact => openContact(s, r)
  const info = (r: ContactRow) => ({ id: r.id, version: r.version, updatedAt: r.updated_at, profileId: r.profile_id, ...open(r) })
  /** The Quick Info person a contact is, if any: must exist and not be another contact already. */
  const profileFrom = (body: Record<string, unknown>, contactId: string | null): string | null => {
    const v = body.profileId
    if (v === undefined || v === null || v === '') return null
    if (typeof v !== 'string' || !db.prepare('SELECT 1 FROM family_profiles WHERE id = ?').get(v)) throw new HttpError(400, 'No such person in Quick Info.', 'invalid')
    const taken = db.prepare('SELECT id FROM contacts WHERE profile_id = ?').get(v) as { id: string } | undefined
    if (taken && taken.id !== contactId) throw new HttpError(409, 'That person is already linked to another contact.', 'profile_taken')
    return v
  }
  const find = (id: string) => {
    const r = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as unknown as ContactRow | undefined
    if (!r) throw new HttpError(404, 'That contact has been deleted.', 'not_found')
    return r
  }
  const all = () =>
    (db.prepare('SELECT * FROM contacts').all() as unknown as ContactRow[])
      .map(info)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

  api.authed('GET', '/api/contacts', parents, () => ({ contacts: all(), relations: allRelations(s) }))

  api.authed('POST', '/api/contacts', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const contact = contactFrom(body, parentIds(), null, today())
    const profileId = profileFrom(body, null)
    if ((db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n >= MAX_CONTACTS) {
      throw new HttpError(409, 'The address book is full.', 'too_many')
    }
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO contacts (id, sealed, profile_id, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?)').run(
      id,
      seal(id, contact),
      profileId,
      now,
      now,
      ctx.user.id,
    )
    s.audit('contacts.added', ctx, ctx.user.id)
    return { contact: info(find(id)) }
  })

  /** Replaces a contact, only if nobody changed it since `baseVersion`. */
  api.authed('PUT', '/api/contacts/:id', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const r = find(ctx.params.id!)
    const base = body.baseVersion
    if (typeof base !== 'number' || !Number.isInteger(base)) throw new HttpError(400, '"baseVersion" is required.', 'invalid')
    const changed = db
      .prepare('UPDATE contacts SET sealed = ?, profile_id = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?')
      .run(seal(r.id, contactFrom(body, parentIds(), open(r), today())), profileFrom(body, r.id), s.now(), ctx.user.id, r.id, base)
    if (Number(changed.changes) !== 1) {
      throw new HttpError(409, 'Someone else changed this contact while you were editing. Reload to see their changes.', 'edit_conflict')
    }
    s.audit('contacts.updated', ctx, ctx.user.id)
    return { contact: info(find(r.id)) }
  })

  api.authed('DELETE', '/api/contacts/:id', parents, (ctx) => {
    const r = find(ctx.params.id!)
    db.prepare('DELETE FROM contacts WHERE id = ?').run(r.id)
    for (const rel of allRelations(s)) if (rel.a === r.id || rel.b === r.id) db.prepare('DELETE FROM contact_relations WHERE id = ?').run(rel.id)
    // No longer anyone's emergency contact.
    for (const p of db.prepare('SELECT id, emergency FROM family_profiles WHERE emergency IS NOT NULL').all() as { id: string; emergency: string }[]) {
      const e = openEmergency(s, p.id, p.emergency)
      if (e.primary === r.id || e.backup === r.id) {
        sealEmergency(s, p.id, { primary: e.primary === r.id ? null : e.primary, backup: e.backup === r.id ? null : e.backup })
      }
    }
    s.audit('contacts.removed', ctx, ctx.user.id)
    return undefined
  })

  // ---- relationships -------------------------------------------------------------------

  /** Adds "a is b's <kind>" (shown both ways). One relationship per pair. */
  api.authed('POST', '/api/contacts/relations', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const a = find(str(body, 'a', { max: 40 })).id
    const b = find(str(body, 'b', { max: 40 })).id
    if (a === b) throw new HttpError(400, 'Choose two different people.', 'invalid')
    const kind = body.kind as Relation['kind']
    if (!RELATION_KINDS.includes(kind)) throw new HttpError(400, 'Unknown relationship.', 'invalid')
    const label = text(body, 'label', 40)
    if (kind === 'other' && !label) throw new HttpError(400, 'Say what the relationship is (e.g. "godmother").', 'invalid')
    const existing = allRelations(s)
    if (existing.some((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a))) throw new HttpError(409, 'Those two are already linked. Remove that first.', 'relation_exists')
    if (existing.length >= 5000) throw new HttpError(409, 'Too many relationships.', 'too_many')
    const id = newId()
    const relation: Relation = { a, b, kind, label }
    db.prepare('INSERT INTO contact_relations (id, sealed, created_at) VALUES (?, ?, ?)').run(id, s.serverKey.seal(JSON.stringify(relation), 'relation', id), s.now())
    s.audit('contacts.relation_added', ctx, ctx.user.id)
    return { relation: { id, ...relation } }
  })

  api.authed('DELETE', '/api/contacts/relations/:id', parents, (ctx) => {
    const changed = db.prepare('DELETE FROM contact_relations WHERE id = ?').run(ctx.params.id!)
    if (Number(changed.changes) !== 1) throw new HttpError(404, 'That relationship has already been removed.', 'not_found')
    s.audit('contacts.relation_removed', ctx, ctx.user.id)
    return undefined
  })

  // ---- notes, timeline and gifts ------------------------------------------------------------

  const sealEntry = (purpose: string, contactId: string, id: string, value: unknown) => s.serverKey.seal(JSON.stringify(value), purpose, `${contactId}/${id}`)
  const openEntry = <T,>(purpose: string, row: { id: string; contact_id: string; sealed: string }) =>
    JSON.parse(s.serverKey.open(row.sealed, purpose, `${row.contact_id}/${row.id}`)) as T
  const entryDate = (body: Record<string, unknown>, key = 'date') => {
    const v = body[key]
    if (v === undefined || v === null || v === '') return today()
    if (typeof v !== 'string' || v.startsWith('--') || !parseDate(v)) throw new HttpError(400, 'Choose a date.', 'invalid')
    return v
  }
  const noteFrom = (body: Record<string, unknown>): Note => {
    const kind = (body.kind ?? 'note') as Note['kind']
    if (!NOTE_KINDS.includes(kind)) throw new HttpError(400, 'Unknown kind of entry.', 'invalid')
    const lifeEvent = kind === 'event' ? ((body.lifeEvent ?? 'other') as Note['lifeEvent']) : null
    if (lifeEvent !== null && !LIFE_EVENTS.includes(lifeEvent)) throw new HttpError(400, 'Unknown life event.', 'invalid')
    const textValue = text(body, 'text', 4000)
    if (!textValue && kind === 'note') throw new HttpError(400, 'Write something first.', 'invalid')
    return { date: entryDate(body), kind, lifeEvent, text: textValue }
  }
  const giftFrom = (body: Record<string, unknown>): Gift => {
    const idea = str(body, 'idea', { max: 200 })
    const occasion = text(body, 'occasion', 60)
    const status = (body.status ?? 'idea') as Gift['status']
    if (status !== 'idea' && status !== 'given') throw new HttpError(400, 'A gift is an idea or given.', 'invalid')
    const link = text(body, 'link', 500)
    if (link && !/^https:\/\/[^\s]+$/.test(link)) throw new HttpError(400, 'Links must start with https://', 'invalid')
    return { idea, occasion, status, date: status === 'given' ? entryDate(body) : null, link, note: text(body, 'note', 1000) }
  }
  const timeline = (contactId: string) => ({
    notes: (db.prepare('SELECT * FROM contact_notes WHERE contact_id = ?').all(contactId) as unknown as EntryRow[])
      .map((r) => ({ id: r.id, createdAt: r.created_at, ...openEntry<Note>('contact-note', r) }))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt),
    gifts: (db.prepare('SELECT * FROM contact_gifts WHERE contact_id = ? ORDER BY created_at DESC').all(contactId) as unknown as EntryRow[]).map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      ...openEntry<Gift>('contact-gift', r),
    })),
  })
  const count = (table: string, contactId: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE contact_id = ?`).get(contactId) as { n: number }).n
  const findEntry = (table: 'contact_notes' | 'contact_gifts', id: string) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as unknown as EntryRow | undefined
    if (!row) throw new HttpError(404, 'That entry has been deleted.', 'not_found')
    return row
  }

  api.authed('GET', '/api/contacts/:id/timeline', parents, (ctx) => timeline(find(ctx.params.id!).id))

  api.authed('POST', '/api/contacts/:id/notes', parents, async (ctx) => {
    const contactId = find(ctx.params.id!).id
    const note = noteFrom(await readJson(ctx.req))
    if (count('contact_notes', contactId) >= 1000) throw new HttpError(409, 'This person has as many notes as they can hold.', 'too_many')
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO contact_notes (id, contact_id, sealed, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      contactId,
      sealEntry('contact-note', contactId, id, note),
      now,
      now,
      ctx.user.id,
    )
    s.audit('contacts.note_added', ctx, ctx.user.id)
    return timeline(contactId)
  })

  api.authed('PUT', '/api/contacts/notes/:noteId', parents, async (ctx) => {
    const row = findEntry('contact_notes', ctx.params.noteId!)
    const note = noteFrom(await readJson(ctx.req))
    db.prepare('UPDATE contact_notes SET sealed = ?, updated_at = ? WHERE id = ?').run(sealEntry('contact-note', row.contact_id, row.id, note), s.now(), row.id)
    return timeline(row.contact_id)
  })

  api.authed('DELETE', '/api/contacts/notes/:noteId', parents, (ctx) => {
    const row = findEntry('contact_notes', ctx.params.noteId!)
    db.prepare('DELETE FROM contact_notes WHERE id = ?').run(row.id)
    s.audit('contacts.note_removed', ctx, ctx.user.id)
    return timeline(row.contact_id)
  })

  api.authed('POST', '/api/contacts/:id/gifts', parents, async (ctx) => {
    const contactId = find(ctx.params.id!).id
    const gift = giftFrom(await readJson(ctx.req))
    if (count('contact_gifts', contactId) >= 500) throw new HttpError(409, 'This person has as many gift ideas as they can hold.', 'too_many')
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO contact_gifts (id, contact_id, sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, contactId, sealEntry('contact-gift', contactId, id, gift), now, now)
    s.audit('contacts.gift_added', ctx, ctx.user.id)
    return timeline(contactId)
  })

  api.authed('PUT', '/api/contacts/gifts/:giftId', parents, async (ctx) => {
    const row = findEntry('contact_gifts', ctx.params.giftId!)
    const gift = giftFrom(await readJson(ctx.req))
    db.prepare('UPDATE contact_gifts SET sealed = ?, updated_at = ? WHERE id = ?').run(sealEntry('contact-gift', row.contact_id, row.id, gift), s.now(), row.id)
    return timeline(row.contact_id)
  })

  api.authed('DELETE', '/api/contacts/gifts/:giftId', parents, (ctx) => {
    const row = findEntry('contact_gifts', ctx.params.giftId!)
    db.prepare('DELETE FROM contact_gifts WHERE id = ?').run(row.id)
    return timeline(row.contact_id)
  })

  /** "We spoke": records the last contact (for stay-in-touch reminders) and a timeline entry. */
  api.authed('POST', '/api/contacts/:id/spoke', parents, async (ctx) => {
    const r = find(ctx.params.id!)
    const body = await readJson(ctx.req)
    const date = entryDate(body)
    const contact = open(r)
    if (!contact.keepInTouch.lastContact || date > contact.keepInTouch.lastContact) contact.keepInTouch.lastContact = date
    const note: Note = { date, kind: 'contact', lifeEvent: null, text: text(body, 'text', 4000) }
    const id = newId()
    const now = s.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE contacts SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(seal(r.id, contact), now, ctx.user.id, r.id)
      db.prepare('INSERT INTO contact_notes (id, contact_id, sealed, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?)').run(
        id,
        r.id,
        sealEntry('contact-note', r.id, id, note),
        now,
        now,
        ctx.user.id,
      )
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    s.audit('contacts.spoke', ctx, ctx.user.id)
    return { contact: info(find(r.id)), ...timeline(r.id) }
  })

  /** A vCard file: `all`, or one contact ID; add `-notes` to include internal notes. */
  api.authed('GET', '/api/contacts/export/:file', parents, (ctx) => {
    const m = /^(all|[A-Za-z0-9_-]{16})(-notes)?\.vcf$/.exec(ctx.params.file!)
    if (!m) throw new HttpError(404, 'Not found.', 'not_found')
    const withNotes = Boolean(m[2])
    const contacts = m[1] === 'all' ? all() : [info(find(m[1]!))]
    const body = contacts.map((c) => toVCard(c, withNotes)).join('')
    const name = m[1] === 'all' ? 'family-contacts.vcf' : `${contacts[0]!.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'contact'}.vcf`
    s.audit('contacts.exported', ctx, ctx.user.id, `${contacts.length}${withNotes ? ' with notes' : ''}`)
    ctx.res.statusCode = 200
    ctx.res.setHeader('Content-Type', 'text/vcard; charset=utf-8')
    ctx.res.setHeader('Content-Disposition', `attachment; filename="contacts.vcf"; filename*=UTF-8''${encodeURIComponent(name)}`)
    ctx.res.setHeader('Cache-Control', 'no-store')
    ctx.res.end(body)
    return undefined
  })

  /** A person's emergency contacts (from Quick Info), by contact ID. */
  api.authed('PUT', '/api/quick-info/profiles/:id/emergency', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const profile = db.prepare('SELECT id FROM family_profiles WHERE id = ?').get(ctx.params.id!) as { id: string } | undefined
    if (!profile) throw new HttpError(404, 'That person is no longer in Quick Info.', 'not_found')
    const pick = (key: 'primary' | 'backup') => {
      const v = body[key]
      if (v === null || v === undefined || v === '') return null
      if (typeof v !== 'string') throw new HttpError(400, `"${key}" must be a contact.`, 'invalid')
      return find(v).id
    }
    const emergency = { primary: pick('primary'), backup: pick('backup') }
    if (emergency.primary && emergency.primary === emergency.backup) throw new HttpError(400, 'Choose two different people.', 'invalid')
    sealEmergency(s, profile.id, emergency)
    s.audit('contacts.emergency_set', ctx, ctx.user.id)
    return { emergency }
  })
}

export interface Emergency {
  primary: string | null
  backup: string | null
}

export function openEmergency(s: Services, profileId: string, sealed: string | null): Emergency {
  if (!sealed) return { primary: null, backup: null }
  return JSON.parse(s.serverKey.open(sealed, 'emergency', profileId)) as Emergency
}

function sealEmergency(s: Services, profileId: string, e: Emergency): void {
  s.db.prepare('UPDATE family_profiles SET emergency = ? WHERE id = ?').run(
    e.primary || e.backup ? s.serverKey.seal(JSON.stringify(e), 'emergency', profileId) : null,
    profileId,
  )
}
