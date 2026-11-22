/**
 * Settings → Notifications: turn push on for this device, see whether each
 * browser and phone is getting them, send a test, and choose what to get.
 */
import { Bell, BellOff, CalendarCheck, Globe, Send, Smartphone, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { timeAgo } from '../format.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Spinner, useAction, useLoad } from '../ui.tsx'
import { fingerprint, turnOff, turnOn, type NotificationSettings, type NotificationState, type PushRoute } from './push.ts'

type HereState = 'unsupported' | 'denied' | 'off' | 'on' | 'checking'

function routeStatus(r: PushRoute): { text: string; tone: 'success' | 'warning' | 'neutral' } {
  if (r.failing) return { text: `Not working since ${timeAgo(r.failingSince ?? Date.now())}${r.lastError ? ` (${r.lastError})` : ''}`, tone: 'warning' }
  if (r.lastOkAt) return { text: `Working · last delivered ${timeAgo(r.lastOkAt)}`, tone: 'success' }
  return { text: 'Nothing sent yet. Send a test to check it works.', tone: 'neutral' }
}

const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

export function NotificationsCard({ ctx }: { ctx: HubContext }) {
  const { platform } = ctx
  const { api } = platform
  const state = useLoad(() => api.get<NotificationState>('/api/notifications'), [])
  const [here, setHere] = useState<HereState>('checking')
  const [mine, setMine] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)
  type PhoneInfo = Awaited<ReturnType<NonNullable<NonNullable<typeof platform.push>['phone']>>>
  const [phone, setPhone] = useState<PhoneInfo | null>(null)

  const checkHere = async () => {
    if (!platform.push) return setHere('unsupported')
    try {
      setHere(await platform.push.state())
      const current = await platform.push.current()
      setMine(current ? await fingerprint(current.endpoint) : null)
      setPhone(platform.push.phone ? await platform.push.phone() : null)
    } catch {
      setHere('unsupported')
    }
  }
  useEffect(() => {
    void checkHere()
  }, [platform])

  const on = useAction(async () => {
    if (!state.data) return
    setMessage(null)
    const route = await turnOn(platform, state.data.vapidPublicKey)
    await checkHere()
    state.reload()
    if (platform.kind === 'android' && !route) {
      setMessage({ kind: 'success', text: 'Daily check turned on: this phone asks the hub once a day, and when you open the app.' })
    }
  })
  const off = useAction(async () => {
    setMessage(null)
    await turnOff(platform, state.data?.routes)
    await checkHere()
    state.reload()
  })
  const test = useAction(async (r: PushRoute) => {
    setMessage(null)
    const result = await api.post<{ ok: boolean; message?: string }>(`/api/notifications/subscriptions/${r.id}/test`)
    setMessage(result.ok ? { kind: 'success', text: `Test sent to ${r.label}. It should appear within a minute.` } : { kind: 'error', text: result.message ?? 'It did not go through.' })
    state.reload()
  })
  const remove = useAction(async (r: PushRoute) => {
    if (!window.confirm(`Stop notifications on ${r.label}?`)) return
    if (r.fingerprint === mine) await turnOff(platform, state.data?.routes)
    else await api.del(`/api/notifications/subscriptions/${r.id}`)
    await checkHere()
    state.reload()
  })
  const save = useAction(async (change: Partial<NotificationSettings>) => {
    await api.request('PUT', '/api/notifications/settings', change)
    state.reload()
  })

  const data = state.data
  const parent = ctx.user.role === 'admin'
  const error = on.error || off.error || test.error || remove.error || save.error || state.error

  return (
    <Card title="Notifications" actions={here === 'on' ? <Badge tone="success">On here</Badge> : undefined}>
      <p className="muted">
        {parent
          ? 'Reminders before passports and licence discs expire, and for birthdays and other dates in Contacts. Notifications never name anyone; the details are in the app. Everything due also shows under “Coming up” on the home page.'
          : 'Notifications for the family hub. The details are only ever shown in the app.'}
      </p>

      {here === 'checking' || !data ? (
        <Spinner />
      ) : (
        <>
          <div className="row">
            {here === 'off' && (
              <Button icon={<Bell size={16} aria-hidden />} busy={on.busy} onClick={() => void on.run()}>
                Turn on notifications {platform.kind === 'web' ? 'in this browser' : 'on this phone'}
              </Button>
            )}
            {here === 'on' && (
              <Button variant="secondary" icon={<BellOff size={16} aria-hidden />} busy={off.busy} onClick={() => void off.run()}>
                Turn off {platform.kind === 'web' ? 'in this browser' : 'on this phone'}
              </Button>
            )}
          </div>
          {here === 'denied' && (
            <Banner kind="warning">
              {platform.kind === 'android'
                ? 'Notifications are turned off for Family Hub. Allow them in Android’s settings (Apps → Family Hub → Notifications), then come back.'
                : 'Notifications are blocked for this site. Allow them in the browser’s site settings, then reload.'}
            </Banner>
          )}
          {here === 'unsupported' && (
            <p className="muted small">
              {platform.kind === 'android'
                ? 'This version of the app cannot show notifications. See “Coming up” on the home page.'
                : 'This browser cannot show notifications here (it needs https and a browser with Web Push).'}
            </p>
          )}
          {here === 'on' && phone && (
            <div className="stack-sm">
              <p className="small">
                <strong>Daily check: on.</strong> This phone asks the hub once a day, and whenever you open the app, so reminders arrive even without a push app.
              </p>
              {phone.pushApp ? (
                <p className="small">
                  <strong>Instant notifications: on</strong>, through {phone.pushApp}.
                </p>
              ) : phone.pushApps.length > 0 ? (
                <div className="row">
                  <Button variant="secondary" busy={on.busy} onClick={() => void on.run()}>
                    Use {phone.pushApps[0]} for instant notifications
                  </Button>
                </div>
              ) : (
                <p className="muted small">
                  For notifications as soon as something is due, install <strong>ntfy</strong> (F-Droid or Google Play), then come back to this page to connect it.
                </p>
              )}
              {phone.problem && !phone.pushApp && <p className="field-error small">{phone.problem}</p>}
            </div>
          )}

          {(data.routes.length > 0 || data.checks.length > 0) && (
            <ul className="item-list">
              {data.checks.map((c) => (
                <li key={`check-${c.deviceId}`}>
                  <CalendarCheck size={20} aria-hidden />
                  <div className="item-main">
                    <div>
                      {c.label} · daily check
                      {c.current && <Badge tone="accent">This phone</Badge>}
                    </div>
                    <div className="muted small">{c.lastCheckAt ? `Last checked ${timeAgo(c.lastCheckAt)}` : 'Not checked yet'}</div>
                  </div>
                </li>
              ))}
              {data.routes.map((r) => {
                const status = routeStatus(r)
                return (
                  <li key={r.id}>
                    {r.phone ? <Smartphone size={20} aria-hidden /> : <Globe size={20} aria-hidden />}
                    <div className="item-main">
                      <div>
                        {r.label}
                        {r.fingerprint === mine && <Badge tone="accent">{platform.kind === 'web' ? 'This browser' : 'This phone'}</Badge>}
                      </div>
                      <div className={`small ${status.tone === 'warning' ? 'field-error' : 'muted'}`}>{status.text}</div>
                      {r.failing && <div className="muted small">{r.phone ? 'The phone’s daily check still brings reminders.' : 'Reminders still show on the home page.'}</div>}
                    </div>
                    <Button variant="ghost" icon={<Send size={18} aria-hidden />} aria-label={`Send a test notification to ${r.label}`} title="Send a test notification" busy={test.busy} onClick={() => void test.run(r)} />
                    <Button variant="ghost" icon={<Trash2 size={18} aria-hidden />} aria-label={`Stop notifications on ${r.label}`} onClick={() => void remove.run(r)} />
                  </li>
                )
              })}
            </ul>
          )}

          {parent && (
            <div className="stack">
              <label className="check">
                <input type="checkbox" checked={data.settings.enabled} onChange={(e) => void save.run({ enabled: e.target.checked })} />
                <span>Send me reminders</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={data.settings.expiry} disabled={!data.settings.enabled} onChange={(e) => void save.run({ expiry: e.target.checked })} />
                <span>Passport and licence disc expiry (90, 30 and 7 days before)</span>
              </label>
              <label className="check">
                <input type="checkbox" checked={data.settings.dates} disabled={!data.settings.enabled} onChange={(e) => void save.run({ dates: e.target.checked })} />
                <span>Birthdays, anniversaries and other dates from Contacts (as chosen for each date)</span>
              </label>
              <div className="field">
                <label htmlFor="send-hour">Send reminders from</label>
                <select id="send-hour" className="select" value={data.settings.sendHour} disabled={!data.settings.enabled} onChange={(e) => void save.run({ sendHour: Number(e.target.value) })}>
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {hourLabel(h)}
                    </option>
                  ))}
                </select>
                <div className="field-hint">Time zone: {data.timeZone}. Set TZ on the server to change it.</div>
              </div>
            </div>
          )}
        </>
      )}
      {message && <Banner kind={message.kind}>{message.text}</Banner>}
      {error && <Banner kind="error">{error}</Banner>}
    </Card>
  )
}
