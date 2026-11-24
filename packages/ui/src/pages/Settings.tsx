/** Settings: profile, password, two-factor, where you are signed in, phones, family and about. */
import { Download, Laptop, Lock, LogOut, RefreshCw, Smartphone, Trash2 } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { RecoveryCodesList } from '../auth/screens.tsx'
import { describeAgent, EVENT_NAMES, formatDateTime, timeAgo } from '../format.ts'
import { navigate } from '../router.ts'
import type { HubContext } from '../Shell.tsx'
import { VaultCard } from '../vault/VaultCard.tsx'
import { NotificationsCard } from '../notify/NotificationsCard.tsx'
import { Badge, Banner, Button, Card, Field, PageHeader, Spinner, useAction, useLoad } from '../ui.tsx'

export function SettingsPage({ ctx }: { ctx: HubContext }) {
  return (
    <div className="page">
      <PageHeader title="Settings" />
      {ctx.platform.updates && <UpdatesCard ctx={ctx} />}
      {ctx.user.role === 'admin' && ctx.serverKeySaved === false && <ServerKeyCard ctx={ctx} />}
      <NotificationsCard ctx={ctx} />
      <ProfileCard ctx={ctx} />
      <PasswordCard ctx={ctx} />
      <TwoFactorCard ctx={ctx} />
      <SessionsCard ctx={ctx} />
      <DevicesCard ctx={ctx} />
      <ActivityCard ctx={ctx} />
      {ctx.user.role === 'admin' && <VaultCard ctx={ctx} />}
      {ctx.user.role === 'admin' && <FamilyCard ctx={ctx} />}
      {ctx.user.role === 'admin' && <EmergencyCard />}
      {ctx.user.role === 'admin' && ctx.serverKeySaved === true && <ServerKeyCard ctx={ctx} />}
      <AboutCard ctx={ctx} />
    </div>
  )
}

/** The way to "In case of emergency": trusted parties, letters and the hub's email. */
function EmergencyCard() {
  return (
    <Card title="In case of emergency" actions={<Button variant="ghost" onClick={() => navigate('/emergency')}>Open</Button>}>
      <p className="muted small">If something happens to both of you: who takes over the children, the letters to give them, and the hub’s email.</p>
    </Card>
  )
}

/**
 * The server key, for a parent to copy into a password manager. Shown at the
 * top of Settings until someone confirms it is saved, then lower down.
 */
function ServerKeyCard({ ctx }: { ctx: HubContext }) {
  const [code, setCode] = useState('')
  const [key, setKey] = useState<{ key: string; file: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const reveal = useAction(async () => {
    setKey(await ctx.platform.api.post<{ key: string; file: string }>('/api/server-key/reveal', { code }))
    setCode('')
  })
  const confirm = useAction(async () => {
    await ctx.platform.api.post('/api/server-key/saved')
    ctx.setServerKeySaved(true)
    setKey(null)
  })
  const copy = () => {
    if (!key) return
    void navigator.clipboard?.writeText(key.key).then(() => {
      setCopied(true)
      // Do not leave the key on the clipboard.
      setTimeout(() => {
        void navigator.clipboard?.writeText('').catch(() => undefined)
        setCopied(false)
      }, 30_000)
    })
  }
  const pending = ctx.serverKeySaved === false
  return (
    <Card title="Server key" actions={pending ? <Badge tone="warning">Not saved yet</Badge> : <Badge tone="success">Saved</Badge>}>
      <p>
        Family Hub encrypts documents and sign-in secrets with this key. It is kept apart from the hub’s data, so a stolen backup
        cannot be read, but it also means <strong>a backup cannot be restored without it</strong>. Keep a copy in your password manager.
      </p>
      {key ? (
        <div className="stack">
          <div className="secret secret-wrap" aria-label="Server key">
            {key.key}
          </div>
          <p className="muted small">
            Save it as a secure note, for example “Family Hub server key”. On the server it is <code>{key.file}</code>.
          </p>
          <div className="row">
            <Button variant="secondary" onClick={copy}>
              {copied ? 'Copied (clears in 30 s)' : 'Copy key'}
            </Button>
            {pending && (
              <Button busy={confirm.busy} onClick={() => void confirm.run()}>
                I’ve saved it in my password manager
              </Button>
            )}
            {!pending && (
              <Button variant="ghost" onClick={() => setKey(null)}>
                Hide
              </Button>
            )}
          </div>
          {confirm.error && <Banner kind="error">{confirm.error}</Banner>}
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            void reveal.run()
          }}
        >
          <Field
            label={pending ? 'Enter a code from your authenticator app to show the key' : 'Show the key again: code from your authenticator app'}
            className="code-input"
            inputMode="numeric"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoComplete="one-time-code"
          />
          {reveal.error && <Banner kind="error">{reveal.error}</Banner>}
          <div>
            <Button type="submit" variant={pending ? 'primary' : 'secondary'} busy={reveal.busy}>
              Show the key
            </Button>
          </div>
        </form>
      )}
    </Card>
  )
}

