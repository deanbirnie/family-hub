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
import { applicableLead, daysBetween, localNow, nextOccurrence, yearsAt, zonedToEpoch, type Due } from './schedule.ts'
import { eventOccurrences, FAMILY } from './routes/calendar.ts'
import { contactDates, openContact, REMIND, type Contact, type ImportantDate } from './routes/contacts.ts'
import { generateVapidKeys, sendPush, type PushKeys, type PushMessage, type SendOutcome, type VapidKeys } from './webpush.ts'

// ---- settings --------------------------------------------------------------------------

export interface NotificationSettings {
  /** Any reminders at all. */
  enabled: boolean
  /** Passport and licence disc expiry (Quick Info). */
  expiry: boolean
  /** Birthdays, anniversaries and other dates (Contacts). */
  dates: boolean
  /** "Time to catch up with …" (Contacts, stay in touch). */
  touch: boolean
  /** Calendar event reminders (as chosen on each event). */
  events: boolean
  /** Health reminders: prescriptions, vaccinations, measuring, check-ups (Health). */
  health: boolean
  /** Hour of the day (family time zone) from which reminders are sent. */
  sendHour: number
}

export const DEFAULT_SETTINGS: NotificationSettings = { enabled: true, expiry: true, dates: true, touch: true, events: true, health: true, sendHour: 8 }

export function getSettings(s: Services, userId: string): NotificationSettings {
  const row = s.db.prepare('SELECT settings FROM notification_settings WHERE user_id = ?').get(userId) as { settings: string } | undefined
  if (!row) return { ...DEFAULT_SETTINGS }
  try {
    const raw = JSON.parse(row.settings) as Partial<NotificationSettings>
    return {
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
      expiry: typeof raw.expiry === 'boolean' ? raw.expiry : DEFAULT_SETTINGS.expiry,
      dates: typeof raw.dates === 'boolean' ? raw.dates : DEFAULT_SETTINGS.dates,
      touch: typeof raw.touch === 'boolean' ? raw.touch : DEFAULT_SETTINGS.touch,
      events: typeof raw.events === 'boolean' ? raw.events : DEFAULT_SETTINGS.events,
      health: typeof raw.health === 'boolean' ? raw.health : DEFAULT_SETTINGS.health,
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

export type Category = 'expiry' | 'dates' | 'touch' | 'health'

export interface ReminderItem {
  /** Stable across runs: which reminder this is. */
  key: string
  category: Category
  /** Shown inside the app: "Passport renewal", "Gran's birthday". */
  title: string
  /** Whose it is, inside the app: "Sam". */
  whose: string | null
  due: Due
  /** Days before the date to remind, e.g. [90, 30, 7]. */
  leads: number[]
  /** The generic notification text, safe on a lock screen (never a name or date). */
  notice: (lead: number, occurrence: string) => string
  /** Where tapping goes. */
  url: string
  /** Who gets it: every parent, or one parent's user ID. */
  audience: 'all' | string
  /** How many days ahead the home page shows it. */
  horizon: number
  /** Extra detail inside the app, e.g. "turns 40". */
  detail?: (date: string) => string | null
  /** Already past when first seen (a catch-up that is overdue): remind once anyway. */
  catchUp?: boolean
}

/** Whether a person wants this reminder, by their settings and the reminder's audience. */
const wants = (settings: NotificationSettings, item: ReminderItem, userId: string) =>
  (item.audience === 'all' || item.audience === userId) && settings[item.category]

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
    notice: () => (r.field === 'licenceExpiry' ? 'A vehicle licence disc expires soon' : 'A family document expires soon'),
    url: '/',
    audience: 'all',
    horizon: 90,
  }))
}

/**
 * Health reminders, registered by a parent's device (the server cannot read
 * Health): only "a health reminder · person · date" and how far ahead. The
 * details are in the app, once the vault is open.
 */
