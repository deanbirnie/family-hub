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
import { parseDate } from '../schedule.ts'

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
  }
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
export function contactFrom(body: Record<string, unknown>, parents: Set<string> = new Set()): Contact {
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
    const contact = contactFrom(body, parentIds())
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
      .run(seal(r.id, contactFrom(body, parentIds())), profileFrom(body, r.id), s.now(), ctx.user.id, r.id, base)
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