function ProfileCard({ ctx }: { ctx: HubContext }) {
  const [name, setName] = useState(ctx.user.displayName)
  const [saved, setSaved] = useState(false)
  const save = useAction(async () => {
    const r = await ctx.platform.api.patch<{ user: HubContext['user'] }>('/api/account', { displayName: name })
    ctx.setUser(r.user)
    setSaved(true)
  })
  return (
    <Card title="Your profile">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save.run()
        }}
      >
        <Field label="Name" value={name} onChange={(e) => (setName(e.target.value), setSaved(false))} required maxLength={60} />
        <p className="muted">Username: @{ctx.user.username}</p>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        {saved && <Banner kind="success">Saved.</Banner>}
        <div>
          <Button type="submit" variant="secondary" busy={save.busy} disabled={name.trim() === ctx.user.displayName}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  )
}

function PasswordCard({ ctx }: { ctx: HubContext }) {
  const empty = { current: '', next: '', confirm: '' }
  const [form, setForm] = useState(empty)
  const [saved, setSaved] = useState(false)
  const save = useAction(async () => {
    if (form.next !== form.confirm) throw new Error('The new passwords do not match.')
    await ctx.platform.api.post('/api/account/password', { currentPassword: form.current, newPassword: form.next })
    setForm(empty)
    setSaved(true)
  })
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => (setForm({ ...form, [k]: e.target.value }), setSaved(false))
  return (
    <Card title="Password">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save.run()
        }}
      >
        <Field label="Current password" type="password" value={form.current} onChange={set('current')} required autoComplete="current-password" />
        <Field label="New password" type="password" hint="At least 12 characters." value={form.next} onChange={set('next')} required minLength={12} autoComplete="new-password" />
        <Field label="New password again" type="password" value={form.confirm} onChange={set('confirm')} required autoComplete="new-password" />
        {save.error && <Banner kind="error">{save.error}</Banner>}
        {saved && <Banner kind="success">Password changed. You were signed out everywhere else, and your other phones must sign in again.</Banner>}
        <div>
          <Button type="submit" variant="secondary" busy={save.busy}>
            Change password
          </Button>
        </div>
      </form>
    </Card>
  )
}

function TwoFactorCard({ ctx }: { ctx: HubContext }) {
  const account = useLoad(() => ctx.platform.api.get<{ recoveryCodesLeft: number }>('/api/account'), [])
  const [code, setCode] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [asking, setAsking] = useState(false)
  const renew = useAction(async () => {
    const r = await ctx.platform.api.post<{ recoveryCodes: string[] }>('/api/account/recovery-codes', { code })
    setCodes(r.recoveryCodes)
    setCode('')
    setAsking(false)
    account.reload()
  })
  return (
    <Card title="Two-factor sign-in" actions={<Badge tone="success">On</Badge>}>
      <p>Signing in needs your password and a code from your authenticator app. It cannot be turned off.</p>
      {account.data && (
        <p className="muted">
          {account.data.recoveryCodesLeft} of 10 recovery codes left.
        </p>
      )}
      {codes && (
        <div className="stack">
          <Banner kind="success">Your new recovery codes are below. The old ones no longer work.</Banner>
          <RecoveryCodesList codes={codes} />
        </div>
      )}
      {asking ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            void renew.run()
          }}
        >
          <Field label="Code from your authenticator app" className="code-input" inputMode="numeric" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="one-time-code" autoFocus />
          {renew.error && <Banner kind="error">{renew.error}</Banner>}
          <div className="row">
            <Button type="submit" busy={renew.busy}>
              Make new codes
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <div>
          <Button variant="secondary" icon={<RefreshCw size={16} aria-hidden />} onClick={() => (setAsking(true), setCodes(null))}>
            New recovery codes
          </Button>
        </div>
      )}
    </Card>
  )
}

