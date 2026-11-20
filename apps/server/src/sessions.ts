/**
 * Sessions: who a request is from, and how far through signing in they are.
 *
 *   stage 'totp'    password checked; must enter a code from the authenticator app
 *   stage 'enroll'  password checked; must set up two-factor sign-in first
 *   stage 'device'  password and code checked on a phone; may only register
 *                   that phone's biometric key (the app cannot be used without it)
 *   stage 'full'    signed in
 *
 * Browsers hold their session in an HttpOnly cookie; the Android app holds a
 * bearer token, which a full session only gets by unlocking its device key
 * with a fingerprint or face. A token works only the way it was issued.
 */
import type { Db } from './db.ts'
import { hashToken, newId, newToken } from './secrets.ts'

export type Stage = 'totp' | 'enroll' | 'device' | 'full'
export type Transport = 'cookie' | 'bearer'

export interface Session {
  id: string
  userId: string
  stage: Stage
  transport: Transport
  deviceId: string | null
  failedAttempts: number
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

export interface User {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'member'
  totpEnabled: boolean
  disabled: boolean
  createdAt: number
}

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

/** How long each kind of session lasts: in total, and without being used. */
export function lifetime(stage: Stage, transport: Transport, viaDevice: boolean): { total: number; idle: number } {
  if (stage === 'totp' || stage === 'device') return { total: 10 * MIN, idle: 10 * MIN }
  if (stage === 'enroll') return { total: 30 * MIN, idle: 30 * MIN }
  // Phones: a biometric unlock lasts a working day at most; the app also
  // locks itself when it has been in the background for a few minutes.
  if (transport === 'bearer' || viaDevice) return { total: 12 * HOUR, idle: 2 * HOUR }
  return { total: 14 * DAY, idle: 2 * DAY }
}

export const cookieName = (secure: boolean) => (secure ? '__Host-fh_session' : 'fh_session')

export function cookieHeader(secure: boolean, token: string, maxAgeMs: number): string {
  const parts = [
    `${cookieName(secure)}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

export function createSession(
  db: Db,
  opts: { userId: string; stage: Stage; transport: Transport; deviceId?: string | null; ip: string; userAgent: string },
  now = Date.now(),
): { token: string; session: Session } {
  const token = newToken()
  const id = newId()
  const life = lifetime(opts.stage, opts.transport, Boolean(opts.deviceId))
  const expiresAt = now + life.total
  db.prepare(
    `INSERT INTO sessions (id, token_hash, user_id, stage, transport, device_id, created_at, last_seen_at, expires_at, idle_seconds, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    hashToken(token),
    opts.userId,
    opts.stage,
    opts.transport,
    opts.deviceId ?? null,
    now,
    now,
    expiresAt,
    Math.floor(life.idle / 1000),
    opts.userAgent.slice(0, 300),
    opts.ip,
  )
  return {
    token,
    session: {
      id,
      userId: opts.userId,
      stage: opts.stage,
      transport: opts.transport,
      deviceId: opts.deviceId ?? null,
      failedAttempts: 0,
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
    },
  }
}

interface SessionRow {
  id: string
  user_id: string
  stage: Stage
  transport: Transport
  device_id: string | null
  failed_attempts: number
  created_at: number
  last_seen_at: number
  expires_at: number
  idle_seconds: number
  disabled: number
}

/** The live session for a token presented over `transport`, or null. Refreshes its last-used time. */
export function findSession(db: Db, token: string, transport: Transport, now = Date.now()): Session | null {
  if (!token || token.length > 100) return null
  const row = db
    .prepare(
      `SELECT s.*, u.disabled FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as SessionRow | undefined
  if (!row) return null
  const expired = row.expires_at <= now || now - row.last_seen_at > row.idle_seconds * 1000
  if (expired || row.disabled) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(row.id)
    return null
  }
  if (row.transport !== transport) return null
  // Writing on every request is wasteful; a minute's precision is plenty.
  if (now - row.last_seen_at > MIN) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, row.id)
  }
  return {
    id: row.id,
    userId: row.user_id,
    stage: row.stage,
    transport: row.transport,
    deviceId: row.device_id,
    failedAttempts: row.failed_attempts,
    createdAt: row.created_at,
    lastSeenAt: now,
    expiresAt: row.expires_at,
  }
}

export function deleteSession(db: Db, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
}

/** Signs a person out everywhere (optionally except one session). */
export function deleteUserSessions(db: Db, userId: string, exceptId?: string): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptId ?? '')
}

export function pruneSessions(db: Db, now = Date.now()): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at + idle_seconds * 1000 < ?').run(now, now)
  db.prepare('DELETE FROM device_challenges WHERE expires_at <= ?').run(now)
  db.prepare('DELETE FROM invites WHERE used_at IS NULL AND expires_at <= ?').run(now - 30 * DAY)
}

interface UserRow {
  id: string
  username: string
  display_name: string
  role: 'admin' | 'member'
  totp_secret: string | null
  disabled: number
  created_at: number
}

export const toUser = (row: UserRow): User => ({
  id: row.id,
  username: row.username,
  displayName: row.display_name,
  role: row.role,
  totpEnabled: Boolean(row.totp_secret),
  disabled: Boolean(row.disabled),
  createdAt: row.created_at,
})

export function getUser(db: Db, id: string): User | null {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined
  return row ? toUser(row) : null
}
