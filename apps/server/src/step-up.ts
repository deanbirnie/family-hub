/**
 * A fresh authenticator code, for actions where a signed-in session alone is
 * not enough (showing the server key, opening the vault with the recovery
 * key). Each code works once, like at sign-in, and wrong codes count towards
 * the account lockout.
 */
import type { AuthedCtx, Services } from './app.ts'
import { openTotp } from './at-rest.ts'
import { HttpError } from './http.ts'
import { checkTotp } from './totp.ts'

export function requireFreshCode(s: Services, ctx: AuthedCtx, code: unknown, failedEvent: string): void {
  const lockedMs = s.limits.accounts.lockedFor(ctx.user.username, s.now())
  if (lockedMs > 0) throw new HttpError(429, 'Too many wrong codes. Try again later.', 'locked')
  const row = s.db.prepare('SELECT totp_secret, totp_last_counter FROM users WHERE id = ?').get(ctx.user.id) as {
    totp_secret: string | null
    totp_last_counter: number | null
  }
  const secret = openTotp(s.serverKey, ctx.user.id, row.totp_secret)
  const counter = secret ? checkTotp(secret, code, row.totp_last_counter, s.now()) : null
  const claimed =
    counter !== null &&
    Number(
      s.db
        .prepare('UPDATE users SET totp_last_counter = ? WHERE id = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)')
        .run(counter, ctx.user.id, counter).changes,
    ) === 1
  if (!claimed) {
    s.limits.accounts.fail(ctx.user.username, s.now())
    s.audit(failedEvent, ctx, ctx.user.id)
    throw new HttpError(400, 'That code is not right. Wait for a new one and try again.', 'bad_code')
  }
}
