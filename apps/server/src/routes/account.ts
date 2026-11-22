/**
 * A person's own account: name, password, recovery codes, where they are
 * signed in, their phones and their recent security activity.
 */
import type { Api, Services } from '../app.ts'
import { tx } from '../db.ts'
import { HttpError, readJson, str } from '../http.ts'
import { hashPassword, passwordProblem, verifyPassword } from '../secrets.ts'
import { deleteUserSessions } from '../sessions.ts'
import { openTotp } from '../at-rest.ts'
import { checkTotp, newRecoveryCodes } from '../totp.ts'
import { familyName, publicUser, replaceRecoveryCodes } from './auth.ts'

interface SessionRow {
  id: string
  transport: 'cookie' | 'bearer'
  device_id: string | null
  device_name: string | null
  created_at: number
  last_seen_at: number
  user_agent: string
  ip: string
}

export function accountRoutes(api: Api, services: Services): void {
  const { db } = services

  api.authed('GET', '/api/account', {}, (ctx) => {
    const left = (db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(ctx.user.id) as { n: number }).n
    const row = db.prepare('SELECT password_changed_at FROM users WHERE id = ?').get(ctx.user.id) as { password_changed_at: number }
    return {
      user: publicUser(ctx.user),
      familyName: familyName(services),
      recoveryCodesLeft: left,
      passwordChangedAt: row.password_changed_at,
    }
  })

  api.authed('PATCH', '/api/account', {}, async (ctx) => {
    const body = await readJson(ctx.req)
    const displayName = str(body, 'displayName', { max: 60 })
    db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(displayName, ctx.user.id)
    return { user: { ...publicUser(ctx.user), displayName } }
  })

  /**
   * Needs the current password. Signs out every other session and removes
   * every other registered phone: a phone registered by someone who knew the
   * old password must not keep unlocking. (The phone making the change, if
   * any, stays.) Phones sign in again with the new password and a code.
   */
  api.authed('POST', '/api/account/password', {}, async (ctx) => {
    const body = await readJson(ctx.req)
    const current = str(body, 'currentPassword', { max: 256, trim: false })
    const next = str(body, 'newPassword', { max: 256, trim: false })
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ctx.user.id) as { password_hash: string }
    if (!(await verifyPassword(current, row.password_hash))) {
      services.limits.accounts.fail(ctx.user.username, services.now())
      services.audit('password.change_failed', ctx, ctx.user.id)
      throw new HttpError(400, 'Your current password is not right.', 'bad_credentials')
    }
    const problem = passwordProblem(next, ctx.user.username)
    if (problem) throw new HttpError(400, problem, 'weak_password')
    const hash = await hashPassword(next, services.argon2)
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?').run(hash, services.now(), ctx.user.id)
      deleteUserSessions(db, ctx.user.id, ctx.session.id)
      db.prepare('DELETE FROM devices WHERE user_id = ? AND id IS NOT ?').run(ctx.user.id, ctx.session.deviceId)
    })
    services.audit('password.changed', ctx, ctx.user.id)
    return undefined
  })

  /** New recovery codes replace the old ones. Needs a current authenticator code. */
  api.authed('POST', '/api/account/recovery-codes', {}, async (ctx) => {
    const body = await readJson(ctx.req)
    const row = db.prepare('SELECT totp_secret, totp_last_counter FROM users WHERE id = ?').get(ctx.user.id) as {
      totp_secret: string
      totp_last_counter: number | null
    }
    const secret = openTotp(services.serverKey, ctx.user.id, row.totp_secret)
    if (!secret) throw new HttpError(409, 'Two-factor sign-in is not set up.', 'not_set_up')
    const counter = checkTotp(secret, body.code, row.totp_last_counter, services.now())
    if (counter === null) {
      services.limits.accounts.fail(ctx.user.username, services.now())
      throw new HttpError(400, 'That code is not right.', 'bad_code')
    }
    const codes = newRecoveryCodes()
    tx(db, () => {
      db.prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?').run(counter, ctx.user.id)
      replaceRecoveryCodes(services, ctx.user.id, codes)
    })
    services.audit('recovery_codes.replaced', ctx, ctx.user.id)
    return { recoveryCodes: codes }
  })

  api.authed('GET', '/api/account/sessions', {}, (ctx) => {
    const rows = db
      .prepare(
        `SELECT s.id, s.transport, s.device_id, d.name AS device_name, s.created_at, s.last_seen_at, s.user_agent, s.ip
         FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
         WHERE s.user_id = ? AND s.stage = 'full' ORDER BY s.last_seen_at DESC`,
      )
      .all(ctx.user.id) as unknown as SessionRow[]
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        kind: r.device_id ? 'app' : 'browser',
        deviceName: r.device_name,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        userAgent: r.user_agent,
        ip: r.ip,
        current: r.id === ctx.session.id,
      })),
    }
  })

  api.authed('DELETE', '/api/account/sessions/:id', {}, (ctx) => {
    const result = db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(ctx.params.id!, ctx.user.id)
    if (Number(result.changes) === 0) throw new HttpError(404, 'That session has already ended.', 'not_found')
    services.audit('session.ended', ctx, ctx.user.id)
    return undefined
  })

  api.authed('GET', '/api/account/devices', {}, (ctx) => ({
    devices: (
      db.prepare('SELECT id, name, created_at, last_used_at FROM devices WHERE user_id = ? ORDER BY created_at').all(ctx.user.id) as {
        id: string
        name: string
        created_at: number
        last_used_at: number | null
      }[]
    ).map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.created_at,
      lastUsedAt: d.last_used_at,
      current: d.id === ctx.session.deviceId,
    })),
  }))

  /** Removing a phone also signs it out (its sessions go with it). */
  api.authed('DELETE', '/api/account/devices/:id', {}, (ctx) => {
    const result = db.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').run(ctx.params.id!, ctx.user.id)
    if (Number(result.changes) === 0) throw new HttpError(404, 'That phone is not registered.', 'not_found')
    services.audit('device.removed', ctx, ctx.user.id)
    return undefined
  })

  api.authed('GET', '/api/account/activity', {}, (ctx) => ({
    events: (
      db.prepare('SELECT at, event, ip, detail FROM audit_log WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(ctx.user.id) as {
        at: number
        event: string
        ip: string
        detail: string
      }[]
    ).map((e) => ({ at: e.at, event: e.event, ip: e.ip })),
  }))
}
