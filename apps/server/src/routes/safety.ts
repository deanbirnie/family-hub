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
import { newId } from '../secrets.ts'

const KEEP_MS = 24 * 3_600_000

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

/** Removes check-ins older than a day (run with the server's regular tidy-up, and before each read). */
export function pruneCheckins(s: Services): void {
  s.db.prepare('DELETE FROM safety_checkins WHERE created_at < ?').run(s.now() - KEEP_MS)
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
    return { checkins: rows.map((r) => ({ id: r.id, userId: r.user_id, name: r.display_name, at: r.created_at, ...open(r.id, r.sealed) })) }
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
}
