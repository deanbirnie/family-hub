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
import { parseVCards, toICS, toLabelsCsv, toVCard, type CalendarEntry, type ImportedContact, type Related } from '../vcard.ts'

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
  /** IDs of the groups they are in ("Book club", "Christmas card list"). */
  groups: string[]
  /**
   * Family members kept on this contact rather than as contacts of their own
   * (e.g. a friend's young daughter): a name and a birthday with reminders.
   */
  members: Member[]
}

export interface Member {
  id: string
  name: string
  kind: 'child'
  /** Birthday: YYYY-MM-DD or --MM-DD; null if not known. */
  date: string | null
  remind: Remind
  remindFor: string
  /** The other parent's contact, where the child is shown too. */
  alsoOf: string | null
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
    groups: raw.groups ?? [],
    members: raw.members ?? [],
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

/** What b is to a, when a is b's <kind>. */
export const INVERSE_RELATION: Record<(typeof RELATION_KINDS)[number], (typeof RELATION_KINDS)[number]> = {
  partner: 'partner',
  child: 'parent',
  parent: 'child',
  sibling: 'sibling',
  grandparent: 'grandchild',
  grandchild: 'grandparent',
  friend: 'friend',
  colleague: 'colleague',
  other: 'other',
}

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

/** A gift idea, on its way from idea to bought, wrapped and given (with when). */
export interface Gift {
  idea: string
  occasion: string
  status: GiftStatus
  /** When it was given. */
  date: string | null
  link: string
  note: string
  /** What it costs (or cost), in cents (gift planner, 8c). */
  amount: number | null
  /** The day it is for: an occurrence of their birthday, Christmas, or another day (8c). */
  forDate: string | null
  /** The planned expense in the budget that covers it (8c). */
  plannedId: string | null
}
export type GiftStatus = 'idea' | 'bought' | 'wrapped' | 'given'
export const GIFT_STATUSES: GiftStatus[] = ['idea', 'bought', 'wrapped', 'given']
/** Gifts recorded before the planner have no amount, day or planned expense. */
export const giftDefaults = (g: Partial<Gift>): Gift => ({
  idea: g.idea ?? '',
  occasion: g.occasion ?? '',
  status: g.status ?? 'idea',
  date: g.date ?? null,
  link: g.link ?? '',
  note: g.note ?? '',
  amount: g.amount ?? null,
  forDate: g.forDate ?? null,
  plannedId: g.plannedId ?? null,
})

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
    groups: (() => {
      const g = body.groups === undefined || body.groups === null ? [] : body.groups
      if (!Array.isArray(g) || g.length > 50 || g.some((x) => typeof x !== 'string' || !/^[A-Za-z0-9_-]{1,24}$/.test(x))) {
        throw new HttpError(400, '"groups" must be a list of groups.', 'invalid')
      }
      return [...new Set(g as string[])]
    })(),
    // Family members are changed through their own routes; a contact edit keeps them.
    members: previous?.members ?? [],
  }
}

// vCard, calendar and CSV formats: see vcard.ts.
export { toVCard } from '../vcard.ts'

/** Opens a contact row (sealed with the server key, bound to its ID). */
export const openContact = (s: Services, r: Pick<ContactRow, 'id' | 'sealed'>): Contact => normalise(JSON.parse(s.serverKey.open(r.sealed, 'contact', r.id)) as Partial<Contact>)

/** Every relationship (sealed, one per pair). */
export function allRelations(s: Services): (Relation & { id: string })[] {
  return (s.db.prepare('SELECT id, sealed FROM contact_relations ORDER BY created_at').all() as { id: string; sealed: string }[]).map((r) => ({
    id: r.id,
    ...(JSON.parse(s.serverKey.open(r.sealed, 'relation', r.id)) as Relation),
  }))
}

export interface ContactDate {
  /** Stable: which date this is. */
  key: string
  contactId: string
  /** "Gran’s birthday", "Isla’s birthday". */
  title: string
  kind: ImportantDate['kind']
  /** YYYY-MM-DD or --MM-DD. */
  date: string
  remind: Remind
  remindFor: string
  /** For someone who has died: birthdays and anniversaries stop. */
  stopped: boolean
  /** "Wade’s daughter", for children kept on a contact. */
  of: string | null
}

