/**
 * The page a trusted party opens from the link in their letter, or in an
 * "is all well?" email (phase 9c). No account: they see whose it is and
 * where things stand, and can ask for the pack, or say all is well.
 */
import { useCallback, useEffect, useState } from 'react'
import type { Api } from '../api.ts'
import { AuthLayout } from '../auth/screens.tsx'
import { Labelled } from '../money/form.tsx'
import { Banner, Button, Spinner, errorText, useAction } from '../ui.tsx'

interface State {
  family: string
  name: string
  role: 'guardian' | 'inform'
  stage: 'none' | 'requested' | 'asking' | 'sending'
  sendAt: number | null
}

const when = (ms: number | null) => (ms ? new Date(ms).toLocaleString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '')

export function EmergencyLink({ api, secret }: { api: Api; secret: string }) {
  const base = `/api/emergency/link/${encodeURIComponent(secret)}`
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [sure, setSure] = useState(false)
  const [done, setDone] = useState('')

  const load = useCallback(async () => {
    try {
      setState(await api.get<State>(base))
    } catch (e) {
      setError(errorText(e))
    }
  }, [api, base])
  useEffect(() => {
    void load()
  }, [load])

  const request = useAction(async () => {
    if (!sure) throw new Error('Tick the box to confirm.')
    const r = await api.post<{ status: string }>(`${base}/request`, { note })
    setDone(r.status === 'sending' ? 'The pack is being sent to the guardians now.' : 'Thank you. The parents have been told. If neither of them cancels, the pack is sent to the guardians on the date below.')
    await load()
  })
  const well = useAction(async () => {
    await api.post(`${base}/well`, {})
    setDone('Thank you. Nothing will be sent, and the parents have been told.')
    await load()
  })

  if (error && !state) {
    return (
      <AuthLayout title="In case of emergency">
        <Banner kind="error">{error}</Banner>
      </AuthLayout>
    )
  }
  if (!state) {
    return (
      <main className="auth">
        <Spinner />
      </main>
    )
  }
  return (
    <AuthLayout title={`${state.family}: in case of emergency`} subtitle={`For ${state.name}.`}>
      {done && <Banner kind="success">{done}</Banner>}
      {state.stage === 'sending' && <Banner kind="info">The emergency pack is being sent to the guardians by email.</Banner>}
      {state.stage === 'requested' && (
        <Banner kind="warning">
          The pack has been asked for. The parents have been told; unless one of them says all is well, it is sent to the guardians on <strong>{when(state.sendAt)}</strong>.
        </Banner>
      )}
      {state.stage === 'asking' && (
        <>
          <p>The hub has not heard from either parent for a while. Have you?</p>
          <div className="row">
            <Button busy={well.busy} onClick={() => void well.run()}>
              All is well: I have heard from them
            </Button>
          </div>
          <p className="muted small">If nobody answers, the pack is sent to the guardians on {when(state.sendAt)}. If something has happened, ask for it now below.</p>
          {well.error && <Banner kind="error">{well.error}</Banner>}
        </>
      )}
      {(state.stage === 'none' || state.stage === 'asking') && (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), void request.run())}>
          <h2>Has something happened to both of them?</h2>
          <p className="small">
            {state.stage === 'asking'
              ? 'Asking now sends the pack to the guardians straight away.'
              : 'Asking tells both parents at once, and they can cancel. If neither does, after a few days and a second check, the pack is emailed to the guardians.'}{' '}
            {state.role === 'guardian' ? 'You are one of them: it is a PDF that opens with the password in your letter.' : 'You will be told when it has been sent.'}
          </p>
          <Labelled id="request-note" label="What has happened (optional)">
            <textarea id="request-note" className="qi-search" rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
          </Labelled>
          <label className="check">
            <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
            <span>I believe something has happened to both of them</span>
          </label>
          {request.error && <Banner kind="error">{request.error}</Banner>}
          <div className="row">
            <Button type="submit" variant="danger" busy={request.busy}>
              Ask for the emergency pack
            </Button>
          </div>
        </form>
      )}
    </AuthLayout>
  )
}
