/**
 * The sign-in screens. Each one does one step and reports the server's
 * answer (`StepResult`) upwards; the gate around them decides what is next.
 */
import { Copy, Download, ExternalLink, Home, KeyRound, ShieldCheck, Smartphone } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { Api, StepResult } from '../api.ts'
import { Banner, Button, Field, Spinner, errorText, useAction } from '../ui.tsx'
import { Qr } from './Qr.tsx'

export function AuthLayout({ title, subtitle, children, wide = false }: { title: string; subtitle?: ReactNode; children: ReactNode; wide?: boolean }) {
  return (
    <main className="auth">
      <div className={`auth-card ${wide ? 'auth-card-wide' : ''}`}>
        <div className="brand brand-large">
          <span className="brand-mark" aria-hidden>
            <Home size={22} />
          </span>
          <span>Family Hub</span>
        </div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </div>
    </main>
  )
}

const PASSWORD_HINT = 'At least 12 characters. A few random words are easy to remember and hard to guess.'

// ---- first run ----------------------------------------------------------------

export function SetupScreen({ api, onStep }: { api: Api; onStep: (r: StepResult) => void }) {
  const [form, setForm] = useState({ familyName: '', displayName: '', username: '', password: '', confirm: '' })
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
  const action = useAction(async () => {
    if (form.password !== form.confirm) throw new Error('The passwords do not match.')
    onStep(await api.setup({ familyName: form.familyName, displayName: form.displayName, username: form.username, password: form.password }))
  })
  return (
    <AuthLayout title="Welcome" subtitle="Set up your family’s hub. You will be its first parent, and can invite everyone else afterwards.">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void action.run()
        }}
      >
        <Field label="Family name" placeholder="The Smiths" value={form.familyName} onChange={set('familyName')} required maxLength={60} />
        <Field label="Your name" placeholder="Alex" value={form.displayName} onChange={set('displayName')} required maxLength={60} autoComplete="name" />
        <Field
          label="Username"
          hint="For signing in: letters, numbers, dots or dashes."
          value={form.username}
          onChange={set('username')}
          required
          maxLength={32}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
        />
        <Field label="Password" type="password" hint={PASSWORD_HINT} value={form.password} onChange={set('password')} required minLength={12} autoComplete="new-password" />
        <Field label="Password again" type="password" value={form.confirm} onChange={set('confirm')} required autoComplete="new-password" />
        {action.error && <Banner kind="error">{action.error}</Banner>}
        <Button type="submit" busy={action.busy}>
          Create the family hub
        </Button>
      </form>
    </AuthLayout>
  )
}

// ---- password -------------------------------------------------------------------

export function SignInScreen({ api, onStep, familyName, footer }: { api: Api; onStep: (r: StepResult) => void; familyName?: string; footer?: ReactNode }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const action = useAction(async () => onStep(await api.login(username, password)))
  return (
    <AuthLayout title="Sign in" subtitle={familyName ? `to ${familyName}’s hub` : undefined}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void action.run()
        }}
      >
        <Field label="Username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="username" autoCapitalize="none" spellCheck={false} autoFocus />
        <Field label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        {action.error && <Banner kind="error">{action.error}</Banner>}
        <Button type="submit" busy={action.busy}>
          Continue
        </Button>
      </form>
      {footer}
    </AuthLayout>
  )
}

// ---- code from the authenticator --------------------------------------------------------

