/**
 * Notification settings, push addresses, and reminders (see notifications.ts).
 *
 * - Anyone signed in can turn notifications on for their own browsers and
 *   phones, see whether each one is working, and send themselves a test.
 * - Quick Info expiry reminders are registered by a parent's device, as the
 *   server cannot read Quick Info: only what (passport, licence disc), whose
 *   and when are stored (docs/DATA-PROTECTION.md, "Notifications").
 */
import type { Api, Services } from '../app.ts'
import { HttpError, readJson, str } from '../http.ts'
import { newId } from '../secrets.ts'
import {
  endpointHash,
  getSettings,
  learnOrigin,
  saveSettings,
  sealTarget,
  sendTo,
  subscriptionsOf,
  upcoming,
  vapidKeys,
  type SubscriptionRow,
} from '../notifications.ts'
import { localNow, parseDate } from '../schedule.ts'
import { validEndpoint, validPushKeys } from '../webpush.ts'

const MAX_ROUTES_PER_PERSON = 20

/** The dates in each kind of Quick Info record that get reminders, and what they are called. */
export const QUICK_INFO_DATES: Record<string, Record<string, string>> = {
  passport: { expiry: 'Passport renewal' },
  vehicle: { licenceExpiry: 'Vehicle licence disc renewal' },
}

const routeInfo = (r: SubscriptionRow) => ({
  id: r.id,
  kind: r.kind,
  label: r.label,
  phone: r.device_id !== null,
  fingerprint: r.endpoint_hash,
  createdAt: r.created_at,
  lastOkAt: r.last_ok_at,
  failing: r.failures > 0,
  failingSince: r.failing_since,
  lastError: r.last_error,
})