interface SessionRow {
  id: string
  kind: 'app' | 'browser'
  deviceName: string | null
  lastSeenAt: number
  userAgent: string
  ip: string
  current: boolean
}

function SessionsCard({ ctx }: { ctx: HubContext }) {
  const sessions = useLoad(() => ctx.platform.api.get<{ sessions: SessionRow[] }>('/api/account/sessions'), [])
  const end = useAction(async (id: string) => {
    await ctx.platform.api.del(`/api/account/sessions/${id}`)
    sessions.reload()
  })
  return (
    <Card title="Where you’re signed in">
      {!sessions.data && <Spinner />}
      {sessions.error && <Banner kind="error">{sessions.error}</Banner>}
      <ul className="item-list">
        {sessions.data?.sessions.map((s) => (
          <li key={s.id}>
            {s.kind === 'app' ? <Smartphone size={20} aria-hidden /> : <Laptop size={20} aria-hidden />}
            <div className="item-main">
              <div>
                {s.kind === 'app' ? `Android app on ${s.deviceName ?? 'a phone'}` : describeAgent(s.userAgent)}
                {s.current && <Badge tone="accent">This one</Badge>}
              </div>
              <div className="muted small">
                {s.ip} · active {timeAgo(s.lastSeenAt)}
              </div>
            </div>
            {!s.current && (
              <Button variant="ghost" icon={<LogOut size={18} aria-hidden />} aria-label="Sign out this session" onClick={() => void end.run(s.id)} />
            )}
          </li>
        ))}
      </ul>
      {end.error && <Banner kind="error">{end.error}</Banner>}
    </Card>
  )
}

interface DeviceRow {
  id: string
  name: string
  createdAt: number
  lastUsedAt: number | null
  current: boolean
}

function DevicesCard({ ctx }: { ctx: HubContext }) {
  const devices = useLoad(() => ctx.platform.api.get<{ devices: DeviceRow[] }>('/api/account/devices'), [])
  const remove = useAction(async (d: DeviceRow) => {
    if (!window.confirm(`Remove ${d.name}? It will be signed out, and has to sign in with password and code again.`)) return
    await ctx.platform.api.del(`/api/account/devices/${d.id}`)
    devices.reload()
  })
  return (
    <Card title="Your phones">
      <p className="muted">Phones with the Family Hub app open it with a fingerprint or face. Remove one you no longer have.</p>
      {devices.data?.devices.length === 0 && <p className="muted">No phones yet. Install the Android app from the project’s releases page.</p>}
      <ul className="item-list">
        {devices.data?.devices.map((d) => (
          <li key={d.id}>
            <Smartphone size={20} aria-hidden />
            <div className="item-main">
              <div>
                {d.name}
                {d.current && <Badge tone="accent">This phone</Badge>}
              </div>
              <div className="muted small">{d.lastUsedAt ? `Last unlocked ${timeAgo(d.lastUsedAt)}` : 'Not unlocked yet'}</div>
            </div>
            <Button variant="ghost" icon={<Trash2 size={18} aria-hidden />} aria-label={`Remove ${d.name}`} onClick={() => void remove.run(d)} />
          </li>
        ))}
      </ul>
      {remove.error && <Banner kind="error">{remove.error}</Banner>}
    </Card>
  )
}