export function TotpScreen({ api, onStep, onCancel }: { api: Api; onStep: (r: StepResult) => void; onCancel: () => void }) {
  const [code, setCode] = useState('')
  const [useRecovery, setUseRecovery] = useState(false)
  const [notice, setNotice] = useState('')
  const action = useAction(async () => {
    try {
      // (Running low on recovery codes is shown on the home page.)
      onStep(useRecovery ? await api.recovery(code) : await api.totp(code))
    } catch (e) {
      // Too many wrong codes ends the attempt: back to the password.
      if ((e as { code?: string }).code === 'restart') {
        setNotice(errorText(e))
        onCancel()
        return
      }
      setCode('')
      throw e
    }
  })
  const submit = (e: FormEvent) => {
    e.preventDefault()
    void action.run()
  }
  return (
    <AuthLayout
      title="Two-factor sign-in"
      subtitle={useRecovery ? 'Enter one of the recovery codes you saved when you set up two-factor sign-in.' : 'Enter the 6-digit code from your authenticator app.'}
    >
      <form className="stack" onSubmit={submit}>
        {useRecovery ? (
          <Field label="Recovery code" placeholder="xxxxx-xxxxx" value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="off" autoCapitalize="none" spellCheck={false} autoFocus />
        ) : (
          <Field
            label="Code"
            className="code-input"
            inputMode="numeric"
            pattern="[0-9 ]{6,7}"
            maxLength={7}
            placeholder="123 456"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            autoComplete="one-time-code"
            autoFocus
          />
        )}
        {notice && <Banner kind="warning">{notice}</Banner>}
        {action.error && <Banner kind="error">{action.error}</Banner>}
        <Button type="submit" busy={action.busy}>
          Sign in
        </Button>
        <div className="row-between">
          <button
            type="button"
            className="link"
            onClick={() => {
              setUseRecovery(!useRecovery)
              setCode('')
              action.setError('')
            }}
          >
            {useRecovery ? 'Use the authenticator app' : 'Lost your phone? Use a recovery code'}
          </button>
          <button type="button" className="link" onClick={onCancel}>
            Start again
          </button>
        </div>
      </form>
    </AuthLayout>
  )
}

// ---- setting up the authenticator -------------------------------------------------------

export function EnrollScreen({ api, onStep, onCancel, onPhone = false }: { api: Api; onStep: (r: StepResult) => void; onCancel: () => void; onPhone?: boolean }) {
  const [offer, setOffer] = useState<{ secret: string; otpauthUrl: string } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [code, setCode] = useState('')
  const [done, setDone] = useState<StepResult | null>(null)
  useEffect(() => {
    api.totpOffer().then(setOffer, (e: unknown) => setLoadError(errorText(e)))
  }, [api])
  const action = useAction(async () => {
    try {
      setDone(await api.totpConfirm(code))
    } catch (e) {
      setCode('')
      if ((e as { code?: string }).code === 'restart') onCancel()
      throw e
    }
  })

  if (done?.recoveryCodes) {
    return <RecoveryCodesScreen codes={done.recoveryCodes} onDone={() => onStep(done)} />
  }

  return (
    <AuthLayout
      title="Set up two-factor sign-in"
      subtitle="Family Hub keeps important family information, so signing in always needs your password and a code from an authenticator app on your phone."
      wide
    >
      {loadError && <Banner kind="error">{loadError}</Banner>}
      {!offer && !loadError && <Spinner />}
      {offer && (
        <ol className="steps">
          <li>
            <h3>
              <Smartphone size={18} aria-hidden /> Get an authenticator app
            </h3>
            <p className="muted">Any will do: Google Authenticator, Microsoft Authenticator, Aegis, 2FAS, or the one built into 1Password or Bitwarden.</p>
          </li>
          <li>
            <h3>
              <KeyRound size={18} aria-hidden /> Add Family Hub to it
            </h3>
            {onPhone ? (
              <p className="muted">Tap the button to open your authenticator app, or copy the key into it by hand.</p>
            ) : (
              <p className="muted">Scan this code with the app, or type the key in by hand.</p>
            )}
            <div className="enroll-key">
              {!onPhone && <Qr text={offer.otpauthUrl} label="QR code for your authenticator app" />}
              <div className="stack-sm">
                {onPhone && (
                  <a className="btn btn-secondary" href={offer.otpauthUrl}>
                    <ExternalLink size={16} aria-hidden />
                    <span>Open authenticator app</span>
                  </a>
                )}
                <div className="secret" aria-label="Setup key">
                  {offer.secret.match(/.{1,4}/g)!.join(' ')}
                </div>
                <CopyButton text={offer.secret} label="Copy key" />
              </div>
            </div>
          </li>
          <li>
            <h3>
              <ShieldCheck size={18} aria-hidden /> Enter the code it shows
            </h3>
            <form
              className="stack"
              onSubmit={(e) => {
                e.preventDefault()
                void action.run()
              }}
            >
              <Field
                label="6-digit code"
                className="code-input"
                inputMode="numeric"
                pattern="[0-9 ]{6,7}"
                maxLength={7}
                placeholder="123 456"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                autoComplete="one-time-code"
              />
              {action.error && <Banner kind="error">{action.error}</Banner>}
              <Button type="submit" busy={action.busy}>
                Turn on two-factor sign-in
              </Button>
            </form>
          </li>
        </ol>
      )}
      <button type="button" className="link center" onClick={onCancel}>
        Sign out
      </button>
    </AuthLayout>
  )
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="secondary"
      icon={<Copy size={16} aria-hidden />}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        })
      }}
    >
      {copied ? 'Copied' : label}
    </Button>
  )
}

