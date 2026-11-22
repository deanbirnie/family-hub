/**
 * Expiry reminders for Quick Info. The server cannot read Quick Info, so a
 * parent's device tells it the dates that need reminders: which record,
 * which date (passport expiry, licence disc expiry), and the date itself.
 * Nothing else leaves the device (docs/DATA-PROTECTION.md, "Notifications").
 */
import type { Api } from '../api.ts'
import type { Kind, RecordContent } from './model.ts'

/** The date fields in each kind of record that get a reminder. */
export const REMINDER_FIELDS: Partial<Record<Kind, string[]>> = {
  passport: ['expiry'],
  vehicle: ['licenceExpiry'],
}

const ISO = /^\d{4}-\d{2}-\d{2}$/

/** The reminder dates a record should have. */
export function reminderDates(kind: Kind, content: RecordContent): Record<string, string> {
  const out: Record<string, string> = {}
  for (const field of REMINDER_FIELDS[kind] ?? []) {
    const value = content.fields[field]?.trim()
    if (value && ISO.test(value)) out[field] = value
  }
  return out
}

/**
 * Brings the server's reminder dates in line with the decrypted records:
 * sends only records whose dates differ (or are missing). Returns how many changed.
 */
export async function syncReminders(api: Api, records: { id: string; kind: Kind; content: RecordContent }[]): Promise<number> {
  const { dates } = await api.get<{ dates: { recordId: string; field: string; date: string }[] }>('/api/reminders/quick-info')
  const server = new Map<string, Record<string, string>>()
  for (const d of dates) server.set(d.recordId, { ...(server.get(d.recordId) ?? {}), [d.field]: d.date })
  let changed = 0
  for (const r of records) {
    if (!REMINDER_FIELDS[r.kind] || r.content.fields._error) continue
    const want = reminderDates(r.kind, r.content)
    const have = server.get(r.id) ?? {}
    const same = Object.keys(want).length === Object.keys(have).length && Object.entries(want).every(([k, v]) => have[k] === v)
    if (same) continue
    await api.request('PUT', `/api/reminders/quick-info/${r.id}`, { dates: want })
    changed++
  }
  return changed
}