const DATE_WORDS: Record<ImportantDate['kind'], string> = { birthday: 'birthday', anniversary: 'anniversary', memorial: 'memorial', other: 'date' }

/** Every date in Contacts (and of children kept on contacts), opened from the sealed contacts. */
export function contactDates(s: Services): ContactDate[] {
  const out: ContactDate[] = []
  for (const row of s.db.prepare('SELECT id, sealed FROM contacts').all() as { id: string; sealed: string }[]) {
    let c: Contact
    try {
      c = openContact(s, row)
    } catch {
      continue
    }
    for (const d of c.dates) {
      out.push({
        key: `c:${row.id}:${d.id}`,
        contactId: row.id,
        title: `${c.name}’s ${d.label || DATE_WORDS[d.kind]}`,
        kind: d.kind,
        date: d.date,
        remind: d.remind,
        remindFor: d.remindFor || 'all',
        stopped: c.deceased && (d.kind === 'birthday' || d.kind === 'anniversary'),
        of: null,
      })
    }
    for (const m of c.members) {
      if (!m.date) continue
      out.push({
        key: `m:${row.id}:${m.id}`,
        contactId: row.id,
        title: `${m.name}’s birthday`,
        kind: 'birthday',
        date: m.date,
        remind: m.remind,
        remindFor: m.remindFor || 'all',
        stopped: false,
        of: c.name,
      })
    }
  }
  return out
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
  const allGroups = () =>
    (db.prepare('SELECT id, sealed FROM contact_groups ORDER BY created_at').all() as { id: string; sealed: string }[])
      .map((g) => ({ id: g.id, ...(JSON.parse(s.serverKey.open(g.sealed, 'contact-group', g.id)) as { name: string }) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  /** Drops groups that no longer exist. */
  const knownGroups = (c: Contact): Contact => {
    const ids = new Set((db.prepare('SELECT id FROM contact_groups').all() as { id: string }[]).map((g) => g.id))
    return { ...c, groups: c.groups.filter((g) => ids.has(g)) }
  }
  const all = () =>
    (db.prepare('SELECT * FROM contacts').all() as unknown as ContactRow[])
      .map(info)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

  api.authed('GET', '/api/contacts', parents, () => ({ contacts: all(), relations: allRelations(s), groups: allGroups() }))

  api.authed('POST', '/api/contacts', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const contact = knownGroups(contactFrom(body, parentIds(), null, today()))
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
      .run(seal(r.id, knownGroups(contactFrom(body, parentIds(), open(r), today()))), profileFrom(body, r.id), s.now(), ctx.user.id, r.id, base)
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
    // Children shown under this contact too are now shown only under their own parent.
    for (const other of db.prepare('SELECT * FROM contacts').all() as unknown as ContactRow[]) {
      const c = open(other)
      if (c.members.some((m) => m.alsoOf === r.id)) {
        db.prepare('UPDATE contacts SET sealed = ?, version = version + 1 WHERE id = ?').run(seal(other.id, { ...c, members: c.members.map((m) => (m.alsoOf === r.id ? { ...m, alsoOf: null } : m)) }), other.id)
      }
    }
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
    const status = (body.status ?? 'idea') as GiftStatus
    if (!GIFT_STATUSES.includes(status)) throw new HttpError(400, 'A gift is an idea, bought, wrapped or given.', 'invalid')
    const link = text(body, 'link', 500)
    if (link && !/^https:\/\/[^\s]+$/.test(link)) throw new HttpError(400, 'Links must start with https://', 'invalid')
    const amount = body.amount === undefined || body.amount === null || body.amount === '' ? null : body.amount
    if (amount !== null && (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0 || amount > 100_000_000_00)) throw new HttpError(400, 'The amount must be in cents.', 'invalid')
    const forDate = body.forDate === undefined || body.forDate === null || body.forDate === '' ? null : body.forDate
    if (forDate !== null && (typeof forDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(forDate) || !parseDate(forDate))) throw new HttpError(400, 'Choose the day it is for.', 'invalid')
    // A planned expense deleted from the budget since simply drops away.
    const plannedId = typeof body.plannedId === 'string' && db.prepare("SELECT 1 FROM budget WHERE kind = 'planned' AND id = ?").get(body.plannedId) ? body.plannedId : null
    return {
      idea,
      occasion,
      status,
      date: status === 'given' ? entryDate(body) : null,
      link,
      note: text(body, 'note', 1000),
      amount: amount as number | null,
      forDate: forDate as string | null,
      plannedId: plannedId as string | null,
    }
  }
  const timeline = (contactId: string) => ({
    notes: (db.prepare('SELECT * FROM contact_notes WHERE contact_id = ?').all(contactId) as unknown as EntryRow[])
      .map((r) => ({ id: r.id, createdAt: r.created_at, ...openEntry<Note>('contact-note', r) }))
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt),
    gifts: (db.prepare('SELECT * FROM contact_gifts WHERE contact_id = ? ORDER BY created_at DESC').all(contactId) as unknown as EntryRow[]).map((r) => ({
      id: r.id,
      createdAt: r.created_at,
      ...giftDefaults(openEntry<Partial<Gift>>('contact-gift', r)),
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

  // ---- groups -------------------------------------------------------------------------

  const groupName = (body: Record<string, unknown>) => str(body, 'name', { max: 60 })
  const sealGroup = (id: string, name: string) => s.serverKey.seal(JSON.stringify({ name }), 'contact-group', id)

  api.authed('POST', '/api/contacts/groups', parents, async (ctx) => {
    const name = groupName(await readJson(ctx.req))
    const existing = allGroups()
    if (existing.length >= 100) throw new HttpError(409, 'There are as many groups as there can be.', 'too_many')
    if (existing.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'There is already a group with that name.', 'group_exists')
    const id = newId()
    db.prepare('INSERT INTO contact_groups (id, sealed, created_at) VALUES (?, ?, ?)').run(id, sealGroup(id, name), s.now())
    s.audit('contacts.group_added', ctx, ctx.user.id)
    return { group: { id, name }, groups: allGroups() }
  })

  api.authed('PUT', '/api/contacts/groups/:groupId', parents, async (ctx) => {
    const id = ctx.params.groupId!
    if (!db.prepare('SELECT 1 FROM contact_groups WHERE id = ?').get(id)) throw new HttpError(404, 'That group has been deleted.', 'not_found')
    const name = groupName(await readJson(ctx.req))
    if (allGroups().some((g) => g.id !== id && g.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'There is already a group with that name.', 'group_exists')
    db.prepare('UPDATE contact_groups SET sealed = ? WHERE id = ?').run(sealGroup(id, name), id)
    return { groups: allGroups() }
  })

  /** Deletes a group (not its people); they are taken out of it. */
  api.authed('DELETE', '/api/contacts/groups/:groupId', parents, (ctx) => {
    const id = ctx.params.groupId!
    if (Number(db.prepare('DELETE FROM contact_groups WHERE id = ?').run(id).changes) !== 1) throw new HttpError(404, 'That group has been deleted.', 'not_found')
    for (const r of db.prepare('SELECT * FROM contacts').all() as unknown as ContactRow[]) {
      const c = open(r)
      if (c.groups.includes(id)) {
        db.prepare('UPDATE contacts SET sealed = ?, version = version + 1 WHERE id = ?').run(seal(r.id, { ...c, groups: c.groups.filter((g) => g !== id) }), r.id)
      }
    }
    s.audit('contacts.group_removed', ctx, ctx.user.id)
    return { groups: allGroups() }
  })

  // ---- exports ----------------------------------------------------------------------------

  /** Who an export covers: `all`, `group-<id>`, or (vCard only) one contact ID. */
  const exportScope = (which: string, allowOne: boolean) => {
    if (which === 'all') return { contacts: all(), name: 'family-contacts' }
    if (which.startsWith('group-')) {
      const group = allGroups().find((g) => g.id === which.slice(6))
      if (!group) throw new HttpError(404, 'That group has been deleted.', 'not_found')
      return { contacts: all().filter((c) => c.groups.includes(group.id)), name: group.name }
    }
    if (!allowOne) throw new HttpError(404, 'Not found.', 'not_found')
    const one = info(find(which))
    return { contacts: [one], name: one.name }
  }
  const safeName = (name: string) => name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'contacts'
  const download = (ctx: { res: import('node:http').ServerResponse }, type: string, name: string, body: string) => {
    ctx.res.statusCode = 200
    ctx.res.setHeader('Content-Type', type)
    ctx.res.setHeader('Content-Disposition', `attachment; filename="export"; filename*=UTF-8''${encodeURIComponent(name)}`)
    ctx.res.setHeader('Cache-Control', 'no-store')
    ctx.res.end(body)
  }

  /**
   * Exports, by file name:
   * - `<all|group-ID|contact ID>[-notes].vcf`: vCards, with dates and related names; notes only with `-notes`
   * - `<all|group-ID>-dates.ics`: birthdays and anniversaries as yearly calendar events
   * - `<all|group-ID>-labels.csv`: names and postal addresses
   */
  api.authed('GET', '/api/contacts/export/:file', parents, (ctx) => {
    const file = ctx.params.file!
    const id = '[A-Za-z0-9_-]{16}'
    let m = new RegExp(`^(all|group-${id}|${id})(-notes)?\\.vcf$`).exec(file)
    if (m) {
      const withNotes = Boolean(m[2])
      const scope = exportScope(m[1]!, true)
      const names = new Map(all().map((c) => [c.id, c.name]))
      const relations = allRelations(s)
      const everyone = all()
      const relatedTo = (cid: string): Related[] => [
        ...relations.flatMap((r): Related[] => {
          // r.a is r.b's <kind>.
          if (r.b === cid && names.has(r.a)) return [{ name: names.get(r.a)!, kind: r.kind, label: r.label }]
          if (r.a === cid && names.has(r.b)) return [{ name: names.get(r.b)!, kind: INVERSE_RELATION[r.kind], label: r.label }]
          return []
        }),
        // Children kept on this contact, or on their other parent's.
        ...everyone.flatMap((c) => c.members.filter((m) => c.id === cid || m.alsoOf === cid).map((m): Related => ({ name: m.name, kind: 'child', label: '' }))),
      ]
      const body = scope.contacts.map((c) => toVCard(c, withNotes, relatedTo(c.id))).join('')
      s.audit('contacts.exported', ctx, ctx.user.id, `${scope.contacts.length} vcard${withNotes ? ' with notes' : ''}`)
      download(ctx, 'text/vcard; charset=utf-8', `${safeName(scope.name)}.vcf`, body)
      return undefined
    }
    m = new RegExp(`^(all|group-${id})-(dates\\.ics|labels\\.csv)$`).exec(file)
    if (!m) throw new HttpError(404, 'Not found.', 'not_found')
    const scope = exportScope(m[1]!, false)
    if (m[2] === 'dates.ics') {
      const ids = new Set(scope.contacts.map((c) => c.id))
      const entries: CalendarEntry[] = contactDates(s)
        .filter((d) => ids.has(d.contactId) && !d.stopped)
        .map((d) => ({ uid: `${d.key.replace(/:/g, '-')}@family-hub`, summary: d.title, date: d.date }))
      s.audit('contacts.exported', ctx, ctx.user.id, `${entries.length} dates`)
      download(ctx, 'text/calendar; charset=utf-8', `${safeName(scope.name)} dates.ics`, toICS(entries, s.now(), Number(today().slice(0, 4))))
    } else {
      s.audit('contacts.exported', ctx, ctx.user.id, `${scope.contacts.length} labels`)
      download(ctx, 'text/csv; charset=utf-8', `${safeName(scope.name)} addresses.csv`, toLabelsCsv(scope.contacts))
    }
    return undefined
  })

  // ---- import ---------------------------------------------------------------------------

  const IMPORT_LIMIT = 5 * 1024 * 1024
  const digits = (n: string) => n.replace(/\D/g, '').slice(-9)

  /** Reads a vCard file and shows what would be added, marking people who look like existing contacts. Nothing is stored. */
  api.authed('POST', '/api/contacts/import/preview', parents, async (ctx) => {
    const body = await readJson(ctx.req, IMPORT_LIMIT)
    if (typeof body.vcf !== 'string') throw new HttpError(400, 'Choose a .vcf file.', 'invalid')
    const cards = parseVCards(body.vcf)
    if (cards.length === 0) throw new HttpError(400, 'No contacts were found in that file. Is it a vCard (.vcf) file?', 'invalid')
    if (cards.length > MAX_CONTACTS) throw new HttpError(400, `That file has more than ${MAX_CONTACTS} contacts.`, 'invalid')
    const existing = all()
    const match = (c: ImportedContact) =>
      existing.find(
        (e) =>
          e.name.toLowerCase() === c.name.toLowerCase() ||
          c.phones.some((p) => e.phones.some((q) => digits(q.number).length >= 7 && digits(q.number) === digits(p.number))) ||
          c.emails.some((m2) => e.emails.some((f) => f.toLowerCase() === m2.toLowerCase())),
      )
    return { contacts: cards.map((c) => ({ ...c, duplicateOf: match(c)?.id ?? null, duplicateName: match(c)?.name ?? null })) }
  })

  /** Adds the chosen people from a preview, then links related names that match exactly one person. */
  api.authed('POST', '/api/contacts/import', parents, async (ctx) => {
    const body = await readJson(ctx.req, IMPORT_LIMIT)
    const list = body.contacts
    if (!Array.isArray(list) || list.length === 0) throw new HttpError(400, 'Choose who to add.', 'invalid')
    const category = (body.category ?? 'friend') as Contact['category']
    if (!CATEGORIES.includes(category)) throw new HttpError(400, 'Choose a category.', 'invalid')
    const groupId = typeof body.groupId === 'string' && body.groupId ? body.groupId : null
    if (groupId && !allGroups().some((g) => g.id === groupId)) throw new HttpError(400, 'That group has been deleted.', 'invalid')
    const count = (db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n
    if (count + list.length > MAX_CONTACTS) throw new HttpError(409, 'That would make the address book too big.', 'too_many')
    const parents = parentIds()
    const added: { id: string; name: string; related: ImportedContact['related'] }[] = []
    const skipped: { name: string; reason: string }[] = []
    const now = s.now()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const raw of list) {
        const item = (raw ?? {}) as Record<string, unknown>
        try {
          const dates = Array.isArray(item.dates) ? (item.dates as Record<string, unknown>[]).slice(0, 10).map((d) => ({ ...d, remind: d.kind === 'birthday' ? 'week' : 'off' })) : []
          const contact = contactFrom({ ...item, category, dates, groups: groupId ? [groupId] : [] }, parents, null, today())
          const id = newId()
          db.prepare('INSERT INTO contacts (id, sealed, profile_id, version, created_at, updated_at, updated_by) VALUES (?, ?, NULL, 1, ?, ?, ?)').run(id, seal(id, contact), now, now, ctx.user.id)
          const related = Array.isArray(item.related) ? (item.related as ImportedContact['related']).slice(0, 20) : []
          added.push({ id, name: contact.name, related })
        } catch (e) {
          skipped.push({ name: typeof item.name === 'string' ? item.name.slice(0, 100) : '?', reason: e instanceof HttpError ? e.message : 'Could not be read.' })
        }
      }
      // Related names: link to the one contact with exactly that name, if there is one.
      const everyone = all()
      const relations = allRelations(s)
      const linked = new Set(relations.map((r) => [r.a, r.b].sort().join('|')))
      let links = 0
      for (const person of added) {
        for (const rel of person.related) {
          if (!RELATION_KINDS.includes(rel.kind)) continue
          const matches = everyone.filter((c) => c.id !== person.id && c.name.toLowerCase() === String(rel.name).toLowerCase())
          if (matches.length !== 1) continue
          const pair = [matches[0]!.id, person.id].sort().join('|')
          if (linked.has(pair)) continue
          linked.add(pair)
          const rid = newId()
          const relation: Relation = { a: matches[0]!.id, b: person.id, kind: rel.kind, label: rel.kind === 'other' ? String(rel.label || 'related').slice(0, 40) : '' }
          db.prepare('INSERT INTO contact_relations (id, sealed, created_at) VALUES (?, ?, ?)').run(rid, s.serverKey.seal(JSON.stringify(relation), 'relation', rid), now)
          links++
        }
      }
      db.exec('COMMIT')
      s.audit('contacts.imported', ctx, ctx.user.id, `${added.length} added, ${links} links`)
      return { added: added.length, links, skipped }
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  })

  // ---- family members kept on a contact ---------------------------------------------------

  const memberFrom = (body: Record<string, unknown>, contactId: string, id: string): Member => {
    const name = str(body, 'name', { max: 100 })
    const raw = body.date
    const date = raw === undefined || raw === null || raw === '' ? null : String(raw)
    if (date !== null && !parseDate(date)) throw new HttpError(400, 'Birthdays need a real day and month (the year is optional).', 'invalid')
    const remind = (body.remind ?? (date ? 'week' : 'off')) as Remind
    if (!(remind in REMIND)) throw new HttpError(400, 'Unknown reminder choice.', 'invalid')
    const remindFor = typeof body.remindFor === 'string' && body.remindFor ? body.remindFor : 'all'
    if (remindFor !== 'all' && !parentIds().has(remindFor)) throw new HttpError(400, 'Reminders go to a parent.', 'invalid')
    let alsoOf: string | null = null
    if (typeof body.alsoOf === 'string' && body.alsoOf) {
      if (body.alsoOf === contactId) throw new HttpError(400, 'Choose the other parent.', 'invalid')
      alsoOf = find(body.alsoOf).id
    }
    return { id, name, kind: 'child', date, remind, remindFor, alsoOf }
  }
  const saveMembers = (ctx: Parameters<Parameters<Api['authed']>[3]>[0], r: ContactRow, members: Member[]) => {
    db.prepare('UPDATE contacts SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(seal(r.id, { ...open(r), members }), s.now(), ctx.user.id, r.id)
    s.audit('contacts.member_changed', ctx, ctx.user.id)
    return { contact: info(find(r.id)) }
  }

  /** Adds a child to a contact (not a contact of their own): a name, and a birthday with reminders. */
  api.authed('POST', '/api/contacts/:id/members', parents, async (ctx) => {
    const r = find(ctx.params.id!)
    const current = open(r).members
    if (current.length >= 20) throw new HttpError(409, 'That is as many as one contact can hold.', 'too_many')
    return saveMembers(ctx, r, [...current, memberFrom(await readJson(ctx.req), r.id, newId())])
  })

  api.authed('PUT', '/api/contacts/:id/members/:memberId', parents, async (ctx) => {
    const r = find(ctx.params.id!)
    const current = open(r).members
    const at = current.findIndex((m) => m.id === ctx.params.memberId)
    if (at < 0) throw new HttpError(404, 'They have been removed.', 'not_found')
    const next = [...current]
    next[at] = memberFrom(await readJson(ctx.req), r.id, current[at]!.id)
    return saveMembers(ctx, r, next)
  })

  api.authed('DELETE', '/api/contacts/:id/members/:memberId', parents, (ctx) => {
    const r = find(ctx.params.id!)
    const current = open(r).members
    if (!current.some((m) => m.id === ctx.params.memberId)) throw new HttpError(404, 'They have been removed.', 'not_found')
    return saveMembers(
      ctx,
      r,
      current.filter((m) => m.id !== ctx.params.memberId),
    )
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