function healthItems(s: Services): ReminderItem[] {
  const rows = s.db
    .prepare(
      `SELECT r.id, r.due, r.leads, p.display_name AS whose
       FROM reminders r LEFT JOIN family_profiles p ON p.id = r.profile_id WHERE r.source = 'health' AND length(r.due) = 10`,
    )
    .all() as { id: string; due: string; leads: string | null; whose: string | null }[]
  return rows.map((r) => {
    let leads = [0]
    try {
      const parsed = JSON.parse(r.leads ?? '[0]') as unknown
      if (Array.isArray(parsed) && parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 90)) leads = parsed as number[]
    } catch {
      // the default
    }
    return {
      key: `h:${r.id}`,
      category: 'health' as const,
      title: 'Health reminder',
      whose: r.whose,
      due: { date: r.due, yearly: false },
      leads,
      notice: () => 'A health reminder is due. Tap to see.',
      url: '/health',
      audience: 'all',
      horizon: 30,
    }
  })
}

/**
 * Health reminders with a time (doses in an episode's medicine plan): sent to
 * the minute to every parent, like calendar reminders. The server knows only
 * the person and the time; the text is "A medicine is due."
 */
export function timedHealthReminders(s: Services): { key: string; fireAt: number }[] {
  const rows = s.db.prepare("SELECT id, due FROM reminders WHERE source = 'health' AND length(due) = 16").all() as { id: string; due: string }[]
  return rows.map((r) => ({ key: `ht:${r.id}:${r.due}`, fireAt: zonedToEpoch(r.due, s.config.timeZone) }))
}

/**
 * The lock-screen wording for dates: never a name, one of a few variations
 * (the owner's choice), picked steadily for each reminder.
 */
export const DATE_NOTICES: Record<ImportantDate['kind'], { before: string[]; today: string[] }> = {
  birthday: {
    before: ['Tap to see whose birthday is coming up', 'Someone’s birthday is coming up. Tap to see who.', 'A birthday is coming up. Tap to see whose.'],
    today: ['It’s someone’s birthday today. Tap to see who.', 'Birthday today! Tap to see whose.'],
  },
  anniversary: {
    before: ['An anniversary is coming up. Tap to see whose.', 'Tap to see whose anniversary is coming up'],
    today: ['It’s someone’s anniversary today. Tap to see whose.'],
  },
  memorial: {
    before: ['A day to remember is coming up. Tap to see which.'],
    today: ['Today is a day to remember. Tap to see which.'],
  },
  other: {
    before: ['An important date is coming up. Tap to see which.', 'Tap to see which date is coming up'],
    today: ['An important date is today. Tap to see which.'],
  },
}

export function dateNotice(kind: ImportantDate['kind'], lead: number, occurrence: string): string {
  const options = DATE_NOTICES[kind][lead === 0 ? 'today' : 'before']
  let h = 0
  for (const ch of occurrence) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return options[h % options.length]!
}

const DATE_TITLES: Record<ImportantDate['kind'], string> = { birthday: 'birthday', anniversary: 'anniversary', memorial: 'memorial', other: '' }

/**
 * Birthdays, anniversaries and other dates from Contacts. Worked out from the
 * sealed contacts each time: never copied into plain reminder records
 * (docs/DATA-PROTECTION.md, "People and dates").
 */
const TOUCH_NOTICES = ['Time to catch up with someone. Tap to see who.', 'Someone would love to hear from you. Tap to see who.']

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

function contactDateItems(s: Services): ReminderItem[] {
  const out: ReminderItem[] = []
  for (const row of s.db.prepare('SELECT id, sealed FROM contacts').all() as { id: string; sealed: string }[]) {
    let c: Contact
    try {
      c = openContact(s, row)
    } catch {
      continue
    }
    // Stay in touch: due a set time after the last contact (or after it was set up).
    const k = c.keepInTouch
    const from = k.lastContact ?? k.since
    if (k.everyDays > 0 && from && !c.deceased) {
      const due = addDays(from, k.everyDays)
      out.push({
        key: `t:${row.id}:${due}`,
        category: 'touch',
        title: `Catch up with ${c.name}`,
        whose: null,
        due: { date: due, yearly: false },
        leads: [0],
        notice: (_lead, occurrence) => {
          let h = 0
          for (const ch of occurrence) h = (h * 31 + ch.charCodeAt(0)) >>> 0
          return TOUCH_NOTICES[h % TOUCH_NOTICES.length]!
        },
        url: '/contacts',
        audience: k.remindFor || 'all',
        horizon: 7,
        catchUp: true,
      })
    }
  }
  // Birthdays and other dates, including children kept on a contact.
  for (const d of contactDates(s)) {
    const leads = [...REMIND[d.remind]]
    if (leads.length === 0 || d.stopped) continue
    out.push({
      key: d.key,
      category: 'dates',
      title: d.title,
      whose: d.of,
      due: { date: d.date, yearly: true },
      leads,
      notice: (lead, occurrence) => dateNotice(d.kind, lead, occurrence),
      url: '/contacts',
      audience: d.remindFor,
      horizon: 30,
      detail: (date) => {
        const years = yearsAt({ date: d.date, yearly: true }, date)
        if (years === null || years <= 0) return null
        if (d.kind === 'birthday') return `turns ${years}`
        return `${years} year${years === 1 ? '' : 's'}`
      },
    })
  }
  return out
}

