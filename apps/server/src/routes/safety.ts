/**
 * Safety (phase 10a): "Home safe" and "Arrived". Anyone in the family checks
 * in; everyone else in the family is told by notification. "Arrived" shares
 * where the phone was at that moment (coordinates, and how far off they may
 * be), shown to the family with a link to open it in Google Maps. Each
 * check-in is sealed with the server key and deleted after 24 hours.
 */
import type { Api, Services } from '../app.ts'
import { bad, obj, oneOf, text } from '../household.ts'
import { HttpError, readJson } from '../http.ts'
import { getSettings, sendTo, subscriptionsOf } from '../notifications.ts'
import { verify } from 'node:crypto'
import { hashToken, newId, newToken } from '../secrets.ts'
import { getUser } from '../sessions.ts'
import { tooMany } from './auth.ts'
import { openContact } from './contacts.ts'
import { parsePublicKey } from './devices.ts'

const KEEP_MS = 24 * 3_600_000

/** What a phone's SOS key signs: fixed context, the challenge and the phone, so a signature is good for nothing else. */
export const sosMessage = (challenge: string, deviceId: string) => Buffer.from(`family-hub-sos-start\n${challenge}\n${deviceId}`, 'utf8')

export interface Checkin {
  kind: 'home' | 'arrived'
  /** A word on where, for Arrived: "gymnastics". */
  where: string
  location: { latitude: number; longitude: number; accuracy: number | null } | null
}

const coordinate = (v: unknown, max: number, label: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || Math.abs(v) > max) bad(`${label} is not a coordinate.`)
  return Math.round((v as number) * 1e6) / 1e6
}

export function cleanCheckin(raw: unknown): Checkin {
  const o = obj(raw)
  const kind = oneOf(o.kind, ['home', 'arrived'] as const, 'What it is')
  if (kind === 'home') return { kind, where: '', location: null }
  const l = o.location === null || o.location === undefined ? null : obj(o.location)
  return {
    kind,
    where: text(o, 'where', 60, 'Where'),
    location: l
      ? {
          latitude: coordinate(l.latitude, 90, 'The latitude'),
          longitude: coordinate(l.longitude, 180, 'The longitude'),
          accuracy: typeof l.accuracy === 'number' && Number.isFinite(l.accuracy) && l.accuracy >= 0 ? Math.min(Math.round(l.accuracy), 100_000) : null,
        }
      : null,
  }
}

/** Removes check-ins older than a day, and SOS tracks a day after they ended (run with the regular tidy-up, and before each read). */
export function pruneCheckins(s: Services): void {
  s.db.prepare('DELETE FROM safety_checkins WHERE created_at < ?').run(s.now() - KEEP_MS)
  s.db.prepare('DELETE FROM safety_sos WHERE ended_at IS NOT NULL AND ended_at < ?').run(s.now() - KEEP_MS)
  // An SOS nobody ended (a phone lost or broken) ends itself after a day without a location.
  for (const r of s.db.prepare('SELECT id, COALESCE((SELECT MAX(received_at) FROM safety_sos_points p WHERE p.sos_id = safety_sos.id), started_at) AS last FROM safety_sos WHERE ended_at IS NULL').all() as { id: string; last: number }[]) {
    if (r.last < s.now() - KEEP_MS) endSos(s, r.id, { reason: 'stale', note: '' })
  }
}

// ---- SOS (10b) ---------------------------------------------------------------------------

export type EndReason = 'whoops' | 'services' | 'safe' | 'other' | 'stale'
export const END_WORDS: Record<EndReason, string> = {
  whoops: 'Whoops: sent by mistake',
  services: 'Emergency services have been and gone',
  safe: 'I’m safe now',
  other: 'Ended',
  stale: 'Ended by itself: no location for a day',
}
const MAX_POINTS = 2000

export interface Point {
  latitude: number
  longitude: number
  accuracy: number | null
  /** When the phone took it (it may arrive later, after a time with no signal). */
  at: number
  batteryLow: boolean
}

