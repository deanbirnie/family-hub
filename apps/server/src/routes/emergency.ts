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

  api.authed('GET', '/api/emergency', parents, () => ({
    family: familyName(s),
    mail: { configured: s.mail.configured, from: s.mail.from },
    parties: (db.prepare('SELECT id, sealed, version, letter_at FROM trusted_parties ORDER BY created_at, id').all() as { id: string; sealed: string; version: number; letter_at: number | null }[]).map((r) => ({
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
