/**
 * The gift planner (phase 8c), for parents: one view of the occasions coming
 * up for the people who matter (those with gift ideas in Contacts), and
 * Christmas, with each gift on its way from idea to bought, wrapped and
 * given, what it costs, and the planned expense in the budget that covers
 * it. The gifts themselves are the Contacts gift ideas (phase 3), sealed
 * with their contact; nothing new is stored here.
 */
import type { Api, Services } from '../app.ts'
import { localNow, nextOccurrence } from '../schedule.ts'
import { contactDates, giftDefaults, openContact, type Gift } from './contacts.ts'

const HORIZON_DAYS = 366
const RECENT_GIVEN_DAYS = 60

const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

export interface Occasion {
  /** Stable for this occurrence: which date, and which year. */
  key: string
  /** Whose occasion; null for one the whole family shares (Christmas). */
  contactId: string | null
  title: string
  kind: 'birthday' | 'anniversary' | 'other' | 'christmas'
  date: string
}

export function giftRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const

  api.authed('GET', '/api/gifts/planner', parents, () => {
    const today = localNow(s.now(), s.config.timeZone).date
    const until = addDays(today, HORIZON_DAYS)
    const rows = db.prepare('SELECT id, contact_id, sealed, created_at FROM contact_gifts ORDER BY created_at').all() as { id: string; contact_id: string; sealed: string; created_at: number }[]
    const gifts = rows
      .map((r) => ({ id: r.id, contactId: r.contact_id, createdAt: r.created_at, ...giftDefaults(JSON.parse(s.serverKey.open(r.sealed, 'contact-gift', `${r.contact_id}/${r.id}`)) as Partial<Gift>) }))
      // What is still to do, and what was given lately (so an occasion shows what went).
      .filter((g) => g.status !== 'given' || (g.date !== null && g.date >= addDays(today, -RECENT_GIVEN_DAYS)))
    // The people who matter: those with any gift idea, now or before.
    const matter = new Set(rows.map((r) => r.contact_id))
    const contacts = (db.prepare('SELECT id, sealed FROM contacts').all() as { id: string; sealed: string }[])
      .filter((r) => matter.has(r.id))
      .map((r) => {
        const c = openContact(s, r)
        return { id: r.id, name: c.name, deceased: c.deceased }
      })
    const occasions: Occasion[] = []
    for (const d of contactDates(s)) {
      // Everyone's days, so a first idea for someone can be for their birthday; the planner shows those of the people who matter.
      if (d.stopped || d.kind === 'memorial') continue
      const date = nextOccurrence({ date: d.date, yearly: true }, today)
      if (!date || date > until) continue
      occasions.push({ key: `${d.key}:${date}`, contactId: d.contactId, title: d.title, kind: d.kind as Occasion['kind'], date })
    }
    const christmas = nextOccurrence({ date: '--12-25', yearly: true }, today)!
    occasions.push({ key: `christmas:${christmas}`, contactId: null, title: 'Christmas', kind: 'christmas', date: christmas })
    occasions.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title))
    return { today, occasions, contacts: contacts.filter((c) => !c.deceased).map(({ id, name }) => ({ id, name })), gifts }
  })
}
