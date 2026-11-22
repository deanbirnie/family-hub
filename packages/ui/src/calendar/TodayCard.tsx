/** The home page's "Today" card: the next three days, for everyone, coloured by person. */
import { ArrowRight, CalendarDays } from 'lucide-react'
import { navigate } from '../router.ts'
import type { HubContext } from '../Shell.tsx'
import { Card, useLoad } from '../ui.tsx'
import { TagChip, usePeople } from './CalendarPage.tsx'
import { addDays, formatDay, isOn, timeOf, today, type Occurrence } from './model.ts'

export function TodayCard({ ctx }: { ctx: HubContext }) {
  const people = usePeople(ctx)
  const from = today()
  const to = addDays(from, 2)
  const events = useLoad(() => ctx.platform.api.get<{ events: Occurrence[] }>(`/api/calendar/events?from=${from}&to=${to}`), [ctx.platform.api, from])
  const days = [from, addDays(from, 1), to]
  const list = people.data?.people ?? []
  return (
    <Card
      className="today-card"
      title={
        <>
          <CalendarDays size={18} aria-hidden /> Today
        </>
      }
      actions={
        <button className="link" onClick={() => navigate('/calendar')}>
          Calendar <ArrowRight size={14} aria-hidden />
        </button>
      }
    >
      {events.data && people.data && (
        <div className="today-days">
          {days.map((day, i) => {
            const items = events.data!.events.filter((o) => isOn(o, day))
            return (
              <div key={day} className="today-day">
                <div className="small muted">{i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : formatDay(day, { weekday: 'long' })}</div>
                {items.length === 0 && <div className="muted small">Nothing planned</div>}
                <ul className="cal-items">
                  {items.map((o) => (
                    <li key={`${o.eventId}-${o.day}`} className="today-item">
                      <span className="cal-item-when small muted">{o.allDay ? 'All day' : timeOf(o.start)}</span>
                      <span>{o.title}</span>
                      <span className="cal-item-tags">
                        {o.tags.map((t) => (
                          <TagChip key={t} people={list} tag={t} />
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      )}
      {events.error && <p className="muted">{events.error}</p>}
    </Card>
  )
}