// ---- calendar event reminders (to the minute) --------------------------------------------

export interface EventReminder {
  /** Identifies this reminder (event, day, how long before), for sending it once. */
  key: string
  fireAt: number
  startsAt: number
  /** Who gets it (user IDs). */
  users: string[]
  notice: string
}

/** All-day events: reminders go out at 08:00 on the day (or the day, or week, before). */
const ALL_DAY_HOUR = '08:00'

export function eventNotice(minutes: number, allDay: boolean): string {
  if (minutes >= 10080) return 'An event is a week away. Tap to see.'
  if (minutes >= 1440) return 'An event is tomorrow. Tap to see.'
  if (allDay) return 'An event is today. Tap to see.'
  if (minutes >= 60) return 'An event starts in 1 hour. Tap to see.'
  if (minutes >= 15) return 'An event starts in 15 minutes. Tap to see.'
  return 'An event is starting now. Tap to see.'
}

/**
 * Event reminders around now (from yesterday to a week ahead), with who gets
 * them: the people tagged who have accounts; for Family, and for children
 * without accounts, every parent.
 */
export function eventReminders(s: Services, nowMs: number): EventReminder[] {
  const tz = s.config.timeZone
  const today = localNow(nowMs, tz).date
  const profiles = new Map((s.db.prepare('SELECT id, user_id FROM family_profiles').all() as { id: string; user_id: string | null }[]).map((p) => [p.id, p.user_id]))
  const active = new Map((s.db.prepare('SELECT id, role FROM users WHERE disabled = 0').all() as { id: string; role: string }[]).map((u) => [u.id, u.role]))
  const parents = [...active].filter(([, role]) => role === 'admin').map(([id]) => id)
  const out: EventReminder[] = []
  for (const o of eventOccurrences(s, addDays(today, -1), addDays(today, 8), true)) {
    if (!o.reminders.length) continue
    const users = new Set<string>()
    for (const t of o.tags) {
      const userId = t === FAMILY ? null : profiles.get(t)
      if (userId && active.has(userId)) users.add(userId)
      else for (const p of parents) users.add(p)
    }
    const startsAt = zonedToEpoch(o.allDay ? `${o.start}T${ALL_DAY_HOUR}` : o.start, tz)
    for (const minutes of o.reminders) {
      const fireAt = o.allDay ? zonedToEpoch(`${addDays(o.start, -Math.ceil(minutes / 1440))}T${ALL_DAY_HOUR}`, tz) : startsAt - minutes * 60_000
      out.push({ key: `e:${o.eventId}:${o.day}:${minutes}`, fireAt, startsAt: o.allDay ? startsAt + 16 * 3_600_000 : startsAt, users: [...users], notice: eventNotice(minutes, o.allDay) })
    }
  }
  return out
}

/** Every reminder there is. */
export function allItems(s: Services): ReminderItem[] {
  return [...quickInfoItems(s), ...contactDateItems(s), ...healthItems(s)]
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
    const lead = applicableLead(daysLeft, item.leads) ?? (item.catchUp && daysLeft < 0 ? 0 : null)
    if (lead === null) continue
    out.push({ item, date, daysLeft, lead, occurrence: `${item.key}@${date}/${lead}` })
  }
  return out
}

/** What is coming up (within each item's horizon), and anything that expired in the last 30 days, for one parent. */
export function upcoming(s: Services, today: string, userId: string) {
  const out: { key: string; title: string; whose: string | null; detail: string | null; date: string; daysLeft: number; url: string; category: Category }[] = []
  for (const item of allItems(s)) {
    if (item.audience !== 'all' && item.audience !== userId) continue
    const date = nextOccurrence(item.due, today)
    if (!date) continue
    const daysLeft = daysBetween(today, date)
    if (daysLeft > item.horizon || daysLeft < -30) continue
    // A health reminder that has passed is no longer "coming up".
    if (item.category === 'health' && daysLeft < 0) continue
    out.push({ key: item.key, title: item.title, whose: item.whose, detail: item.detail?.(date) ?? null, date, daysLeft, url: item.url, category: item.category })
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.title.localeCompare(b.title))
}

