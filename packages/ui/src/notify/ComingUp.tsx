/** The home page's "Coming up" card: what is due soon, for parents. Works whether or not notifications do. */
import { ArrowRight, CalendarClock } from 'lucide-react'
import { navigate } from '../router.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Card, useLoad } from '../ui.tsx'

export interface UpcomingItem {
  key: string
  title: string
  whose: string | null
  detail: string | null
  category: 'expiry' | 'dates' | 'touch' | 'health' | 'household'
  date: string
  daysLeft: number
  url: string
}

export function whenText(daysLeft: number, category: UpcomingItem['category'] = 'expiry'): string {
  if ((category === 'touch' || category === 'household') && daysLeft < 0) return `${-daysLeft} day${daysLeft === -1 ? '' : 's'} overdue`
  if (daysLeft < -1) return `expired ${-daysLeft} days ago`
  if (daysLeft === -1) return 'expired yesterday'
  if (daysLeft === 0) return 'today'
  if (daysLeft === 1) return 'tomorrow'
  if (daysLeft < 14) return `in ${daysLeft} days`
  if (daysLeft < 60) return `in ${Math.round(daysLeft / 7)} weeks`
  return `in ${Math.round(daysLeft / 30)} months`
}

const longDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })

export function ComingUpCard({ ctx }: { ctx: HubContext }) {
  const items = useLoad(() => ctx.platform.api.get<{ items: UpcomingItem[] }>('/api/reminders/upcoming'), [])
  const list = items.data?.items ?? []
  return (
    <Card
      className="coming-up"
      title={
        <>
          <CalendarClock size={18} aria-hidden /> Coming up
        </>
      }
      actions={
        <button className="link" onClick={() => navigate('/settings')}>
          Notifications <ArrowRight size={14} aria-hidden />
        </button>
      }
    >
      {items.data && list.length === 0 && (
        <p className="muted">Nothing coming up. Passport and licence disc dates from Quick Info, and birthdays and other dates from Contacts, show here.</p>
      )}
      {list.length > 0 && (
        <ul className="item-list">
          {list.map((i) => (
            <li key={`${i.key}-${i.date}`}>
              <div className="item-main">
                <div>
                  {i.title}
                  {i.whose && <span className="muted"> · {i.whose}</span>}
                  {i.category === 'touch' ? null : i.daysLeft < 0 ? <Badge tone="warning">{i.category === 'household' ? 'Overdue' : 'Expired'}</Badge> : i.daysLeft <= 7 ? <Badge tone="warning">Soon</Badge> : null}
                </div>
                <div className="muted small">
                  {i.category === 'expiry' ? longDate(i.date) : longDate(i.date).replace(/,? \d{4}$/, '')}, {whenText(i.daysLeft, i.category)}
                  {i.detail && ` · ${i.detail}`}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items.error && <p className="muted">{items.error}</p>}
    </Card>
  )
}