export function cleanPoint(raw: unknown, now: number): Point {
  const o = obj(raw)
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? Math.min(Math.round(o.at), now) : now
  return {
    latitude: coordinate(o.latitude, 90, 'The latitude'),
    longitude: coordinate(o.longitude, 180, 'The longitude'),
    accuracy: typeof o.accuracy === 'number' && Number.isFinite(o.accuracy) && o.accuracy >= 0 ? Math.min(Math.round(o.accuracy), 100_000) : null,
    at,
    batteryLow: o.batteryLow === true,
  }
}

const sealPoint = (s: Services, sosId: string, id: string, p: Point) => s.serverKey.seal(JSON.stringify(p), 'sos-point', `${sosId}/${id}`)
const openPoint = (s: Services, sosId: string, id: string, sealed: string) => JSON.parse(s.serverKey.open(sealed, 'sos-point', `${sosId}/${id}`)) as Point

function endSos(s: Services, id: string, end: { reason: EndReason; note: string }) {
  s.db.prepare('UPDATE safety_sos SET ended_at = ?, ended_sealed = ? WHERE id = ? AND ended_at IS NULL').run(s.now(), s.serverKey.seal(JSON.stringify(end), 'sos-end', id), id)
}

/** Everyone else in the family: an SOS always comes, whatever their settings. */
async function tellFamily(s: Services, exceptUserId: string, body: string, tag: string, url: string): Promise<number> {
  let told = 0
  for (const u of s.db.prepare('SELECT id FROM users WHERE disabled = 0 AND id != ?').all(exceptUserId) as { id: string }[]) {
    for (const route of subscriptionsOf(s, u.id)) if ((await sendTo(s, route, { title: 'Family Hub', body, tag, url }).catch(() => ({ ok: false }))).ok) told++
  }
  return told
}

function storePoints(s: Services, sosId: string, raw: unknown): number {
  const list = Array.isArray(raw) ? raw.slice(0, 100) : []
  const have = (s.db.prepare('SELECT COUNT(*) AS n FROM safety_sos_points WHERE sos_id = ?').get(sosId) as { n: number }).n
  const now = s.now()
  let added = 0
  for (const r of list) {
    if (have + added >= MAX_POINTS) break
    const p = cleanPoint(r, now)
    const id = newId()
    s.db.prepare('INSERT INTO safety_sos_points (id, sos_id, sealed, at, received_at) VALUES (?, ?, ?, ?, ?)').run(id, sosId, sealPoint(s, sosId, id, p), p.at, now)
    added++
  }
  return added
}

