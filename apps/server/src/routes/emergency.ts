/**
 * In case of emergency (phase 9a), for parents: the trusted parties who
 * would take over (guardians) or be told (to inform), each sealed with the
 * server key, and the request link printed in each one's letter, kept only
 * as a hash. The letter itself, with the pack's password, is made on the
 * parent's device: the password never reaches the server.
 *
 * Also the hub's email: whether it is set up, and a test message.
 */
import type { Api, Services } from '../app.ts'
import { bad, obj, oneOf, text } from '../household.ts'
import { HttpError, readJson } from '../http.ts'
import { isEmail } from '../mail.ts'
import { hashToken, newId, newToken } from '../secrets.ts'
import { familyName } from './auth.ts'
import type { ReminderItem } from '../notifications.ts'
import { localNow } from '../schedule.ts'

export interface TrustedParty {
  name: string
  email: string
  role: 'guardian' | 'inform'
  /** "Sister", "Godmother", "Friend". */
  relationship: string
  phone: string
  notes: string
}

const MAX_PARTIES = 20
/** The locked pack: a text PDF, well under this. */
const MAX_PACK_BYTES = 20 * 1024 * 1024
const DAY = 86_400_000

/** A year after the pack was last downloaded, a reminder to print a fresh copy for the will. */
export function emergencyItems(s: Services): ReminderItem[] {
  const pack = s.db.prepare('SELECT downloaded_at FROM emergency_pack WHERE id = 1').get() as { downloaded_at: number | null } | undefined
  if (!pack?.downloaded_at) return []
  const due = localNow(pack.downloaded_at + 365 * DAY, s.config.timeZone).date
  return [
    {
      key: `emergency-pack:${pack.downloaded_at}`,
      category: 'household',
      title: 'Print a fresh copy of the emergency pack for the will',
      whose: null,
      due: { date: due, yearly: false },
      leads: [0],
      notice: () => 'Time to refresh a printed copy. Tap to see.',
      url: '/emergency',
      audience: 'all',
      horizon: 14,
      catchUp: true,
    },
  ]
}

export const cleanParty = (raw: unknown): TrustedParty => {
  const o = obj(raw)
  const email = text(o, 'email', 254, 'The email address', true).toLowerCase()
  if (!isEmail(email)) bad('That email address does not look right.')
  return {
    name: text(o, 'name', 100, 'Their name', true),
    email,
    role: oneOf(o.role, ['guardian', 'inform'] as const, 'Their role'),
    relationship: text(o, 'relationship', 60, 'How they are related'),
    phone: text(o, 'phone', 40, 'Their phone number'),
    notes: text(o, 'notes', 500, 'Notes'),
  }
}

