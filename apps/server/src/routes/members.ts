/**
 * The family: who is in it, invitations for new members, and what an admin
 * can do for someone who is locked out (reset their two-factor sign-in).
 *
 * There is no open sign-up. The first account is made at set-up; everyone
 * else joins through a one-time invite link an admin creates.
 */
import type { Api, Services } from '../app.ts'
import { tx } from '../db.ts'
import { HttpError, readJson, str } from '../http.ts'
import { hashPassword, hashToken, newId, newToken, passwordProblem } from '../secrets.ts'
import { deleteUserSessions, toUser } from '../sessions.ts'
import { checkUsername, familyName, issue, tooMany } from './auth.ts'

const INVITE_DAYS = 7

interface InviteRow {
  id: string
  display_name: string
  role: 'admin' | 'member'
  created_at: number
  expires_at: number
  used_at: number | null
}

export function memberRoutes(api: Api, services: Services): void {
  const { db } = services
  const role = (value: unknown): 'admin' | 'member' => {
    if (value === 'admin' || value === 'member') return value
    throw new HttpError(400, 'Role must be "admin" or "member".', 'invalid')
  }
  const adminCount = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n

  api.authed('GET', '/api/family', {}, () => ({ name: familyName(services) }))

  api.authed('PATCH', '/api/family', { admin: true }, async (ctx) => {
    const body = await readJson(ctx.req)
    const name = str(body, 'name', { max: 60 })
    db.prepare("INSERT INTO settings (key, value) VALUES ('family_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(name)
    services.audit('family.renamed', ctx, ctx.user.id)
    return { name }
  })

  api.authed('GET', '/api/members', {}, (ctx) => ({
    members: (db.prepare('SELECT * FROM users ORDER BY created_at').all() as unknown as Parameters<typeof toUser>[0][])
      .map(toUser)
      .map((u) => ({
        id: u.id,
        username: u.username,
        displayName: u.displayName,
        role: u.role,
        disabled: u.disabled,
        twoFactor: u.totpEnabled,
        createdAt: u.createdAt,
        self: u.id === ctx.user.id,
      })),
  }))

  /** Admins can change a member's role or turn their account off (and back on). */
  api.authed('PATCH', '/api/members/:id', { admin: true }, async (ctx) => {
    const body = await readJson(ctx.req)
    const id = ctx.params.id!
    const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Parameters<typeof toUser>[0] | undefined
    if (!target) throw new HttpError(404, 'No such member.', 'not_found')
    const newRole = body.role === undefined ? target.role : role(body.role)
    const disabled = body.disabled === undefined ? Boolean(target.disabled) : body.disabled === true
    // There must always be someone who can manage the family.
    const losesAdmin = target.role === 'admin' && !target.disabled && (newRole !== 'admin' || disabled)
    if (losesAdmin && adminCount() <= 1) {
      throw new HttpError(409, 'The family needs at least one admin. Make someone else an admin first.', 'last_admin')
    }
    if (id === ctx.user.id && disabled) throw new HttpError(409, 'You cannot turn off your own account.', 'self')
    tx(db, () => {
      db.prepare('UPDATE users SET role = ?, disabled = ? WHERE id = ?').run(newRole, disabled ? 1 : 0, id)
      if (disabled) deleteUserSessions(db, id)
    })
    services.audit('member.updated', ctx, ctx.user.id, `${target.username}: role=${newRole} disabled=${disabled}`)
    return undefined
  })

  /**
   * For a member who lost their phone: removes their authenticator, recovery
   * codes, registered phones and sessions. They set up two-factor sign-in
   * again the next time they sign in with their password.
   */
  api.authed('POST', '/api/members/:id/reset-two-factor', { admin: true }, (ctx) => {
    const id = ctx.params.id!
    if (id === ctx.user.id) {
      throw new HttpError(409, 'Ask another admin to do this, or use a recovery code.', 'self')
    }
    const target = db.prepare('SELECT username FROM users WHERE id = ?').get(id) as { username: string } | undefined
    if (!target) throw new HttpError(404, 'No such member.', 'not_found')
    tx(db, () => {
      db.prepare('UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_last_counter = NULL WHERE id = ?').run(id)
      db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(id)
      db.prepare('DELETE FROM devices WHERE user_id = ?').run(id)
      deleteUserSessions(db, id)
    })
    services.audit('member.two_factor_reset', ctx, ctx.user.id, target.username)
    services.audit('two_factor.reset_by_admin', ctx, id, ctx.user.username)
    return undefined
  })

  // ---- invites ----------------------------------------------------------------------

  api.authed('GET', '/api/invites', { admin: true }, () => ({
    invites: (
      db.prepare('SELECT * FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(services.now()) as unknown as InviteRow[]
    ).map((i) => ({ id: i.id, displayName: i.display_name, role: i.role, createdAt: i.created_at, expiresAt: i.expires_at })),
  }))

  /** The token is returned once, here; only its hash is stored. */
  api.authed('POST', '/api/invites', { admin: true }, async (ctx) => {
    const body = await readJson(ctx.req)
    const displayName = str(body, 'displayName', { max: 60 })
    const inviteRole = body.role === undefined ? 'member' : role(body.role)
    const token = newToken()
    const id = newId()
    const now = services.now()
    const expiresAt = now + INVITE_DAYS * 24 * 60 * 60_000
    db.prepare(
      'INSERT INTO invites (id, token_hash, display_name, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, hashToken(token), displayName, inviteRole, ctx.user.id, now, expiresAt)
    services.audit('member.invited', ctx, ctx.user.id, `${displayName} (${inviteRole})`)
    return { id, token, displayName, role: inviteRole, expiresAt }
  })

  api.authed('DELETE', '/api/invites/:id', { admin: true }, (ctx) => {
    const result = db.prepare('DELETE FROM invites WHERE id = ? AND used_at IS NULL').run(ctx.params.id!)
    if (Number(result.changes) === 0) throw new HttpError(404, 'No such invite.', 'not_found')
    services.audit('member.invite_cancelled', ctx, ctx.user.id)
    return undefined
  })

  const findInvite = (token: string) =>
    db.prepare('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(hashToken(token), services.now()) as
      | InviteRow
      | undefined

  api.open('GET', '/api/invites/redeem/:token', (ctx) => {
    if (!services.limits.open.hit(`ip:${ctx.ip}`)) throw tooMany()
    const invite = findInvite(ctx.params.token!)
    if (!invite) throw new HttpError(404, 'This invite link is not valid. It may have expired or been used already.', 'not_found')
    return { displayName: invite.display_name, familyName: familyName(services) }
  })

  /** Creates the account; the new member then sets up two-factor sign-in before anything else. */
  api.open('POST', '/api/invites/redeem/:token', async (ctx) => {
    if (!services.limits.open.hit(`ip:${ctx.ip}`)) throw tooMany()
    const body = await readJson(ctx.req)
    const username = checkUsername(str(body, 'username', { max: 32 }))
    const displayName = str(body, 'displayName', { max: 60 })
    const password = str(body, 'password', { max: 256, trim: false })
    const problem = passwordProblem(password, username)
    if (problem) throw new HttpError(400, problem, 'weak_password')
    const hash = await hashPassword(password, services.argon2)
    const id = newId()
    const now = services.now()
    tx(db, () => {
      const invite = findInvite(ctx.params.token!)
      if (!invite) throw new HttpError(404, 'This invite link is not valid. It may have expired or been used already.', 'not_found')
      if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
        throw new HttpError(409, 'That username is taken. Choose another.', 'username_taken')
      }
      db.prepare(
        `INSERT INTO users (id, username, display_name, role, password_hash, created_at, password_changed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, username, displayName, invite.role, hash, now, now)
      db.prepare('UPDATE invites SET used_at = ? WHERE id = ?').run(now, invite.id)
    })
    services.audit('member.joined', ctx, id)
    return issue(services, ctx, id, 'enroll', body.client === 'app' ? 'bearer' : 'cookie')
  })
}
