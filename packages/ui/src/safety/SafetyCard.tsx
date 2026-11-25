/**
 * Safety on the home page (phase 10a): "Home safe" and "Arrived" for this
 * person, and the family's check-ins from the last 24 hours. "Arrived"
 * shares where this device is at that moment: shown as coordinates with a
 * link to open them in Google Maps (no map is built in).
 */
import { ChevronDown, Home as HomeIcon, MapPin, ShieldCheck } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { HubContext } from '../Shell.tsx'
import { Banner, Button, Card, errorText, useAction } from '../ui.tsx'

interface Checkin {
  id: string
  userId: string
  name: string
  at: number
  kind: 'home' | 'arrived'
  where: string
  location: { latitude: number; longitude: number; accuracy: number | null } | null
}

export const mapsLink = (l: { latitude: number; longitude: number }) => `https://www.google.com/maps/search/?api=1&query=${l.latitude},${l.longitude}`
export const coords = (l: { latitude: number; longitude: number; accuracy: number | null }) =>
  `${l.latitude.toFixed(5)}, ${l.longitude.toFixed(5)}${l.accuracy !== null ? ` (within ${l.accuracy < 1000 ? `${l.accuracy} m` : `${(l.accuracy / 1000).toFixed(1)} km`})` : ''}`
const time = (ms: number) => {
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  return `${today ? '' : 'yesterday '}${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function SafetyCard({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const [checkins, setCheckins] = useState<Checkin[] | null>(null)
  const [error, setError] = useState('')
  const [arriving, setArriving] = useState(false)
  const [where, setWhere] = useState('')
  const [sent, setSent] = useState('')

  const load = useCallback(async () => {
    try {
      setCheckins((await api.get<{ checkins: Checkin[] }>('/api/safety')).checkins)
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])

  const send = async (checkin: Record<string, unknown>) => {
    const r = await api.post<{ told: number }>('/api/safety/checkins', { checkin })
    setSent(r.told > 0 ? 'Sent to the family.' : 'Saved. Nobody else has notifications on, so they will see it here.')
    await load()
  }
  const home = useAction(() => send({ kind: 'home' }))
  const arrived = useAction(async () => {
    if (!ctx.platform.location) throw new Error('This device cannot tell where it is.')
    const location = await ctx.platform.location.current()
    await send({ kind: 'arrived', where: where.trim(), location })
    setArriving(false)
    setWhere('')
  })

  return (
    <Card
      title={
        <>
          <ShieldCheck size={18} aria-hidden /> Safety
        </>
      }
    >
      <div className="row safety-buttons">
        <Button icon={<HomeIcon size={16} aria-hidden />} busy={home.busy} onClick={() => (setSent(''), void home.run())}>
          Home safe
        </Button>
        {ctx.platform.location && (
          <Button variant="secondary" icon={<ChevronDown size={16} aria-hidden />} aria-expanded={arriving} onClick={() => (setSent(''), setArriving((v) => !v))}>
            Arrived
          </Button>
        )}
      </div>
      {arriving && (
        <form className="row" onSubmit={(e) => (e.preventDefault(), void arrived.run())}>
          <input className="qi-search" aria-label="Where (optional)" placeholder="Where (optional), e.g. gymnastics" maxLength={60} value={where} onChange={(e) => setWhere(e.target.value)} />
          <Button type="submit" icon={<MapPin size={16} aria-hidden />} busy={arrived.busy}>
            Send with my location
          </Button>
        </form>
      )}
      {sent && <Banner kind="success">{sent}</Banner>}
      {(home.error || arrived.error || error) && <Banner kind="error">{home.error || arrived.error || error}</Banner>}
      {checkins && checkins.length > 0 && (
        <ul className="item-list">
          {checkins.map((c) => (
            <li key={c.id}>
              <div className="item-main">
                <div>
                  <strong>{c.userId === ctx.user.id ? 'You' : c.name}</strong> {c.kind === 'home' ? (c.userId === ctx.user.id ? 'are home safe' : 'is home safe') : `arrived${c.where ? ` (${c.where})` : ''}`}
                  <span className="muted"> · {time(c.at)}</span>
                </div>
                {c.location && (
                  <div className="small">
                    {coords(c.location)} ·{' '}
                    <a href={mapsLink(c.location)} target="_blank" rel="noopener noreferrer">
                      Open in Google Maps
                    </a>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {checkins && checkins.length === 0 && <p className="muted small">Check-ins from the last 24 hours show here.</p>}
    </Card>
  )
}
