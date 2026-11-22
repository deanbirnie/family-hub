/**
 * Reminders and push notifications (docs/ROADMAP.md, phase 2 part 4).
 *
 * Every few minutes the server works out which reminders are due today (90,
 * 30 and 7 days before a passport or licence disc expires, for example) and
 * sends each parent one push notification per reminder, to every browser and
 * phone they turned notifications on for. Each is recorded, so it is sent
 * once. Phones also check once a day themselves, and the home page lists
 * what is coming up, so nothing depends on push working.
 *
 * Notification text is generic ("A family document expires soon"): the
 * details show only inside the app. Push addresses are sealed with the
 * server key; the messages are encrypted to each device (webpush.ts).
 */
import { createHash } from 'node:crypto'
import type { Services } from './app.ts'
import { applicableLead, daysBetween, localNow, nextOccurrence, type Due } from './schedule.ts'
import { generateVapidKeys, sendPush, type PushKeys, type PushMessage, type SendOutcome, type VapidKeys } from './webpush.ts'

// ---- settings --------------------------------------------------------------------------

export interface NotificationSettings {
  /** Any reminders at all. */
  enabled: boolean
  /** Passport and licence disc expiry (Quick Info). */
  expiry: boolean
  /** Hour of the day (family time zone) from which reminders are sent. */
  sendHour: number
}

export const DEFAULT_SETTINGS: NotificationSettings = { enabled: true, expiry: true, sendHour: 8 }