function ActivityCard({ ctx }: { ctx: HubContext }) {
  const [open, setOpen] = useState(false)
  const events = useLoad(() => (open ? ctx.platform.api.get<{ events: { at: number; event: string; ip: string }[] }>('/api/account/activity') : Promise.resolve(null)), [open])
  return (
    <Card title="Recent security activity" actions={<Button variant="ghost" onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Show'}</Button>}>
      {!open && <p className="muted">Sign-ins, failed attempts and changes to your account.</p>}
      {open && !events.data && <Spinner />}
      {open && events.data && (
        <ul className="activity">
          {events.data.events.map((e, i) => (
            <li key={i} className={/failed|locked|reused/.test(e.event) ? 'activity-warn' : ''}>
              <span>{EVENT_NAMES[e.event] ?? e.event}</span>
              <span className="muted small">
                {formatDateTime(e.at)} · {e.ip}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function FamilyCard({ ctx }: { ctx: HubContext }) {
  const [name, setName] = useState(ctx.familyName)
  const save = useAction(async () => {
    const r = await ctx.platform.api.patch<{ name: string }>('/api/family', { name })
    ctx.setFamilyName(r.name)
  })
  return (
    <Card title="Family">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void save.run()
        }}
      >
        <Field label="Family name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <div>
          <Button type="submit" variant="secondary" busy={save.busy} disabled={name.trim() === ctx.familyName}>
            Save
          </Button>
        </div>
      </form>
    </Card>
  )
}

function UpdatesCard({ ctx }: { ctx: HubContext }) {
  const updates = ctx.platform.updates!
  const info = useSyncExternalStore(updates.subscribe, () => updates.info)
  const install = useAction(() => updates.install())
  return (
    <Card title="App updates" actions={info.status === 'available' ? <Badge tone="accent">New version</Badge> : undefined}>
      {info.status === 'available' ? (
        <div className="stack">
          <p>
            Family Hub <strong>{info.version}</strong> is ready (you have {ctx.platform.version}).
          </p>
          {info.notes?.map((n) => (
            <div key={n.version}>
              <strong>{n.version}</strong>
              {n.changes.length > 0 ? (
                <ul className="changes">
                  {n.changes.map((c, i) => (
                    <li key={i}>{c}</li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Fixes and improvements.</p>
              )}
            </div>
          ))}
          {info.progress !== undefined && <progress max={100} value={info.progress} />}
          {(install.error || info.message) && <Banner kind="error">{install.error || info.message}</Banner>}
          <div>
            <Button busy={install.busy} icon={<Download size={16} aria-hidden />} onClick={() => void install.run()}>
              Download and install
            </Button>
          </div>
        </div>
      ) : (
        <div className="row-between">
          <span className="muted">
            {info.status === 'checking' ? 'Checking…' : info.status === 'error' ? info.message : info.status === 'current' ? `You have the latest version (${ctx.platform.version}).` : `Version ${ctx.platform.version}`}
          </span>
          <Button variant="secondary" busy={info.status === 'checking'} icon={<RefreshCw size={16} aria-hidden />} onClick={() => void updates.check()}>
            Check now
          </Button>
        </div>
      )}
    </Card>
  )
}

function AboutCard({ ctx }: { ctx: HubContext }) {
  const { platform } = ctx
  const forget = useAction(async () => {
    if (!window.confirm('Sign this phone out of Family Hub? You will need your password and an authenticator code to set it up again.')) return
    await platform.forgetDevice?.()
  })
  return (
    <Card title="About">
      <dl className="facts">
        <dt>Version</dt>
        <dd>{platform.version}</dd>
        {platform.serverUrl && (
          <>
            <dt>Server</dt>
            <dd>{platform.serverUrl}</dd>
          </>
        )}
      </dl>
      <div className="row">
        {platform.lock && (
          <Button variant="secondary" icon={<Lock size={16} aria-hidden />} onClick={platform.lock}>
            Lock now
          </Button>
        )}
        {platform.forgetDevice ? (
          <Button variant="danger" busy={forget.busy} icon={<LogOut size={16} aria-hidden />} onClick={() => void forget.run()}>
            Sign this phone out
          </Button>
        ) : (
          <Button variant="secondary" icon={<LogOut size={16} aria-hidden />} onClick={ctx.signOut}>
            Sign out
          </Button>
        )}
      </div>
      {forget.error && <Banner kind="error">{forget.error}</Banner>}
    </Card>
  )
}
