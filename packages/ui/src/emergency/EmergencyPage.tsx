/**
 * In case of emergency (phase 9a), for parents: the hub's email (is it set
 * up, does it work), the trusted parties (guardians and those to inform),
 * and a printed letter for each with their request link and, for guardians,
 * the password of the pack. The pack itself and how it is released follow
 * (9b, 9c).
 */
import { FileDown, Mail, Pencil, Plus, Printer, Share2, ShieldAlert, UserCheck, Users } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { canShareFile, saveMadeFile } from '../download.ts'
import { reportFileName } from '../health/ReportDialogs.tsx'
import { Actions, conflict, Labelled } from '../money/form.tsx'
import { navigate } from '../router.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, PageHeader, Spinner, errorText, useAction } from '../ui.tsx'
import { makeLetter, passwordProblem, suggestPassword } from './letter.ts'

const PdfPreview = lazy(() => import('../pages/DocumentPreview.tsx').then((m) => ({ default: m.PdfPreview })))

interface Party {
  id: string
  version: number
  name: string
  email: string
  role: 'guardian' | 'inform'
  relationship: string
  phone: string
  notes: string
  letterAt: number | null
}
interface Data {
  family: string
  mail: { configured: boolean; from: string }
  parties: Party[]
}

const ROLE: Record<Party['role'], string> = { guardian: 'Guardian', inform: 'To inform' }
const longDate = (d: Date) => d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })

/** Where request links point: this site in a browser, the server the app talks to on Android. */
const requestLink = (ctx: HubContext, secret: string) => {
  const base = ctx.platform.kind === 'web' ? window.location.origin : (ctx.platform.serverUrl ?? '')
  return `${base.replace(/\/+$/, '')}/emergency/${secret}`
}

export function EmergencyPage({ ctx }: { ctx: HubContext }) {
  if (ctx.user.role !== 'admin') {
    return (
      <div className="page">
        <PageHeader title="In case of emergency" />
        <Card>
          <p>This is kept by the parents.</p>
        </Card>
      </div>
    )
  }
  return <Emergency ctx={ctx} />
}

