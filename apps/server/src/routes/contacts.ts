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

export const CATEGORIES = ['family', 'friend', 'school', 'health', 'insurance', 'services', 'other'] as const
export const PHONE_LABELS = ['mobile', 'home', 'work', 'other'] as const

export interface Contact {
  name: string
  organisation: string
  role: string
  category: (typeof CATEGORIES)[number]
  phones: { label: (typeof PHONE_LABELS)[number]; number: string }[]
  emails: string[]
  address: string
  note: string
}

interface ContactRow {
  id: string
  sealed: string
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

/** A contact from a request, checked and tidied. */
export function contactFrom(body: Record<string, unknown>): Contact {
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

export function contactRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const
  const seal = (id: string, c: Contact) => s.serverKey.seal(JSON.stringify(c), 'contact', id)
  const open = (r: ContactRow): Contact => JSON.parse(s.serverKey.open(r.sealed, 'contact', r.id)) as Contact
  const info = (r: ContactRow) => ({ id: r.id, version: r.version, updatedAt: r.updated_at, ...open(r) })
  const find = (id: string) => {
    const r = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as unknown as ContactRow | undefined
    if (!r) throw new HttpError(404, 'That contact has been deleted.', 'not_found')
    return r
  }
  const all = () =>
    (db.prepare('SELECT * FROM contacts').all() as unknown as ContactRow[])
      .map(info)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))

  api.authed('GET', '/api/contacts', parents, () => ({ contacts: all() }))

  api.authed('POST', '/api/contacts', parents, async (ctx) => {
    const contact = contactFrom(await readJson(ctx.req))
    if ((db.prepare('SELECT COUNT(*) AS n FROM contacts').get() as { n: number }).n >= MAX_CONTACTS) {
      throw new HttpError(409, 'The address book is full.', 'too_many')
    }
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO contacts (id, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, 1, ?, ?, ?)').run(id, seal(id, contact), now, now, ctx.user.id)
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
      .prepare('UPDATE contacts SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?')
      .run(seal(r.id, contactFrom(body)), s.now(), ctx.user.id, r.id, base)
    if (Number(changed.changes) !== 1) {
      throw new HttpError(409, 'Someone else changed this contact while you were editing. Reload to see their changes.', 'edit_conflict')
    }
    s.audit('contacts.updated', ctx, ctx.user.id)
    return { contact: info(find(r.id)) }
  })

  api.authed('DELETE', '/api/contacts/:id', parents, (ctx) => {
    const r = find(ctx.params.id!)
    db.prepare('DELETE FROM contacts WHERE id = ?').run(r.id)
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