/**
 * What one person should have been reminded of by today, as the phone's daily
 * check shows it: generic text only. Ignores the sending hour (the check runs
 * once a day, whenever Android lets it).
 */
export function dueMessagesFor(s: Services, userId: string, today: string): PushMessage[] {
  const user = s.db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(userId) as { role: string; disabled: number } | undefined
  if (!user || user.disabled) return []
  const settings = getSettings(s, userId)
  if (!settings.enabled) return []
  // Calendar reminders already due for events that have not begun (the check may come late).
  const now = s.now()
  const events: PushMessage[] = settings.events
    ? eventReminders(s, now)
        .filter((r) => r.users.includes(userId) && r.fireAt <= now && now < r.startsAt)
        .map((r) => ({ title: 'Family Hub', body: r.notice, tag: r.key, url: '/calendar' }))
    : []
  if (user.role !== 'admin') return events
  // Doses due in the last 2 hours (a later check would be too late to help).
  const doses: PushMessage[] = settings.health
    ? timedHealthReminders(s)
        .filter((r) => r.fireAt <= now && now - r.fireAt <= 2 * 3_600_000)
        .map((r) => ({ title: 'Family Hub', body: 'A medicine is due. Tap to see.', tag: r.key, url: '/health' }))
    : []
  return [
    ...doses,
    ...events,
    ...dueNow(s, today)
      .filter((d) => wants(settings, d.item, userId))
      .map((d) => ({ title: 'Family Hub', body: d.item.notice(d.lead, d.occurrence), tag: d.occurrence, url: d.item.url })),
  ]
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
    const parents = s.db.prepare("SELECT id FROM users WHERE role = 'admin' AND disabled = 0").all() as { id: string }[]
    const record = s.db.prepare('INSERT OR IGNORE INTO reminder_deliveries (user_id, occurrence, sent_at) VALUES (?, ?, ?)')
    let sent = 0
    // Calendar reminders: to the minute, whatever the sending hour; not if more than 6 hours late or the event began over 15 minutes ago.
    for (const r of eventReminders(s, now)) {
      if (r.fireAt > now || now - r.fireAt > 6 * 3_600_000 || now > r.startsAt + 15 * 60_000) continue
      for (const userId of r.users) {
        const settings = getSettings(s, userId)
        if (!settings.enabled || !settings.events) continue
        if (Number(record.run(userId, r.key, now).changes) !== 1) continue
        sent++
        for (const route of subscriptionsOf(s, userId)) await sendTo(s, route, { title: 'Family Hub', body: r.notice, tag: r.key, url: '/calendar' })
      }
    }
    // Doses: to the minute, to every parent; not if more than 2 hours late.
    for (const r of timedHealthReminders(s)) {
      if (r.fireAt > now || now - r.fireAt > 2 * 3_600_000) continue
      for (const { id: userId } of parents) {
        const settings = getSettings(s, userId)
        if (!settings.enabled || !settings.health) continue
        if (Number(record.run(userId, r.key, now).changes) !== 1) continue
        sent++
        for (const route of subscriptionsOf(s, userId)) await sendTo(s, route, { title: 'Family Hub', body: 'A medicine is due. Tap to see.', tag: r.key, url: '/health' })
      }
    }
    if (due.length === 0) return sent
    for (const { id: userId } of parents) {
      const settings = getSettings(s, userId)
      if (!settings.enabled || hour < settings.sendHour) continue
      const routes = subscriptionsOf(s, userId)
      for (const d of due) {
        if (!wants(settings, d.item, userId)) continue
        // Recorded first, so two runs can never both send it.
        if (Number(record.run(userId, d.occurrence, now).changes) !== 1) continue
        sent++
        for (const route of routes) {
          await sendTo(s, route, { title: 'Family Hub', body: d.item.notice(d.lead, d.occurrence), tag: d.occurrence, url: d.item.url })
        }
      }
    }
    return sent
  } finally {
    running.delete(s)
  }
}