function Emergency({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ party?: Party } | null>(null)
  const [letter, setLetter] = useState<Party | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.get<Data>('/api/emergency'))
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])

  if (error) return <Banner kind="error">{error}</Banner>
  if (!data) return <Spinner />
  const guardians = data.parties.filter((p) => p.role === 'guardian')
  return (
    <div className="page">
      <PageHeader
        title="In case of emergency"
        subtitle="If something happens to both of you, what the people taking over the children need is sent to them as a locked PDF by email, because the hub may not be kept running."
        actions={
          <Button variant="ghost" onClick={() => navigate('/settings')}>
            Settings
          </Button>
        }
      />

      <MailCard ctx={ctx} mail={data.mail} />

      <Card
        title={
          <>
            <Users size={18} aria-hidden /> Trusted parties
          </>
        }
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => setEditing({})}>
            Add someone
          </Button>
        }
      >
        <p className="muted small">
          <strong>Guardians</strong> receive the pack; name more than one, since who takes the children cannot be known in advance. <strong>To inform</strong> are told the pack has gone to the guardians.
        </p>
        {data.parties.length === 0 && <p className="muted small">Nobody yet.</p>}
        {data.parties.length > 0 && guardians.length === 0 && <Banner kind="warning">Add at least one guardian: only guardians receive the pack.</Banner>}
        <ul className="item-list">
          {data.parties.map((p) => (
            <li key={p.id}>
              <div className="item-main">
                <div>
                  <strong>{p.name}</strong> <Badge tone={p.role === 'guardian' ? 'accent' : 'neutral'}>{ROLE[p.role]}</Badge>
                  {p.relationship && <span className="muted"> · {p.relationship}</span>}
                </div>
                <div className="muted small">
                  {[p.email, p.phone].filter(Boolean).join(' · ')}
                  {' · '}
                  {p.letterAt ? `letter made ${longDate(new Date(p.letterAt))}` : 'no letter yet'}
                </div>
              </div>
              <Button variant="ghost" icon={<Printer size={16} aria-hidden />} onClick={() => setLetter(p)}>
                {p.letterAt ? 'New letter' : 'Letter'}
              </Button>
              <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${p.name}`} onClick={() => setEditing({ party: p })} />
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title={
          <>
            <ShieldAlert size={18} aria-hidden /> How it works
          </>
        }
      >
        <ul className="small">
          <li>Each trusted party gets a printed letter now, with a link to use if something has happened (and, for guardians, the password of the pack). The password is chosen here and never stored on the server: keep it in your password manager.</li>
          <li>The pack (your instructions and what the hub knows) is made on a parent’s device and locked with that password. Coming next.</li>
          <li>When someone uses their link, you are both told and can cancel; only after a waiting period and a second check is the pack sent. If neither of you uses the hub for a long time, it checks in with you first. Coming after the pack.</li>
        </ul>
      </Card>

      {editing && <PartyDialog ctx={ctx} party={editing.party} onClose={(c) => (setEditing(null), c && void load())} />}
      {letter && <LetterDialog ctx={ctx} family={data.family} party={letter} onClose={(c) => (setLetter(null), c && void load())} />}
    </div>
  )
}

function MailCard({ ctx, mail }: { ctx: HubContext; mail: Data['mail'] }) {
  const [to, setTo] = useState('')
  const [sent, setSent] = useState('')
  const test = useAction(async () => {
    setSent('')
    await ctx.platform.api.post('/api/emergency/test-email', { to })
    setSent(to)
  })
  return (
    <Card
      title={
        <>
          <Mail size={18} aria-hidden /> Email from the hub
        </>
      }
      actions={mail.configured ? <Badge tone="success">Set up</Badge> : <Badge tone="warning">Not set up</Badge>}
    >
      {mail.configured ? (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), void test.run())}>
          <p className="muted small">The hub sends from {mail.from}. Send yourself a test to be sure it works.</p>
          <div className="row">
            <Labelled id="test-to" label="Send a test to">
              <input id="test-to" className="qi-search" type="email" required maxLength={254} value={to} onChange={(e) => setTo(e.target.value)} />
            </Labelled>
            <Button type="submit" variant="secondary" busy={test.busy}>
              Send a test
            </Button>
          </div>
          {sent && <Banner kind="success">Sent to {sent}. Check that it arrived (and is not in spam).</Banner>}
          {test.error && <Banner kind="error">{test.error}</Banner>}
        </form>
      ) : (
        <p className="small">
          The hub cannot send email yet. The owner sets up an account for it to send from (a Gmail app password is fine): see “Email from the hub” in the owner steps. Until then, nothing can be sent in an emergency.
        </p>
      )}
    </Card>
  )
}

function PartyDialog({ ctx, party, onClose }: { ctx: HubContext; party?: Party; onClose: (changed?: boolean) => void }) {
  const { api } = ctx.platform
  const [f, setF] = useState(() => ({ name: party?.name ?? '', email: party?.email ?? '', role: party?.role ?? ('guardian' as Party['role']), relationship: party?.relationship ?? '', phone: party?.phone ?? '', notes: party?.notes ?? '' }))
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    if (party) await api.request('PUT', `/api/emergency/parties/${party.id}`, { baseVersion: party.version, party: f }).catch(conflict)
    else await api.post('/api/emergency/parties', { party: f })
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!party || !window.confirm(`Remove ${party.name}? The link in their letter stops working.`)) return
    await api.del(`/api/emergency/parties/${party.id}`)
    onClose(true)
  })
  return (
    <Dialog open title={party ? `Edit ${party.name}` : 'Add a trusted party'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <div className="row">
          <Labelled id="tp-name" label="Name">
            <input id="tp-name" className="qi-search" maxLength={100} required value={f.name} onChange={(e) => set('name', e.target.value)} />
          </Labelled>
          <Labelled id="tp-rel" label="Who they are (optional)">
            <input id="tp-rel" className="qi-search" maxLength={60} placeholder="e.g. My sister" value={f.relationship} onChange={(e) => set('relationship', e.target.value)} />
          </Labelled>
        </div>
        <Labelled id="tp-role" label="Role">
          <select id="tp-role" className="select" value={f.role} onChange={(e) => set('role', e.target.value)}>
            <option value="guardian">Guardian: receives the pack</option>
            <option value="inform">To inform: told it has gone to the guardians</option>
          </select>
        </Labelled>
        <div className="row">
          <Labelled id="tp-email" label="Email">
            <input id="tp-email" className="qi-search" type="email" maxLength={254} required value={f.email} onChange={(e) => set('email', e.target.value)} />
          </Labelled>
          <Labelled id="tp-phone" label="Phone (optional)">
            <input id="tp-phone" className="qi-search" type="tel" maxLength={40} value={f.phone} onChange={(e) => set('phone', e.target.value)} />
          </Labelled>
        </div>
        <Labelled id="tp-notes" label="Notes (optional)">
          <input id="tp-notes" className="qi-search" maxLength={500} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={party ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

function LetterDialog({ ctx, family, party, onClose }: { ctx: HubContext; family: string; party: Party; onClose: (changed?: boolean) => void }) {
  const guardian = party.role === 'guardian'
  const [from, setFrom] = useState(ctx.user.displayName)
  const [password, setPassword] = useState('')
  const [saved, setSaved] = useState(false)
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const blob = useMemo(() => (bytes ? new Blob([bytes as BlobPart], { type: 'application/pdf' }) : null), [bytes])
  const fileName = reportFileName('Letter', party.name, new Date().toISOString().slice(0, 10))
  const make = useAction(async () => {
    if (guardian) {
      const problem = passwordProblem(password)
      if (problem) throw new Error(problem)
      if (!saved) throw new Error('Save the password in your password manager first: the hub does not keep it.')
    }
    if (party.letterAt && !window.confirm(`The link in ${party.name}’s earlier letter stops working. Make a new letter?`)) return
    const r = await ctx.platform.api.post<{ secret: string }>(`/api/emergency/parties/${party.id}/letter`, {})
    setBytes(
      makeLetter({
        family,
        from: from.trim() || ctx.user.displayName,
        party,
        link: requestLink(ctx, r.secret),
        password: guardian ? password.trim() : null,
        date: longDate(new Date()),
      }),
    )
  })
  const save = useAction(async (action: 'save' | 'share') => {
    if (bytes) await saveMadeFile(ctx.platform, { name: fileName, bytes }, action)
  })
  return (
    <Dialog open title={`Letter for ${party.name}`} onClose={() => onClose(bytes !== null)}>
      <div className="stack">
        {!bytes ? (
          <form className="stack" onSubmit={(e) => (e.preventDefault(), void make.run())}>
            <p className="small">
              A letter to print and give {party.name} now: what this is, and their own link to use if something has happened to you both.
              {guardian && ' As a guardian, it also holds the password the pack is locked with.'}
            </p>
            <Labelled id="letter-from" label="Signed by">
              <input id="letter-from" className="qi-search" maxLength={100} placeholder="e.g. Alex and Jo" value={from} onChange={(e) => setFrom(e.target.value)} />
            </Labelled>
            {guardian && (
              <>
                <Labelled id="letter-password" label="The pack’s password" hint="The same for every guardian. It is put in the letter here and never sent to the server.">
                  <div className="row">
                    <input id="letter-password" className="qi-search" autoComplete="off" spellCheck={false} maxLength={100} value={password} onChange={(e) => setPassword(e.target.value)} />
                    <Button type="button" variant="ghost" onClick={() => setPassword(suggestPassword())}>
                      Suggest one
                    </Button>
                  </div>
                </Labelled>
                <label className="check">
                  <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
                  <span>This password is saved in our password manager (both of us can reach it)</span>
                </label>
              </>
            )}
            {make.error && <Banner kind="error">{make.error}</Banner>}
            <div className="row">
              <Button type="submit" icon={<UserCheck size={16} aria-hidden />} busy={make.busy}>
                Make the letter
              </Button>
              <Button type="button" variant="ghost" onClick={() => onClose()}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <>
            <Banner kind="success">The letter is ready. Print it and give it to {party.name}; it is not kept anywhere else.</Banner>
            {save.error && <Banner kind="error">{save.error}</Banner>}
            <div className="row">
              <Button icon={<FileDown size={16} aria-hidden />} busy={save.busy} onClick={() => void save.run('save')}>
                Save
              </Button>
              {canShareFile(ctx.platform, fileName) && (
                <Button variant="secondary" icon={<Share2 size={16} aria-hidden />} busy={save.busy} onClick={() => void save.run('share')}>
                  Share
                </Button>
              )}
              <Button variant="ghost" onClick={() => onClose(true)}>
                Done
              </Button>
            </div>
            <Suspense fallback={<Spinner label="Loading preview…" />}>{blob && <PdfPreview blob={blob} />}</Suspense>
          </>
        )}
      </div>
    </Dialog>
  )
}