export function emergencyRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const
  const seal = (id: string, p: TrustedParty) => s.serverKey.seal(JSON.stringify(p), 'trusted-party', id)
  const open = (id: string, sealed: string) => JSON.parse(s.serverKey.open(sealed, 'trusted-party', id)) as TrustedParty
  const row = (id: string) => {
    const r = db.prepare('SELECT id, version FROM trusted_parties WHERE id = ?').get(id) as { id: string; version: number } | undefined
    if (!r) throw new HttpError(404, 'That person is no longer on the list.', 'not_found')
    return r
  }

  const secret = (kind: string) => db.prepare('SELECT ciphertext, version, updated_at FROM emergency_secrets WHERE kind = ?').get(kind) as { ciphertext: string; version: number; updated_at: number } | undefined
  const secretInfo = (kind: string) => {
    const r = secret(kind)
    return r ? { ciphertext: r.ciphertext, version: r.version, updatedAt: r.updated_at } : null
  }

  api.authed('GET', '/api/emergency', parents, () => ({
    family: familyName(s),
    mail: { configured: s.mail.configured, from: s.mail.from },
    // End-to-end encrypted with the family key: opened only on a parent's device.
    instructions: secretInfo('instructions'),
    password: secretInfo('password'),
    pack: (() => {
      const p = db.prepare('SELECT length(pdf) AS size, made_at, downloaded_at, u.display_name AS by FROM emergency_pack LEFT JOIN users u ON u.id = made_by WHERE emergency_pack.id = 1').get() as { size: number; made_at: number; downloaded_at: number | null; by: string | null } | undefined
      return p ? { size: p.size, madeAt: p.made_at, madeBy: p.by, downloadedAt: p.downloaded_at } : null
    })(),
    parties: (db.prepare('SELECT id, sealed, version, letter_at FROM trusted_parties ORDER BY created_at, rowid').all() as { id: string; sealed: string; version: number; letter_at: number | null }[]).map((r) => ({
      id: r.id,
      version: r.version,
      letterAt: r.letter_at,
      ...open(r.id, r.sealed),
    })),
  }))

  api.authed('POST', '/api/emergency/parties', parents, async (ctx) => {
    if ((db.prepare('SELECT COUNT(*) AS n FROM trusted_parties').get() as { n: number }).n >= MAX_PARTIES) throw new HttpError(400, 'That is as many as the hub keeps.', 'invalid')
    const party = cleanParty((await readJson(ctx.req)).party)
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO trusted_parties (id, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, 1, ?, ?, ?)').run(id, seal(id, party), now, now, ctx.user.id)
    s.audit('emergency.party_added', ctx, ctx.user.id, party.role)
    return { party: { id, version: 1, letterAt: null, ...party } }
  })

  api.authed('PUT', '/api/emergency/parties/:id', parents, async (ctx) => {
    const r = row(ctx.params.id!)
    const body = await readJson(ctx.req)
    if (body.baseVersion !== r.version) throw new HttpError(409, 'The other parent changed this a moment ago. Open it again to see their change.', 'edit_conflict')
    const party = cleanParty(body.party)
    db.prepare('UPDATE trusted_parties SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(seal(r.id, party), s.now(), ctx.user.id, r.id)
    s.audit('emergency.party_changed', ctx, ctx.user.id, party.role)
    const letterAt = (db.prepare('SELECT letter_at FROM trusted_parties WHERE id = ?').get(r.id) as { letter_at: number | null }).letter_at
    return { party: { id: r.id, version: r.version + 1, letterAt, ...party } }
  })

  api.authed('DELETE', '/api/emergency/parties/:id', parents, (ctx) => {
    const r = row(ctx.params.id!)
    db.prepare('DELETE FROM trusted_parties WHERE id = ?').run(r.id)
    s.audit('emergency.party_removed', ctx, ctx.user.id)
    return undefined
  })

  /**
   * A new request link for a party's letter (shown this once, to print); the
   * link in any earlier letter stops working. The answer is "secret", not
   * "token": the app's client takes a "token" in an answer as its session.
   */
  api.authed('POST', '/api/emergency/parties/:id/letter', parents, (ctx) => {
    const r = row(ctx.params.id!)
    const secret = newToken()
    const now = s.now()
    db.prepare('UPDATE trusted_parties SET request_hash = ?, letter_at = ? WHERE id = ?').run(hashToken(secret), now, r.id)
    s.audit('emergency.letter_made', ctx, ctx.user.id)
    return { secret, letterAt: now }
  })

  /** The instructions or the pack's password, sealed on a parent's device with the family key; the server keeps only the ciphertext. */
  api.authed('PUT', '/api/emergency/secrets/:kind', parents, async (ctx) => {
    const kind = ctx.params.kind!
    if (kind !== 'instructions' && kind !== 'password') throw new HttpError(404, 'Not found.', 'not_found')
    const body = await readJson(ctx.req, 512 * 1024)
    const ciphertext = typeof body.ciphertext === 'string' ? body.ciphertext : ''
    if (!ciphertext || ciphertext.length > 400_000) bad('Send the encrypted text.')
    const existing = secret(kind)
    if ((existing?.version ?? null) !== (body.baseVersion ?? null)) throw new HttpError(409, 'The other parent changed this a moment ago. Open it again to see their change.', 'edit_conflict')
    const now = s.now()
    if (existing) db.prepare('UPDATE emergency_secrets SET ciphertext = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE kind = ?').run(ciphertext, now, ctx.user.id, kind)
    else db.prepare('INSERT INTO emergency_secrets (kind, ciphertext, version, updated_at, updated_by) VALUES (?, ?, 1, ?, ?)').run(kind, ciphertext, now, ctx.user.id)
    s.audit(`emergency.${kind}_saved`, ctx, ctx.user.id)
    return { version: (existing?.version ?? 0) + 1, updatedAt: now }
  })

  /** The pack, made and locked on a parent's device. Only a locked PDF is taken: the server must never hold an open one. */
  api.authed('PUT', '/api/emergency/pack', parents, async (ctx) => {
    const body = await readJson(ctx.req, Math.ceil((MAX_PACK_BYTES * 4) / 3) + 1024)
    const pdf = Buffer.from(typeof body.pdf === 'string' ? body.pdf : '', 'base64')
    if (pdf.length === 0 || pdf.length > MAX_PACK_BYTES) bad('The pack is too large.')
    const text = pdf.toString('latin1')
    if (!text.startsWith('%PDF-') || !/\/Encrypt \d+ 0 R/.test(text.slice(-2000)) || !text.includes('/Filter /Standard /V 5 /R 6')) bad('The pack must be a PDF locked with a password (AES-256).')
    db.prepare('INSERT INTO emergency_pack (id, pdf, made_at, made_by) VALUES (1, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET pdf = excluded.pdf, made_at = excluded.made_at, made_by = excluded.made_by').run(pdf, s.now(), ctx.user.id)
    s.audit('emergency.pack_made', ctx, ctx.user.id)
    return { size: pdf.length, madeAt: s.now() }
  })

  /** The locked pack, to keep with the will. */
  api.authed('GET', '/api/emergency/pack', parents, (ctx) => {
    const p = db.prepare('SELECT pdf FROM emergency_pack WHERE id = 1').get() as { pdf: Uint8Array } | undefined
    if (!p) throw new HttpError(404, 'The pack has not been made yet.', 'not_found')
    db.prepare('UPDATE emergency_pack SET downloaded_at = ? WHERE id = 1').run(s.now())
    s.audit('emergency.pack_downloaded', ctx, ctx.user.id)
    ctx.res.statusCode = 200
    ctx.res.setHeader('Content-Type', 'application/pdf')
    ctx.res.setHeader('Content-Disposition', 'attachment; filename="emergency-pack.pdf"')
    ctx.res.setHeader('Cache-Control', 'no-store')
    ctx.res.end(Buffer.from(p.pdf))
    return undefined
  })

  /** Every document's place in Files, for the pack's list of documents (names only). */
  api.authed('GET', '/api/emergency/documents', parents, () => {
    const rows = db.prepare('SELECT id, parent_id, name, kind FROM files WHERE deleted_at IS NULL').all() as { id: string; parent_id: string | null; name: string; kind: string }[]
    const byId = new Map(rows.map((r) => [r.id, r]))
    const path = (r: { parent_id: string | null; name: string }): string => {
      const parts = [r.name]
      let up = r.parent_id ? byId.get(r.parent_id) : undefined
      for (let i = 0; up && i < 200; i++) {
        parts.unshift(up.name)
        up = up.parent_id ? byId.get(up.parent_id) : undefined
      }
      return parts.join(' / ')
    }
    return { documents: rows.filter((r) => r.kind === 'file').map(path).sort((a, b) => a.localeCompare(b)) }
  })

  /** A test message, so the parents know the hub's email works before it matters. */
  api.authed('POST', '/api/emergency/test-email', parents, async (ctx) => {
    if (!s.mail.configured) throw new HttpError(400, 'Email is not set up yet: see "Email from the hub" in the owner steps.', 'not_configured')
    const o = obj((await readJson(ctx.req)) ?? {})
    const to = text(o, 'to', 254, 'The email address', true).toLowerCase()
    if (!isEmail(to)) bad('That email address does not look right.')
    try {
      await s.mail.send({
        to: [to],
        subject: `${familyName(s)}: a test from Family Hub`,
        text: `This is a test from your Family Hub, sent by ${ctx.user.displayName}.\n\nIf you can read it, the hub can send email: in an emergency, it can reach the people you have chosen.\n`,
      })
    } catch (e) {
      s.audit('emergency.test_email_failed', ctx, ctx.user.id)
      throw new HttpError(502, `The email could not be sent. ${e instanceof Error ? e.message : ''}`.trim(), 'mail_failed')
    }
    s.audit('emergency.test_email', ctx, ctx.user.id)
    return { sent: true }
  })
}