export function notificationRoutes(api: Api, s: Services): void {
  const { db } = s
  const signedIn = {} as const
  const parents = { admin: true } as const

  api.authed('GET', '/api/notifications', signedIn, (ctx) => ({
    vapidPublicKey: vapidKeys(s).publicKey,
    timeZone: s.config.timeZone,
    settings: getSettings(s, ctx.user.id),
    routes: subscriptionsOf(s, ctx.user.id).map(routeInfo),
  }))

  api.authed('PUT', '/api/notifications/settings', signedIn, async (ctx) => {
    const body = await readJson(ctx.req)
    const current = getSettings(s, ctx.user.id)
    const next = { ...current }
    for (const key of ['enabled', 'expiry'] as const) {
      if (body[key] === undefined) continue
      if (typeof body[key] !== 'boolean') throw new HttpError(400, `"${key}" must be true or false.`, 'invalid')
      next[key] = body[key]
    }
    if (body.sendHour !== undefined) {
      const h = body.sendHour
      if (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h > 23) throw new HttpError(400, 'Choose an hour from 0 to 23.', 'invalid')
      next.sendHour = h
    }
    saveSettings(s, ctx.user.id, next)
    return { settings: next }
  })

  /** Turns notifications on for this browser or phone (or refreshes its address). */
  api.authed('POST', '/api/notifications/subscriptions', signedIn, async (ctx) => {
    const body = await readJson(ctx.req)
    const kind = body.kind
    if (kind !== 'webpush' && kind !== 'unifiedpush') throw new HttpError(400, 'Unknown kind of push.', 'invalid')
    const endpoint = str(body, 'endpoint', { max: 1024 })
    if (!validEndpoint(endpoint, s.config.allowHttp)) throw new HttpError(400, 'Push addresses must be https.', 'invalid')
    const keysIn = (body.keys ?? {}) as Record<string, unknown>
    const keys = { p256dh: String(keysIn.p256dh ?? ''), auth: String(keysIn.auth ?? '') }
    if (!validPushKeys(keys)) throw new HttpError(400, 'The push keys are not valid.', 'invalid')
    const label = str(body, 'label', { max: 60 })
    if (kind === 'unifiedpush' && !ctx.session.deviceId) throw new HttpError(400, 'UnifiedPush is for the phone app.', 'invalid')
    learnOrigin(s, typeof ctx.req.headers.origin === 'string' ? ctx.req.headers.origin : undefined)

    const hash = endpointHash(endpoint)
    const existing = db.prepare('SELECT * FROM push_subscriptions WHERE endpoint_hash = ?').get(hash) as unknown as SubscriptionRow | undefined
    // A phone has one push address: a new one replaces the old.
    if (ctx.session.deviceId) {
      db.prepare('DELETE FROM push_subscriptions WHERE device_id = ? AND endpoint_hash != ?').run(ctx.session.deviceId, hash)
    }
    const id = existing?.id ?? newId()
    if (existing) {
      // The same browser again, perhaps signed in as someone else now.
      db.prepare('UPDATE push_subscriptions SET user_id = ?, device_id = ?, kind = ?, sealed = ?, label = ? WHERE id = ?').run(
        ctx.user.id,
        ctx.session.deviceId,
        kind,
        sealTarget(s, id, { endpoint, keys }),
        label,
        id,
      )
    } else {
      const count = (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(ctx.user.id) as { n: number }).n
      if (count >= MAX_ROUTES_PER_PERSON) throw new HttpError(409, 'Remove a browser or phone from notifications first.', 'too_many')
      db.prepare(
        'INSERT INTO push_subscriptions (id, user_id, device_id, kind, endpoint_hash, sealed, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, ctx.user.id, ctx.session.deviceId, kind, hash, sealTarget(s, id, { endpoint, keys }), label, s.now())
      s.audit('notifications.on', ctx, ctx.user.id, label)
    }
    const row = db.prepare('SELECT * FROM push_subscriptions WHERE id = ?').get(id) as unknown as SubscriptionRow
    return { route: routeInfo(row) }
  })

  const ownRoute = (userId: string, id: string) => {
    const row = db.prepare('SELECT * FROM push_subscriptions WHERE id = ? AND user_id = ?').get(id, userId) as unknown as SubscriptionRow | undefined
    if (!row) throw new HttpError(404, 'That browser or phone no longer gets notifications.', 'not_found')
    return row
  }

  api.authed('DELETE', '/api/notifications/subscriptions/:id', signedIn, (ctx) => {
    const row = ownRoute(ctx.user.id, ctx.params.id!)
    db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id)
    s.audit('notifications.off', ctx, ctx.user.id, row.label)
    return undefined
  })

  api.authed('POST', '/api/notifications/subscriptions/:id/test', signedIn, async (ctx) => {
    const row = ownRoute(ctx.user.id, ctx.params.id!)
    const outcome = await sendTo(s, row, {
      title: 'Family Hub',
      body: 'Test notification: notifications are working.',
      tag: `test-${s.now()}`,
      url: '/settings',
    })
    if (outcome.ok) return { ok: true }
    if (outcome.gone) return { ok: false, gone: true, message: 'The push service no longer knows this browser or phone. Turn notifications on again.' }
    return { ok: false, gone: false, message: `It did not go through (${outcome.error}). Reminders still show on the home page, and phones check daily.` }
  })

  // ---- reminders -----------------------------------------------------------------------

  /** What is coming up, for the home page. Reminders are for parents. */
  api.authed('GET', '/api/reminders/upcoming', signedIn, (ctx) => {
    if (ctx.user.role !== 'admin') return { items: [] }
    return { items: upcoming(s, localNow(s.now(), s.config.timeZone).date) }
  })

  /** The expiry dates the server holds for Quick Info records, so a parent's device can bring them up to date. */
  api.authed('GET', '/api/reminders/quick-info', parents, () => ({
    dates: (
      db.prepare("SELECT source_id, field, due FROM reminders WHERE source = 'quick-info' ORDER BY source_id, field").all() as {
        source_id: string
        field: string
        due: string
      }[]
    ).map((r) => ({ recordId: r.source_id, field: r.field, date: r.due })),
  }))

  /** Sets a Quick Info record's expiry dates ({ dates: { expiry: "2027-03-01" } }); a missing or empty one is removed. */
  api.authed('PUT', '/api/reminders/quick-info/:recordId', parents, async (ctx) => {
    const record = db.prepare('SELECT id, kind, profile_id FROM quick_info WHERE id = ?').get(ctx.params.recordId!) as
      | { id: string; kind: string; profile_id: string | null }
      | undefined
    if (!record) throw new HttpError(404, 'That record has been deleted.', 'not_found')
    const fields = QUICK_INFO_DATES[record.kind]
    if (!fields) throw new HttpError(400, 'That kind of record has no reminders.', 'invalid')
    const body = await readJson(ctx.req)
    const dates = (body.dates ?? {}) as Record<string, unknown>
    if (typeof dates !== 'object' || Array.isArray(dates)) throw new HttpError(400, '"dates" must be an object.', 'invalid')
    for (const key of Object.keys(dates)) if (!(key in fields)) throw new HttpError(400, `"${key}" has no reminder.`, 'invalid')
    const now = s.now()
    for (const [field, title] of Object.entries(fields)) {
      const value = dates[field]
      if (value === undefined || value === null || value === '') {
        db.prepare("DELETE FROM reminders WHERE source = 'quick-info' AND source_id = ? AND field = ?").run(record.id, field)
        continue
      }
      if (typeof value !== 'string' || value.startsWith('--') || !parseDate(value)) throw new HttpError(400, 'Dates must be YYYY-MM-DD.', 'invalid')
      db.prepare(
        `INSERT INTO reminders (id, source, source_id, field, profile_id, title, due, yearly, created_at, updated_at)
         VALUES (?, 'quick-info', ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT (source, source_id, field) DO UPDATE SET due = excluded.due, profile_id = excluded.profile_id, title = excluded.title, updated_at = excluded.updated_at`,
      ).run(newId(), record.id, field, record.profile_id, title, value, now, now)
    }
    return undefined
  })
}
