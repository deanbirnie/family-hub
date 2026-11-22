/**
 * Signing in: first-run setup, password, two-factor codes (set-up and
 * sign-in), recovery codes and signing out.
 *
 * Every successful step replaces the session with a new one (new token), so a
 * token seen before a step is worth nothing after it.
 */
import type { Api, AuthedCtx, Services } from '../app.ts'
import { presentedToken } from '../app.ts'
import { tx } from '../db.ts'
import { appendHeader, HttpError, readJson, str, type Ctx } from '../http.ts'
import { hashPassword, hashToken, needsRehash, newId, passwordProblem, verifyPassword } from '../secrets.ts'
import {
  cookieHeader,
  createSession,
  deleteSession,
  findSession,
  lifetime,
  type Stage,
  type Transport,
  type User,
} from '../sessions.ts'
import { openTotp, sealTotp } from '../at-rest.ts'
import { checkTotp, newRecoveryCodes, newTotpSecret, normaliseRecoveryCode, otpauthUrl } from '../totp.ts'

/** Compared against when a username does not exist, so the answer takes as long either way. */
let dummyHash: Promise<string> | null = null

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/

export function checkUsername(raw: string): string {
  const username = raw.trim().toLowerCase()
  if (!USERNAME_RE.test(username)) {
    throw new HttpError(400, 'Usernames are 2 to 32 characters: letters, numbers, dots, dashes and underscores.', 'invalid_username')
  }
  return username
}

export function familyName(services: Services): string {
  const row = services.db.prepare("SELECT value FROM settings WHERE key = 'family_name'").get() as { value: string } | undefined
  return row?.value ?? 'Our family'
}

const isLocalhost = (host: string | undefined) => /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host ?? '')

/** The transport a client asks for: the Android app says "app"; browsers get a cookie. */
function transportFor(body: Record<string, unknown>): Transport {
  return body.client === 'app' ? 'bearer' : 'cookie'
}

/**
 * Starts a session and hands its token over: as a cookie for browsers, in the
 * response for the app. Returns what the response body should include.
 */
export function issue(
  services: Services,
  ctx: Ctx,
  userId: string,
  stage: Stage,
  transport: Transport,
  deviceId: string | null = null,
): { stage: Stage; token?: string; expiresAt: number } {
  if (transport === 'cookie' && !ctx.secure && !services.config.allowHttp && !isLocalhost(ctx.req.headers.host)) {
    throw new HttpError(
      400,
      'Family Hub must be opened over https to sign in. (For a quick test on a home network, set FAMILY_HUB_ALLOW_HTTP=true.)',
      'https_required',
    )
  }
  const { token, session } = createSession(
    services.db,
    { userId, stage, transport, deviceId, ip: ctx.ip, userAgent: String(ctx.req.headers['user-agent'] ?? '') },
    services.now(),
  )
  if (transport === 'cookie') {
    const secureCookie = ctx.secure || !services.config.allowHttp
    appendHeader(ctx.res, 'Set-Cookie', cookieHeader(secureCookie, token, lifetime(stage, transport, false).total))
    return { stage, expiresAt: session.expiresAt }
  }
  return { stage, token, expiresAt: session.expiresAt }
}

function clearCookie(services: Services, ctx: Ctx): void {
  appendHeader(ctx.res, 'Set-Cookie', cookieHeader(ctx.secure || !services.config.allowHttp, '', 0))
}

/** After a password: a code is needed next, or setting up the authenticator first. */
const afterPassword = (user: { totp_secret: string | null }): Stage => (user.totp_secret ? 'totp' : 'enroll')

/** After two-factor: browsers are signed in; phones must still register their biometric key. */
const afterSecondFactor = (transport: Transport): Stage => (transport === 'bearer' ? 'device' : 'full')

export const publicUser = (u: User) => ({
  id: u.id,
  username: u.username,
  displayName: u.displayName,
  role: u.role,
})

interface UserRow {
  id: string
  username: string
  password_hash: string
  totp_secret: string | null
  totp_pending_secret: string | null
  totp_last_counter: number | null
  disabled: number
}

