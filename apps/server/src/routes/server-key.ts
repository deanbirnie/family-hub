/**
 * Getting the server key into a password manager, from inside the app.
 *
 * Without a copy of the server key, a backup cannot be restored, so until a
 * parent confirms they have saved it, every parent sees a reminder. A parent
 * can show the key after entering a fresh authenticator code (a session alone
 * is not enough), and every showing is recorded in the security log.
 *
 * Showing the key to a parent does not widen what a parent can already read:
 * a signed-in parent can open every document. It lets them do what the key is
 * for: restore a backup on a new machine.
 */
import type { Api, AuthedCtx, Services } from '../app.ts'
import { openTotp } from '../at-rest.ts'
import { HttpError, readJson } from '../http.ts'
import { checkTotp } from '../totp.ts'

const SAVED_SETTING = 'server_key_saved'

export function serverKeyRoutes(api: Api, s: Services): void {
  const { db } = s
  const saved = () => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SAVED_SETTING) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as { at: number; by: string }) : null
  }

  /** Consumes a fresh authenticator code (each code works once), or throws. */
  const freshCode = (ctx: AuthedCtx, code: unknown) => {
    const row = db.prepare('SELECT totp_secret, totp_last_counter FROM users WHERE id = ?').get(ctx.user.id) as {
      totp_secret: string | null
      totp_last_counter: number | null
    }
    const secret = openTotp(s.serverKey, ctx.user.id, row.totp_secret)
    const counter = secret ? checkTotp(secret, code, row.totp_last_counter, s.now()) : null
    const claimed =
      counter !== null &&
      Number(
        db
          .prepare('UPDATE users SET totp_last_counter = ? WHERE id = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)')
          .run(counter, ctx.user.id, counter).changes,
      ) === 1
    if (!claimed) {
      s.limits.accounts.fail(ctx.user.username, s.now())
      s.audit('server_key.reveal_failed', ctx, ctx.user.id)
      throw new HttpError(400, 'That code is not right. Wait for a new one and try again.', 'bad_code')
    }
  }

  api.authed('GET', '/api/server-key', { admin: true }, () => {
    const at = saved()
    return { saved: at !== null, savedAt: at?.at ?? null }
  })

  api.authed('POST', '/api/server-key/reveal', { admin: true }, async (ctx) => {
    const body = await readJson(ctx.req)
    const lockedMs = s.limits.accounts.lockedFor(ctx.user.username, s.now())
    if (lockedMs > 0) throw new HttpError(429, 'Too many wrong codes. Try again later.', 'locked')
    freshCode(ctx, body.code)
    s.audit('server_key.revealed', ctx, ctx.user.id)
    return { key: s.serverKey.exportKey(), file: s.config.keyFile }
  })

  api.authed('POST', '/api/server-key/saved', { admin: true }, (ctx) => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      SAVED_SETTING,
      JSON.stringify({ at: s.now(), by: ctx.user.id }),
    )
    s.audit('server_key.saved', ctx, ctx.user.id)
    return { saved: true, savedAt: s.now() }
  })
}
