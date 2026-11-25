/**
 * In case of emergency (phase 9a), for parents: the hub's email (is it set
 * up, does it work), the trusted parties (guardians and those to inform),
 * and a printed letter for each with their request link and, for guardians,
 * the password of the pack. The pack itself and how it is released follow
 * (9b, 9c).
 */
import { BookOpen, Eye, FileDown, KeyRound, Lock, Mail, Package, Pencil, Plus, Printer, RefreshCw, Share2, ShieldAlert, UserCheck, Users } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { canShareFile, saveMadeFile } from '../download.ts'
import { reportFileName } from '../health/ReportDialogs.tsx'
import { Actions, conflict, Labelled } from '../money/form.tsx'
import { navigate } from '../router.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, PageHeader, Spinner, errorText, useAction } from '../ui.tsx'
import { makeLetter, passwordProblem, suggestPassword } from './letter.ts'
import { INSTRUCTION_SECTIONS, openSecret, sealSecret, type Instructions } from './pack.ts'
import { refreshPack } from './refresh.ts'
import { useVaultUnlocked, VaultCard } from '../vault/VaultCard.tsx'
import { vault } from '../vault/store.ts'

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
interface Secret {
  ciphertext: string
  version: number
  updatedAt: number
}
interface Data {
  family: string
  mail: { configured: boolean; from: string }
  parties: Party[]
  instructions: Secret | null
  password: Secret | null
  pack: { size: number; madeAt: number; madeBy: string | null; downloadedAt: number | null } | null
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
      <PackCard ctx={ctx} data={data} onChanged={() => void load()} />

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

      <InstructionsCard ctx={ctx} data={data} onChanged={() => void load()} />

      <Card
        title={
          <>
            <ShieldAlert size={18} aria-hidden /> How it works
          </>
        }
      >
        <ul className="small">
          <li>Each trusted party gets a printed letter now, with a link to use if something has happened (and, for guardians, the password of the pack). The password is chosen here, kept in your password manager, and stored only encrypted with the family key: the server cannot read it.</li>
          <li>The pack (your instructions and what the hub knows) is made on a parent’s device whenever the vault is open, and locked there with that password. The server keeps only the locked file and cannot open it.</li>
          <li>When someone uses their link, you are both told and can cancel; only after a waiting period and a second check is the pack sent. If neither of you uses the hub for a long time, it checks in with you first. Coming after the pack.</li>
        </ul>
      </Card>

      {editing && <PartyDialog ctx={ctx} party={editing.party} onClose={(c) => (setEditing(null), c && void load())} />}
      {letter && <LetterDialog ctx={ctx} family={data.family} party={letter} password={data.password} onClose={(c) => (setLetter(null), c && void load())} />}
    </div>
  )
}

const kb = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