export function getSettings(s: Services, userId: string): NotificationSettings {
  const row = s.db.prepare('SELECT settings FROM notification_settings WHERE user_id = ?').get(userId) as { settings: string } | undefined
  if (!row) return { ...DEFAULT_SETTINGS }
  try {
    const raw = JSON.parse(row.settings) as Partial<NotificationSettings>
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
      expiry: typeof raw.expiry === 'boolean' ? raw.expiry : DEFAULT_SETTINGS.expiry,
      sendHour: Number.isInteger(raw.sendHour) && raw.sendHour! >= 0 && raw.sendHour! <= 23 ? raw.sendHour! : DEFAULT_SETTINGS.sendHour,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: Services, userId: string, settings: NotificationSettings): void {
  s.db
    .prepare('INSERT INTO notification_settings (user_id, settings) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET settings = excluded.settings')
    .run(userId, JSON.stringify(settings))
}

// ---- the hub's push identity (VAPID) ---------------------------------------------------

const VAPID_PUBLIC = 'vapid_public_key'
const VAPID_PRIVATE = 'vapid_private_key'
const LEARNT_ORIGIN = 'public_origin'

const setting = (s: Services, key: string) => (s.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
const putSetting = (s: Services, key: string, value: string) =>
  s.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)

/** The hub's VAPID keys, made on first use. The private key is sealed with the server key. */
export function vapidKeys(s: Services): VapidKeys {
  const publicKey = setting(s, VAPID_PUBLIC)
  const sealed = setting(s, VAPID_PRIVATE)
  if (publicKey && sealed) return { publicKey, privateKey: s.serverKey.open(sealed, 'vapid', publicKey) }
  const keys = generateVapidKeys()
  putSetting(s, VAPID_PRIVATE, s.serverKey.seal(keys.privateKey, 'vapid', keys.publicKey))
  putSetting(s, VAPID_PUBLIC, keys.publicKey)
  return keys
}

/** Remembers the https address browsers use, when none is configured (see Config.publicUrl). */
export function learnOrigin(s: Services, origin: string | undefined): void {
  if (s.config.publicUrl || !origin || !origin.startsWith('https://') || origin.length > 200) return
  if (s.config.appOrigins.includes(origin)) return
  if (setting(s, LEARNT_ORIGIN) !== origin) putSetting(s, LEARNT_ORIGIN, origin)
}

/** Who push services are told the messages are from. */
export function vapidSubject(s: Services): string {
  return s.config.publicUrl || setting(s, LEARNT_ORIGIN) || 'mailto:family-hub@localhost'
}

// ---- push addresses ---------------------------------------------------------------------

export interface SubscriptionRow {
  id: string
  user_id: string
  device_id: string | null
  kind: 'webpush' | 'unifiedpush'
  endpoint_hash: string
  sealed: string
  label: string
  created_at: number
  last_ok_at: number | null
  last_error: string | null
  failures: number
  failing_since: number | null
}

export const endpointHash = (endpoint: string) => createHash('sha256').update(endpoint).digest('base64url')

export function sealTarget(s: Services, id: string, target: { endpoint: string; keys: PushKeys }): string {
  return s.serverKey.seal(JSON.stringify(target), 'push', id)
}

function openTarget(s: Services, row: SubscriptionRow): { endpoint: string; keys: PushKeys } {
  return JSON.parse(s.serverKey.open(row.sealed, 'push', row.id)) as { endpoint: string; keys: PushKeys }
}

/** A push address is dropped after failing for this long. */
const GIVE_UP_AFTER_MS = 30 * 86_400_000

/** Sends one message to one address and records how it went. */
export async function sendTo(s: Services, row: SubscriptionRow, message: PushMessage): Promise<SendOutcome> {
  const outcome = await sendPush(s.pushFetch, openTarget(s, row), message, vapidKeys(s), vapidSubject(s), s.now())
  const now = s.now()
  if (outcome.ok) {
    s.db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, failures = 0, failing_since = NULL, last_error = NULL WHERE id = ?').run(now, row.id)
  } else if (outcome.gone) {
    s.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(row.id)
  } else {
    s.db
      .prepare('UPDATE push_subscriptions SET failures = failures + 1, failing_since = COALESCE(failing_since, ?), last_error = ? WHERE id = ?')
      .run(now, outcome.error, row.id)
  }
  return outcome
}

export const subscriptionsOf = (s: Services, userId: string) =>
  s.db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as SubscriptionRow[]

// ---- what can be due --------------------------------------------------------------------

export type Category = 'expiry'

export interface ReminderItem {
  /** Stable across runs: which reminder this is. */
  key: string
  category: Category
  /** Shown inside the app: "Passport renewal". */
  title: string
  /** Whose it is, inside the app: "Sam". */
  whose: string | null
  due: Due
  /** Days before the date to remind, e.g. [90, 30, 7]. */
  leads: number[]
  /** The generic notification text, safe on a lock screen. */
  notice: string
  /** Where tapping goes. */
  url: string
}

export const EXPIRY_LEADS = [90, 30, 7]

/** Quick Info expiry dates (passports, licence discs), which parents' devices register. */
function quickInfoItems(s: Services): ReminderItem[] {
  const rows = s.db
    .prepare(
      `SELECT r.id, r.title, r.due, r.yearly, r.field, p.display_name AS whose
       FROM reminders r LEFT JOIN family_profiles p ON p.id = r.profile_id WHERE r.source = 'quick-info'`,
    )
    .all() as { id: string; title: string; due: string; yearly: number; field: string; whose: string | null }[]
  return rows.map((r) => ({
    key: `r:${r.id}`,
    category: 'expiry',
    title: r.title,
    whose: r.whose,
    due: { date: r.due, yearly: r.yearly === 1 },
    leads: EXPIRY_LEADS,
    notice: r.field === 'licenceExpiry' ? 'A vehicle licence disc expires soon' : 'A family document expires soon',
    url: '/',
  }))
}

/** Every reminder there is. Phase 3 adds birthdays and other dates here. */
export function allItems(s: Services): ReminderItem[] {
  return quickInfoItems(s)
}

export interface DueNow {
  item: ReminderItem
  /** The day it falls on this time. */
  date: string
  daysLeft: number
  lead: number
  /** Identifies this one reminder (this item, this date, this lead), for sending it once. */
  occurrence: string
}

/** Reminders that should have gone out by today. */
export function dueNow(s: Services, today: string, items = allItems(s)): DueNow[] {
  const out: DueNow[] = []
  for (const item of items) {
    const date = nextOccurrence(item.due, today)
    if (!date) continue
    const daysLeft = daysBetween(today, date)
    const lead = applicableLead(daysLeft, item.leads)
    if (lead === null) continue
    out.push({ item, date, daysLeft, lead, occurrence: `${item.key}@${date}/${lead}` })
  }
  return out
}

/** What is coming up in the next `horizon` days, and anything that expired in the last 30. */
export function upcoming(s: Services, today: string, horizon = 90) {
  const out: { key: string; title: string; whose: string | null; date: string; daysLeft: number; url: string; category: Category }[] = []
  for (const item of allItems(s)) {
    const date = nextOccurrence(item.due, today)
    if (!date) continue
    const daysLeft = daysBetween(today, date)
    if (daysLeft > horizon || daysLeft < -30) continue
    out.push({ key: item.key, title: item.title, whose: item.whose, date, daysLeft, url: item.url, category: item.category })
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.title.localeCompare(b.title))
}

// ---- sending ----------------------------------------------------------------------------

const running = new WeakSet<Services>()

/** Sends whatever is due and not yet sent. Safe to call often; returns how many were sent. */
export async function runReminders(s: Services): Promise<number> {
  if (running.has(s)) return 0
  running.add(s)
  try {
    const now = s.now()
    const { date: today, hour } = localNow(now, s.config.timeZone)
    // Tidy up: addresses that have failed for a month, and old delivery records.
    s.db.prepare('DELETE FROM push_subscriptions WHERE failing_since IS NOT NULL AND failing_since < ?').run(now - GIVE_UP_AFTER_MS)
    s.db.prepare('DELETE FROM reminder_deliveries WHERE sent_at < ?').run(now - 400 * 86_400_000)

    const due = dueNow(s, today)
    if (due.length === 0) return 0
    const parents = s.db.prepare("SELECT id FROM users WHERE role = 'admin' AND disabled = 0").all() as { id: string }[]
    const record = s.db.prepare('INSERT OR IGNORE INTO reminder_deliveries (user_id, occurrence, sent_at) VALUES (?, ?, ?)')
    let sent = 0
    for (const { id: userId } of parents) {
      const settings = getSettings(s, userId)
      if (!settings.enabled || hour < settings.sendHour) continue
      const routes = subscriptionsOf(s, userId)
      for (const d of due) {
        if (d.item.category === 'expiry' && !settings.expiry) continue
        // Recorded first, so two runs can never both send it.
        if (Number(record.run(userId, d.occurrence, now).changes) !== 1) continue
        sent++
        for (const route of routes) {
          await sendTo(s, route, { title: 'Family Hub', body: d.item.notice, tag: d.occurrence, url: d.item.url })
        }
      }
    }
    return sent
  } finally {
    running.delete(s)
  }
}
