/** The home page's "Coming up" card: what is due soon, for parents. Works whether or not notifications do. */
import { ArrowRight, CalendarClock } from 'lucide-react'
import { navigate } from '../router.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Card, useLoad } from '../ui.tsx'

export interface UpcomingItem {
  key: string
  title: string
  whose: string | null
  date: string
  daysLeft: number
  url: string
}

export function whenText(daysLeft: number): string {
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
      {items.data && list.length === 0 && <p className="muted">Nothing due in the next 90 days. Passport and licence disc dates from Quick Info show here.</p>}
      {list.length > 0 && (
        <ul className="item-list">
          {list.map((i) => (
            <li key={`${i.key}-${i.date}`}>
              <div className="item-main">
                <div>
                  {i.title}
                  {i.whose && <span className="muted"> · {i.whose}</span>}
                  {i.daysLeft < 0 ? <Badge tone="warning">Expired</Badge> : i.daysLeft <= 7 ? <Badge tone="warning">Soon</Badge> : null}
                </div>
                <div className="muted small">
                  {longDate(i.date)}, {whenText(i.daysLeft)}
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