export function RecoveryCodesList({ codes }: { codes: string[] }) {
  const text = `Family Hub recovery codes\nEach code works once. Keep them somewhere safe.\n\n${codes.join('\n')}\n`
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'family-hub-recovery-codes.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="stack">
      <ul className="codes" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="row">
        <CopyButton text={codes.join('\n')} label="Copy all" />
        <Button type="button" variant="secondary" icon={<Download size={16} aria-hidden />} onClick={download}>
          Download
        </Button>
      </div>
    </div>
  )
}

export function RecoveryCodesScreen({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false)
  return (
    <AuthLayout title="Save your recovery codes" subtitle="If you lose your phone, each of these codes lets you sign in once instead of a code from the app. Keep them somewhere safe, such as a password manager or printed in a drawer.">
      <RecoveryCodesList codes={codes} />
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I have saved my recovery codes</span>
      </label>
      <Button disabled={!saved} onClick={onDone}>
        Continue
      </Button>
    </AuthLayout>
  )
}

// ---- joining from an invite ---------------------------------------------------------------

export function InviteScreen({ api, token, onStep }: { api: Api; token: string; onStep: (r: StepResult) => void }) {
  const [invite, setInvite] = useState<{ displayName: string; familyName: string } | null>(null)
  const [loadError, setLoadError] = useState('')
  const [form, setForm] = useState({ displayName: '', username: '', password: '', confirm: '' })
  useEffect(() => {
    api.invite(token).then(
      (i) => {
        setInvite(i)
        setForm((f) => ({ ...f, displayName: i.displayName }))
      },
      (e: unknown) => setLoadError(errorText(e)),
    )
  }, [api, token])
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
  const action = useAction(async () => {
    if (form.password !== form.confirm) throw new Error('The passwords do not match.')
    onStep(await api.acceptInvite(token, { displayName: form.displayName, username: form.username, password: form.password }))
  })

  if (loadError) {
    return (
      <AuthLayout title="Invite link">
        <Banner kind="error">{loadError}</Banner>
        <p className="muted">Ask whoever invited you for a new link.</p>
      </AuthLayout>
    )
  }
  if (!invite) return <AuthLayout title="Invite link"><Spinner /></AuthLayout>
  return (
    <AuthLayout title={`Join ${invite.familyName}`} subtitle="You have been invited to the family hub. Choose how you will sign in.">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void action.run()
        }}
      >
        <Field label="Your name" value={form.displayName} onChange={set('displayName')} required maxLength={60} autoComplete="name" />
        <Field label="Username" hint="For signing in: letters, numbers, dots or dashes." value={form.username} onChange={set('username')} required maxLength={32} autoComplete="username" autoCapitalize="none" spellCheck={false} />
        <Field label="Password" type="password" hint={PASSWORD_HINT} value={form.password} onChange={set('password')} required minLength={12} autoComplete="new-password" />
        <Field label="Password again" type="password" value={form.confirm} onChange={set('confirm')} required autoComplete="new-password" />
        {action.error && <Banner kind="error">{action.error}</Banner>}
        <Button type="submit" busy={action.busy}>
          Join
        </Button>
      </form>
    </AuthLayout>
  )
}