export function safetyRoutes(api: Api, s: Services): void {
  const { db } = s
  const signedIn = {} as const
  const seal = (id: string, c: Checkin) => s.serverKey.seal(JSON.stringify(c), 'safety-checkin', id)
  const open = (id: string, sealed: string) => JSON.parse(s.serverKey.open(sealed, 'safety-checkin', id)) as Checkin

  api.authed('GET', '/api/safety', signedIn, () => {
    pruneCheckins(s)
    const rows = db.prepare('SELECT c.id, c.user_id, c.sealed, c.created_at, u.display_name FROM safety_checkins c JOIN users u ON u.id = c.user_id ORDER BY c.created_at DESC, c.rowid DESC').all() as {
      id: string
      user_id: string
      sealed: string
      created_at: number
      display_name: string
    }[]
    const sos = (db.prepare('SELECT s.id, s.user_id, s.started_at, s.ended_at, s.ended_sealed, u.display_name FROM safety_sos s JOIN users u ON u.id = s.user_id ORDER BY s.started_at DESC').all() as {
      id: string
      user_id: string
      started_at: number
      ended_at: number | null
      ended_sealed: string | null
      display_name: string
    }[]).map((r) => ({
      id: r.id,
      userId: r.user_id,
      name: r.display_name,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      end: r.ended_sealed ? (JSON.parse(s.serverKey.open(r.ended_sealed, 'sos-end', r.id)) as { reason: EndReason; note: string }) : null,
      points: (db.prepare('SELECT id, sealed FROM safety_sos_points WHERE sos_id = ? ORDER BY at, rowid').all(r.id) as { id: string; sealed: string }[]).map((p) => openPoint(s, r.id, p.id, p.sealed)),
    }))
    return { checkins: rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.display_name, at: r.created_at, ...open(r.id, r.sealed) })), sos }
  })

  api.authed('POST', '/api/safety/checkins', signedIn, async (ctx) => {
    const checkin = cleanCheckin((await readJson(ctx.req)).checkin)
    // A few a minute is plenty; this keeps a stuck button from flooding the family.
    const recent = (db.prepare('SELECT COUNT(*) AS n FROM safety_checkins WHERE user_id = ? AND created_at > ?').get(ctx.user.id, s.now() - 60_000) as { n: number }).n
    if (recent >= 3) throw new HttpError(429, 'That was just sent. Wait a minute before sending another.', 'rate_limited')
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO safety_checkins (id, user_id, sealed, created_at) VALUES (?, ?, ?, ?)').run(id, ctx.user.id, seal(id, checkin), now)
    s.audit(`safety.${checkin.kind}`, ctx, ctx.user.id)
    // Everyone else in the family, unless they turned these off.
    const body = checkin.kind === 'home' ? `${ctx.user.displayName} is home safe.` : `${ctx.user.displayName} arrived.`
    const others = db.prepare('SELECT id FROM users WHERE disabled = 0 AND id != ?').all(ctx.user.id) as { id: string }[]
    let told = 0
    for (const u of others) {
      const settings = getSettings(s, u.id)
      if (!settings.enabled || !settings.safety) continue
      for (const route of subscriptionsOf(s, u.id)) {
        if ((await sendTo(s, route, { title: 'Family Hub', body, tag: `safety-${id}`, url: '/' }).catch(() => ({ ok: false }))).ok) told++
      }
    }
    return { checkin: { id, userId: ctx.user.id, name: ctx.user.displayName, at: now, ...checkin }, told }
  })

  /**
   * Starts an SOS (from the unlocked app), with the first location if there
   * is one. The family is alerted at once. The answer carries a pass for this
   * SOS only, so the phone can keep sending locations, and end it, once the
   * app has locked. Called again while one is on, it hands back a new pass.
   */
  const startSos = async (ctx: Parameters<typeof s.audit>[1], user: { id: string; displayName: string }, location: unknown) => {
    const pass = newToken()
    const open = db.prepare('SELECT id FROM safety_sos WHERE user_id = ? AND ended_at IS NULL').get(user.id) as { id: string } | undefined
    if (open) {
      db.prepare('UPDATE safety_sos SET pass_hash = ? WHERE id = ?').run(hashToken(pass), open.id)
      if (location) storePoints(s, open.id, [location])
      return { sos: { id: open.id }, pass, told: 0 }
    }
    const id = newId()
    db.prepare('INSERT INTO safety_sos (id, user_id, pass_hash, started_at) VALUES (?, ?, ?, ?)').run(id, user.id, hashToken(pass), s.now())
    if (location) storePoints(s, id, [location])
    s.audit('safety.sos_started', ctx, user.id)
    const told = await tellFamily(s, user.id, `SOS from ${user.displayName}. Tap to see.`, `sos-${id}`, '/')
    return { sos: { id }, pass, told }
  }

  api.authed('POST', '/api/safety/sos', signedIn, async (ctx) => startSos(ctx, ctx.user, (await readJson(ctx.req)).location))

  // ---- SOS from the lock screen (10c) ----------------------------------------------------

  /** Registers this phone's SOS key (from the unlocked app, on a phone's session): it can start an SOS and nothing else. */
  api.authed('PUT', '/api/safety/sos-key', signedIn, async (ctx) => {
    if (!ctx.session.deviceId) throw new HttpError(400, 'Only a registered phone has an SOS key.', 'not_a_phone')
    const publicKey = text(obj(await readJson(ctx.req)), 'publicKey', 400, 'The key', true)
    parsePublicKey(publicKey)
    db.prepare('UPDATE devices SET sos_public_key = ? WHERE id = ? AND user_id = ?').run(publicKey, ctx.session.deviceId, ctx.user.id)
    s.audit('safety.sos_key_set', ctx, ctx.user.id)
    return { ok: true }
  })

  /**
   * Starts an SOS from a locked phone: a one-time challenge (POST
   * /api/devices/challenge) signed with the phone's SOS key. It answers with
   * the SOS's pass, as the app's SOS button does, and opens no session.
   */
  api.open('POST', '/api/safety/sos/by-key', async (ctx) => {
    if (!s.limits.signIn.hit(`ip:${ctx.ip}`)) throw tooMany()
    const body = await readJson(ctx.req)
    const deviceId = text(body, 'deviceId', 40, 'The phone', true)
    const challengeId = text(body, 'challengeId', 40, 'The challenge', true)
    const signature = text(body, 'signature', 200, 'The signature', true)
    const challenge = db.prepare('DELETE FROM device_challenges WHERE id = ? AND device_id = ? AND expires_at > ? RETURNING challenge').get(challengeId, deviceId, s.now()) as { challenge: string } | undefined
    const device = db.prepare('SELECT user_id, sos_public_key FROM devices WHERE id = ?').get(deviceId) as { user_id: string; sos_public_key: string | null } | undefined
    if (!challenge || !device?.sos_public_key) throw new HttpError(401, 'Try again.', 'bad_challenge')
    const ok = verify('sha256', sosMessage(challenge.challenge, deviceId), { key: parsePublicKey(device.sos_public_key), dsaEncoding: 'der' }, Buffer.from(signature, 'base64'))
    if (!ok) throw new HttpError(401, 'Try again.', 'bad_signature')
    const user = getUser(db, device.user_id)
    if (!user || user.disabled) throw new HttpError(401, 'This account is turned off.', 'disabled')
    return startSos(ctx, user, body.location)
  })

  /** What a phone keeps for an SOS with no data: the rest of the family's mobile numbers, from their own Contacts entries. */
  api.authed('GET', '/api/safety/sos-numbers', signedIn, (ctx) => {
    const rows = db
      .prepare(
        `SELECT c.id, c.sealed, u.display_name FROM users u
         JOIN family_profiles p ON p.user_id = u.id
         JOIN contacts c ON c.profile_id = p.id
         WHERE u.disabled = 0 AND u.id != ?`,
      )
      .all(ctx.user.id) as { id: string; sealed: string; display_name: string }[]
    const numbers = rows
      .map((r) => {
        const c = openContact(s, r)
        const phone = c.phones.find((p) => p.label === 'mobile') ?? c.phones[0]
        return phone?.number ? { name: r.display_name, phone: phone.number } : null
      })
      .filter((x): x is { name: string; phone: string } => x !== null)
    return { numbers }
  })

  /** The SOS by its pass (the phone, possibly locked): only that SOS, only while it is on. */
  const byPass = (id: string, pass: unknown) => {
    const r = db.prepare('SELECT id, user_id, ended_at FROM safety_sos WHERE id = ? AND pass_hash = ?').get(id, hashToken(typeof pass === 'string' ? pass : '')) as { id: string; user_id: string; ended_at: number | null } | undefined
    if (!r) throw new HttpError(404, 'That SOS is not known here.', 'not_found')
    if (r.ended_at !== null) throw new HttpError(410, 'That SOS has ended.', 'ended')
    return r
  }

  /** Locations, one or several at once (those kept while there was no signal go up together). */
  api.open('POST', '/api/safety/sos/:id/points', async (ctx) => {
    const body = await readJson(ctx.req, 64 * 1024)
    const r = byPass(ctx.params.id!, body.pass)
    return { added: storePoints(s, r.id, body.points) }
  })

  /** Ending it, with why: the family is told, so they know how worried to be. */
  api.open('POST', '/api/safety/sos/:id/end', async (ctx) => {
    const body = await readJson(ctx.req)
    const r = byPass(ctx.params.id!, body.pass)
    const reason = oneOf(body.reason, ['whoops', 'services', 'safe', 'other'] as const, 'Why it ended')
    const note = text(body, 'note', 200, 'A few words')
    if (body.points) storePoints(s, r.id, body.points)
    endSos(s, r.id, { reason, note })
    const name = (db.prepare('SELECT display_name FROM users WHERE id = ?').get(r.user_id) as { display_name: string }).display_name
    const why = reason === 'other' ? note || 'Ended' : END_WORDS[reason]
    await tellFamily(s, r.user_id, `${name} ended the SOS: ${why}.`, `sos-${r.id}`, '/')
    s.audit('safety.sos_ended', ctx, r.user_id, reason)
    return { ended: true }
  })
}
