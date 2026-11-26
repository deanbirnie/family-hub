/**
 * The red SOS screen (phase 10b). It stays up while an SOS is on, over the
 * app and over its lock screen, until it is ended with a reason, so the
 * family knows how worried to be. No call button, no sound, no vibration.
 */
import { useEffect, useState } from 'react'
import type { SosStatus, SosSupport } from '../platform.ts'

const REASONS: ['whoops' | 'services' | 'safe', string][] = [
  ['whoops', 'Whoops: sent by mistake'],
  ['services', 'Emergency services have been and gone'],
  ['safe', 'I’m safe now'],
]
const ago = (ms: number | null) => {
  if (!ms) return 'not yet'
  const min = Math.round((Date.now() - ms) / 60_000)
  return min < 1 ? 'just now' : `${min} min ago`
}

export function SosScreen({ sos }: { sos: SosSupport }) {
  const [status, setStatus] = useState<SosStatus | null>(null)
  const [ending, setEnding] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    const read = () => void sos.status().then((s) => live && setStatus(s), () => undefined)
    read()
    const timer = setInterval(read, 10_000)
    const off = sos.subscribe(read)
    return () => {
      live = false
      clearInterval(timer)
      off()
    }
  }, [sos])

  const end = async (reason: 'whoops' | 'services' | 'safe' | 'other') => {
    setBusy(true)
    setError('')
    try {
      await sos.end(reason, reason === 'other' ? note.trim() : '')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'It could not be ended. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sos-screen" role="alertdialog" aria-modal="true" aria-labelledby="sos-title">
      <h1 id="sos-title">SOS</h1>
      <p className="sos-lead">Your family has been alerted.</p>
      <p>Your location is sent every 2 minutes (every 5 when the battery is low), also with the screen off.</p>
      {status && (
        <p className="sos-status">
          Last location {ago(status.lastFixAt)} · last sent {ago(status.lastSentAt)}
          {status.waiting > 0 && ` · ${status.waiting} waiting for a signal`}
        </p>
      )}
      {!ending ? (
        <button className="sos-end" onClick={() => setEnding(true)}>
          End the SOS
        </button>
      ) : (
        <div className="sos-reasons" role="group" aria-label="Why it ends">
          <p>Why? The family is told, so they know how worried to be.</p>
          {REASONS.map(([reason, label]) => (
            <button key={reason} className="sos-reason" disabled={busy} onClick={() => void end(reason)}>
              {label}
            </button>
          ))}
          <div className="sos-other">
            <input aria-label="Something else" placeholder="Something else…" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
            <button className="sos-reason" disabled={busy || !note.trim()} onClick={() => void end('other')}>
              Send
            </button>
          </div>
          <button className="sos-back" disabled={busy} onClick={() => setEnding(false)}>
            Keep the SOS on
          </button>
        </div>
      )}
      {error && <p className="sos-error" role="alert">{error}</p>}
    </div>
  )
}