export function authRoutes(api: Api, services: Services): void {
  const { db } = services
  const userCount = () => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n

  // ---- first run ------------------------------------------------------------

  api.open('GET', '/api/setup', () => ({ needed: userCount() === 0, familyName: familyName(services) }))

  api.open('POST', '/api/setup', async (ctx) => {
    if (!services.limits.signIn.hit(`ip:${ctx.ip}`)) throw tooMany()
    const body = await readJson(ctx.req)
    const username = checkUsername(str(body, 'username', { max: 32 }))
    const displayName = str(body, 'displayName', { max: 60 })
    const family = str(body, 'familyName', { max: 60 })
    const password = str(body, 'password', { max: 256, trim: false })
    const problem = passwordProblem(password, username)
    if (problem) throw new HttpError(400, problem, 'weak_password')
    const hash = await hashPassword(password, services.argon2)
    const now = services.now()
    const id = newId()
    tx(db, () => {
      // Checked again inside the transaction: only the very first account is made this way.
      if (userCount() !== 0) throw new HttpError(409, 'Family Hub is already set up.', 'already_set_up')
      db.prepare(
        `INSERT INTO users (id, username, display_name, role, password_hash, created_at, password_changed_at)
         VALUES (?, ?, ?, 'admin', ?, ?, ?)`,
      ).run(id, username, displayName, hash, now, now)
      db.prepare("INSERT INTO settings (key, value) VALUES ('family_name', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(family)
    })
    services.audit('setup', ctx, id)
    return issue(services, ctx, id, 'enroll', transportFor(body))
  })

  // ---- password ---------------------------------------------------------------

  api.open('POST', '/api/auth/login', async (ctx) => {
    if (!services.limits.signIn.hit(`ip:${ctx.ip}`)) throw tooMany()
    const body = await readJson(ctx.req)
    const username = str(body, 'username', { max: 64 }).toLowerCase()
    const password = str(body, 'password', { max: 256, trim: false })
    const transport = transportFor(body)

    const lockedMs = services.limits.accounts.lockedFor(username, services.now())
    if (lockedMs > 0) {
      services.audit('login.locked', ctx, null, username)
      throw locked(lockedMs)
    }

    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined
    dummyHash ??= hashPassword('not a real password', services.argon2)
    const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash))
    if (!user || !ok || user.disabled) {
      const nowLocked = services.limits.accounts.fail(username, services.now())
      services.audit('login.password_failed', ctx, user?.id ?? null, user ? '' : username)
      if (nowLocked) services.audit('login.locked', ctx, user?.id ?? null, username)
      throw new HttpError(401, 'Wrong username or password.', 'bad_credentials')
    }
    if (needsRehash(user.password_hash, services.argon2)) {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password, services.argon2), user.id)
    }
    return issue(services, ctx, user.id, afterPassword(user), transport)
  })

  // ---- the second factor --------------------------------------------------------

  /** Replaces the session that just finished a step with one for the next. */
  const advance = (ctx: AuthedCtx, next: Stage) => {
    deleteSession(db, ctx.session.id)
    return issue(services, ctx, ctx.user.id, next, ctx.session.transport)
  }

  /** Counts a wrong code; too many and this sign-in attempt is over. */
  const wrongCode = (ctx: AuthedCtx, what: string): never => {
    db.prepare('UPDATE sessions SET failed_attempts = failed_attempts + 1 WHERE id = ?').run(ctx.session.id)
    const nowLocked = services.limits.accounts.fail(ctx.user.username, services.now())
    services.audit(what, ctx, ctx.user.id)
    if (ctx.session.failedAttempts + 1 >= 5 || nowLocked) {
      deleteSession(db, ctx.session.id)
      if (ctx.session.transport === 'cookie') clearCookie(services, ctx)
      throw new HttpError(401, 'Too many wrong codes. Sign in again.', 'restart')
    }
    throw new HttpError(401, 'That code is not right. Check the time on your phone and try again.', 'bad_code')
  }

  api.authed('POST', '/api/auth/totp', { stages: ['totp'] }, async (ctx) => {
    const body = await readJson(ctx.req)
    const lockedMs = services.limits.accounts.lockedFor(ctx.user.username, services.now())
    if (lockedMs > 0) throw locked(lockedMs)
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id) as unknown as UserRow

    if (typeof body.recoveryCode === 'string') {
      const code = normaliseRecoveryCode(body.recoveryCode)
      const used = db
        .prepare('UPDATE recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL')
        .run(services.now(), ctx.user.id, hashToken(code))
      if (Number(used.changes) !== 1) return wrongCode(ctx, 'login.recovery_failed')
      const left = (db.prepare('SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = ? AND used_at IS NULL').get(ctx.user.id) as { n: number }).n
      services.audit('login.recovery_code_used', ctx, ctx.user.id, `${left} left`)
      services.limits.accounts.succeed(ctx.user.username)
      return { ...advance(ctx, afterSecondFactor(ctx.session.transport)), recoveryCodesLeft: left }
    }

    // (A 'totp' session only exists while a secret is set; refuse outright if not.)
    const secret = openTotp(services.serverKey, ctx.user.id, row.totp_secret)
    if (!secret) throw new HttpError(409, 'Two-factor sign-in is not set up. Sign in again.', 'restart')
    const counter = checkTotp(secret, body.code, row.totp_last_counter, services.now())
    if (counter === null) return wrongCode(ctx, 'login.code_failed')
    // Only one request can use a given code, even if two arrive at once.
    const claimed = db
      .prepare('UPDATE users SET totp_last_counter = ? WHERE id = ? AND (totp_last_counter IS NULL OR totp_last_counter < ?)')
      .run(counter, ctx.user.id, counter)
    if (Number(claimed.changes) !== 1) return wrongCode(ctx, 'login.code_reused')
    services.limits.accounts.succeed(ctx.user.username)
    services.audit('login.success', ctx, ctx.user.id, ctx.session.transport === 'bearer' ? 'app' : 'browser')
    return advance(ctx, afterSecondFactor(ctx.session.transport))
  })

  api.authed('POST', '/api/auth/totp/setup', { stages: ['enroll'] }, (ctx) => {
    const row = db.prepare('SELECT totp_pending_secret FROM users WHERE id = ?').get(ctx.user.id) as { totp_pending_secret: string | null }
    const secret = openTotp(services.serverKey, ctx.user.id, row.totp_pending_secret) ?? newTotpSecret()
    if (!row.totp_pending_secret) {
      db.prepare('UPDATE users SET totp_pending_secret = ? WHERE id = ?').run(sealTotp(services.serverKey, ctx.user.id, secret), ctx.user.id)
    }
    return { secret, otpauthUrl: otpauthUrl(secret, ctx.user.username, `Family Hub (${familyName(services)})`) }
  })

  api.authed('POST', '/api/auth/totp/confirm', { stages: ['enroll'] }, async (ctx) => {
    const body = await readJson(ctx.req)
    const row = db.prepare('SELECT totp_pending_secret FROM users WHERE id = ?').get(ctx.user.id) as { totp_pending_secret: string | null }
    const pendingSecret = openTotp(services.serverKey, ctx.user.id, row.totp_pending_secret)
    if (!pendingSecret) throw new HttpError(409, 'Start the set-up again.', 'no_pending_secret')
    const counter = checkTotp(pendingSecret, body.code, null, services.now())
    if (counter === null) return wrongCode(ctx, 'two_factor.setup_failed')
    const codes = newRecoveryCodes()
    tx(db, () => {
      db.prepare('UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_last_counter = ? WHERE id = ?').run(counter, ctx.user.id)
      replaceRecoveryCodes(services, ctx.user.id, codes)
    })
    services.limits.accounts.succeed(ctx.user.username)
    services.audit('two_factor.enabled', ctx, ctx.user.id)
    return { ...advance(ctx, afterSecondFactor(ctx.session.transport)), recoveryCodes: codes }
  })

  // ---- the session ----------------------------------------------------------------

  api.authed('GET', '/api/auth/session', { stages: ['totp', 'enroll', 'device', 'full'] }, (ctx) => ({
    stage: ctx.session.stage,
    transport: ctx.session.transport,
    expiresAt: ctx.session.expiresAt,
    user: publicUser(ctx.user),
    familyName: familyName(services),
  }))

  api.open('POST', '/api/auth/logout', (ctx) => {
    const presented = presentedToken(services, ctx)
    if (presented) {
      const session = findSession(db, presented.token, presented.transport, services.now())
      if (session) {
        deleteSession(db, session.id)
        services.audit('logout', ctx, session.userId)
      }
    }
    clearCookie(services, ctx)
    return undefined
  })
}

export function replaceRecoveryCodes(services: Services, userId: string, codes: string[]): void {
  services.db.prepare('DELETE FROM recovery_codes WHERE user_id = ?').run(userId)
  const insert = services.db.prepare('INSERT INTO recovery_codes (user_id, code_hash) VALUES (?, ?)')
  for (const code of codes) insert.run(userId, hashToken(normaliseRecoveryCode(code)))
}

export const tooMany = () => new HttpError(429, 'Too many attempts. Wait a few minutes and try again.', 'rate_limited')

export function locked(ms: number): HttpError {
  const minutes = Math.ceil(ms / 60_000)
  return new HttpError(429, `Too many failed sign-ins. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 'locked')
}