/** The pack's password (end-to-end encrypted) and the pack itself: when it was made, refreshing it, downloading it. */
function PackCard({ ctx, data, onChanged }: { ctx: HubContext; data: Data; onChanged: () => void }) {
  const unlocked = useVaultUnlocked()
  const [setting, setSetting] = useState(false)
  const [shown, setShown] = useState('')
  const refresh = useAction(async () => {
    await refreshPack(ctx.platform.api, ctx.user.displayName, { force: true })
    onChanged()
  })
  const download = useAction(async () => {
    const blob = await ctx.platform.api.blob('/api/emergency/pack')
    await saveMadeFile(ctx.platform, { name: reportFileName('Emergency pack', data.family, new Date().toISOString().slice(0, 10)), bytes: new Uint8Array(await blob.arrayBuffer()) }, 'save')
    onChanged()
  })
  const show = useAction(async () => {
    const key = vault.use()
    if (!key || !data.password) return
    setShown(await openSecret<string>(key, 'password', data.password.ciphertext))
  })
  return (
    <Card
      title={
        <>
          <Package size={18} aria-hidden /> The pack
        </>
      }
      actions={data.pack ? <Badge tone="success">Made {longDate(new Date(data.pack.madeAt))}</Badge> : <Badge tone="warning">Not made yet</Badge>}
    >
      <p className="muted small">
        Your instructions and what the hub knows (each of you and the children, health, ID numbers, medical aid, school, the household, money, important contacts, and the list of documents), as a PDF locked with the pack’s password. It is remade on a parent’s device whenever the vault is open (at
        most daily); the server keeps only the locked file.
      </p>
      {data.pack && (
        <p className="small">
          Last made {new Date(data.pack.madeAt).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' })}
          {data.pack.madeBy && ` by ${data.pack.madeBy}`} · {kb(data.pack.size)}
          {data.pack.downloadedAt && ` · last downloaded ${longDate(new Date(data.pack.downloadedAt))}`}
        </p>
      )}
      {!unlocked ? (
        <>
          <p className="small">Open the family vault to set the password, see it, or refresh the pack.</p>
          <VaultCard ctx={ctx} />
        </>
      ) : !data.password ? (
        <>
          <Banner kind="warning">Choose the pack’s password first: the pack is locked with it, and the guardians’ letters carry it.</Banner>
          <Button icon={<KeyRound size={16} aria-hidden />} onClick={() => setSetting(true)}>
            Choose the password
          </Button>
        </>
      ) : (
        <div className="row">
          <Button icon={<RefreshCw size={16} aria-hidden />} busy={refresh.busy} onClick={() => void refresh.run()}>
            Refresh now
          </Button>
          {data.pack && (
            <Button variant="secondary" icon={<FileDown size={16} aria-hidden />} busy={download.busy} onClick={() => void download.run()}>
              Download, to keep with the will
            </Button>
          )}
          <Button variant="ghost" icon={<Eye size={16} aria-hidden />} onClick={() => (shown ? setShown('') : void show.run())}>
            {shown ? 'Hide the password' : 'Show the password'}
          </Button>
          <Button variant="ghost" icon={<KeyRound size={16} aria-hidden />} onClick={() => setSetting(true)}>
            Change the password
          </Button>
        </div>
      )}
      {shown && (
        <div className="secret" aria-label="The pack’s password">
          {shown}
        </div>
      )}
      {data.pack && <p className="muted small">Print it and keep it with your will; you are reminded a year after downloading it to print a fresh one.</p>}
      {(refresh.error || download.error || show.error) && <Banner kind="error">{refresh.error || download.error || show.error}</Banner>}
      {setting && (
        <PasswordDialog
          ctx={ctx}
          current={data.password}
          guardiansWithLetters={data.parties.filter((p) => p.role === 'guardian' && p.letterAt).map((p) => p.name)}
          onClose={(changed) => {
            setSetting(false)
            setShown('')
            if (changed) void refreshPack(ctx.platform.api, ctx.user.displayName, { force: true }).finally(onChanged)
          }}
        />
      )}
    </Card>
  )
}

function PasswordDialog({ ctx, current, guardiansWithLetters, onClose }: { ctx: HubContext; current: Secret | null; guardiansWithLetters: string[]; onClose: (changed?: boolean) => void }) {
  const [password, setPassword] = useState(() => suggestPassword())
  const [saved, setSaved] = useState(false)
  const save = useAction(async () => {
    const problem = passwordProblem(password)
    if (problem) throw new Error(problem)
    if (!saved) throw new Error('Save it in your password manager first.')
    const key = vault.use()
    if (!key) throw new Error('The vault locked: open it again.')
    await ctx.platform.api.request('PUT', '/api/emergency/secrets/password', { baseVersion: current?.version ?? null, ciphertext: await sealSecret(key, 'password', password.trim()) }).catch(conflict)
    onClose(true)
  })
  return (
    <Dialog open title={current ? 'Change the pack’s password' : 'The pack’s password'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <p className="small">The pack is locked with it, and each guardian’s letter carries it. The hub keeps it encrypted with the family key: the server cannot read it.</p>
        {current && guardiansWithLetters.length > 0 && (
          <Banner kind="warning">The letters you gave {guardiansWithLetters.join(', ')} have the old password: give them new letters after changing it.</Banner>
        )}
        <Labelled id="pack-password" label="Password">
          <div className="row">
            <input id="pack-password" className="qi-search" autoComplete="off" spellCheck={false} maxLength={100} value={password} onChange={(e) => setPassword(e.target.value)} />
            <Button type="button" variant="ghost" onClick={() => setPassword(suggestPassword())}>
              Suggest another
            </Button>
          </div>
        </Labelled>
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>It is saved in our password manager (both of us can reach it)</span>
        </label>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} />
      </form>
    </Dialog>
  )
}

/** The parents' instructions, end-to-end encrypted: written here, read only in the pack. */
function InstructionsCard({ ctx, data, onChanged }: { ctx: HubContext; data: Data; onChanged: () => void }) {
  const unlocked = useVaultUnlocked()
  const [editing, setEditing] = useState<Instructions | null>(null)
  const open = useAction(async () => {
    const key = vault.use()
    if (!key) return
    setEditing(data.instructions ? await openSecret<Instructions>(key, 'instructions', data.instructions.ciphertext) : {})
  })
  const save = useAction(async () => {
    const key = vault.use()
    if (!key || !editing) throw new Error('The vault locked: open it again (your text is still here).')
    await ctx.platform.api.request('PUT', '/api/emergency/secrets/instructions', { baseVersion: data.instructions?.version ?? null, ciphertext: await sealSecret(key, 'instructions', editing) }).catch(conflict)
    setEditing(null)
    void refreshPack(ctx.platform.api, ctx.user.displayName, { force: true }).finally(onChanged)
    onChanged()
  })
  return (
    <Card
      title={
        <>
          <BookOpen size={18} aria-hidden /> Our instructions
        </>
      }
      actions={
        unlocked &&
        !editing && (
          <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} busy={open.busy} onClick={() => void open.run()}>
            {data.instructions ? 'Edit' : 'Write them'}
          </Button>
        )
      }
    >
      <p className="muted small">
        <Lock size={12} aria-hidden /> What the people taking over need to know from you, in your words. End-to-end encrypted: only the two of you (and the pack) can read it.
        {data.instructions && ` Last changed ${longDate(new Date(data.instructions.updatedAt))}.`}
      </p>
      {!unlocked && <p className="small">Open the family vault (above) to read or write them.</p>}
      {editing && (
        <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
          {INSTRUCTION_SECTIONS.map(([k, title, hint]) => (
            <Labelled key={k} id={`ins-${k}`} label={title} hint={hint || undefined}>
              <textarea id={`ins-${k}`} className="qi-search" rows={4} maxLength={20_000} value={editing[k] ?? ''} onChange={(e) => setEditing({ ...editing, [k]: e.target.value })} />
            </Labelled>
          ))}
          {save.error && <Banner kind="error">{save.error}</Banner>}
          <Actions busy={save.busy} onCancel={() => setEditing(null)} />
        </form>
      )}
      {open.error && <Banner kind="error">{open.error}</Banner>}
    </Card>
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

function LetterDialog({ ctx, family, party, password: stored, onClose }: { ctx: HubContext; family: string; party: Party; password: Secret | null; onClose: (changed?: boolean) => void }) {
  const guardian = party.role === 'guardian'
  const [from, setFrom] = useState(ctx.user.displayName)
  const unlocked = useVaultUnlocked()
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const blob = useMemo(() => (bytes ? new Blob([bytes as BlobPart], { type: 'application/pdf' }) : null), [bytes])
  const fileName = reportFileName('Letter', party.name, new Date().toISOString().slice(0, 10))
  const make = useAction(async () => {
    // A guardian's letter carries the pack's password, opened here from its end-to-end encrypted copy.
    let password: string | null = null
    if (guardian) {
      const key = vault.use()
      if (!key) throw new Error('Open the family vault first.')
      if (!stored) throw new Error('Choose the pack’s password first (The pack, above).')
      password = await openSecret<string>(key, 'password', stored.ciphertext)
    }
    if (party.letterAt && !window.confirm(`The link in ${party.name}’s earlier letter stops working. Make a new letter?`)) return
    const r = await ctx.platform.api.post<{ secret: string }>(`/api/emergency/parties/${party.id}/letter`, {})
    setBytes(
      makeLetter({
        family,
        from: from.trim() || ctx.user.displayName,
        party,
        link: requestLink(ctx, r.secret),
        password,
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
            {guardian && !stored && <Banner kind="warning">Choose the pack’s password first (The pack, above): a guardian’s letter carries it.</Banner>}
            {guardian && !unlocked && <Banner kind="warning">Open the family vault first (The pack, above): the password is kept encrypted with the family key.</Banner>}
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
