/**
 * The phone's way in.
 *
 *   1. Which server? (once)
 *   2. Password and authenticator code, or setting up the authenticator (once per phone)
 *   3. Register this phone's biometric key with the server (once per phone)
 *   4. Every time the app opens: fingerprint or face → signed challenge → a short session
 *
 * The session token lives only in memory. The app locks again when it has
 * been in the background for a couple of minutes, when the session ends, or
 * on "Lock now".
 */
import { App as CapApp } from '@capacitor/app'
import {
  Api,
  ApiError,
  AuthLayout,
  Banner,
  Button,
  EnrollScreen,
  errorText,
  Field,
  navigate,
  Shell,
  SignInScreen,
  Spinner,
  TotpScreen,
  useAction,
  type Platform,
  type SessionInfo,
} from '@family-hub/ui'
import { Fingerprint, Server } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CANCELLED, DeviceAuth, INVALIDATED, toBase64, type DeviceStatus } from './device-auth.ts'
import { createUpdates } from './updates.ts'
import { fileDownload, clearDocumentCache } from './files.ts'

const SERVER_KEY = 'familyhub.server'
const DEVICE_KEY = 'familyhub.deviceId'
const LOCK_AFTER_MS = 2 * 60_000

const read = (k: string) => {
  try {
    return localStorage.getItem(k) ?? ''
  } catch {
    return ''
  }
}
const write = (k: string, v: string) => {
  try {
    if (v) localStorage.setItem(k, v)
    else localStorage.removeItem(k)
  } catch {
    // private storage unavailable: the app asks again next time
  }
}

/** What the phone signs to unlock; must match the server's unlockMessage(). */
const unlockMessage = (challenge: string, deviceId: string) => new TextEncoder().encode(`family-hub-device-unlock\n${challenge}\n${deviceId}`)

type State =
  | { kind: 'server' }
  | { kind: 'signin'; notice?: string }
  | { kind: 'totp' }
  | { kind: 'enroll' }
  | { kind: 'register' }
  | { kind: 'locked'; notice?: string }
  | { kind: 'app'; session: SessionInfo }

export function MobileGate({ version }: { version: string }) {
  const [server, setServer] = useState(() => read(SERVER_KEY))
  const api = useMemo(() => new Api({ baseUrl: server, client: 'app' }), [server])
  const updates = useMemo(() => createUpdates(version), [version])
  const [state, setState] = useState<State>(() => (!server ? { kind: 'server' } : read(DEVICE_KEY) ? { kind: 'locked' } : { kind: 'signin' }))
  const hiddenAt = useRef(0)

  const lock = useCallback(
    (notice?: string) => {
      api.token = ''
      clearDocumentCache()
      navigate('/', true)
      setState(read(DEVICE_KEY) ? { kind: 'locked', notice } : { kind: 'signin', notice })
    },
    [api],
  )

  // Locks after a while in the background; checks for updates on the way back.
  useEffect(() => {
    updates.maybeCheck()
    const handle = CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        hiddenAt.current = Date.now()
        return
      }
      if (hiddenAt.current && Date.now() - hiddenAt.current > LOCK_AFTER_MS) lock()
      hiddenAt.current = 0
      updates.maybeCheck()
    })
    return () => void handle.then((h) => h.remove())
  }, [lock, updates])

  useEffect(() => {
    api.onSignedOut = () => lock('You were signed out. Unlock again.')
    return () => {
      api.onSignedOut = null
    }
  }, [api, lock])

  /** After each sign-in step, where to next. */
  const afterStep = async () => {
    try {
      const s = await api.session()
      if (s.stage === 'totp') setState({ kind: 'totp' })
      else if (s.stage === 'enroll') setState({ kind: 'enroll' })
      else if (s.stage === 'device') setState({ kind: 'register' })
      else setState({ kind: 'app', session: s })
    } catch (e) {
      setState({ kind: 'signin', notice: errorText(e) })
    }
  }

  const restart = () => {
    void api.logout().catch(() => undefined)
    setState({ kind: 'signin' })
  }

  const forgetDevice = async () => {
    clearDocumentCache()
    await api.logout().catch(() => undefined)
    await DeviceAuth.deleteKey().catch(() => undefined)
    write(DEVICE_KEY, '')
    navigate('/', true)
    setState({ kind: 'signin' })
  }

  const changeServer = async () => {
    await forgetDevice()
    write(SERVER_KEY, '')
    setServer('')
    setState({ kind: 'server' })
  }

  switch (state.kind) {
    case 'server':
      return (
        <ServerScreen
          onDone={(url) => {
            write(SERVER_KEY, url)
            setServer(url)
            setState({ kind: 'signin' })
          }}
        />
      )
    case 'signin':
      return (
        <SignInScreen
          api={api}
          onStep={() => void afterStep()}
          footer={
            <div className="stack-sm">
              {state.notice && <Banner kind="warning">{state.notice}</Banner>}
              <p className="muted small">
                Server: {server}{' '}
                <button className="link" onClick={() => void changeServer()}>
                  Change
                </button>
              </p>
              <p className="muted small">New to the family hub? Open your invite link in a browser first, then sign in here.</p>
            </div>
          }
        />
      )
    case 'totp':
      return <TotpScreen api={api} onStep={() => void afterStep()} onCancel={restart} />
    case 'enroll':
      return <EnrollScreen api={api} onStep={() => void afterStep()} onCancel={restart} onPhone />
    case 'register':
      return (
        <RegisterScreen
          api={api}
          onDone={(deviceId) => {
            write(DEVICE_KEY, deviceId)
            setState({ kind: 'locked' })
          }}
          onCancel={restart}
        />
      )
    case 'locked':
      return (
        <UnlockScreen
          api={api}
          notice={state.notice}
          onUnlocked={(session) => setState({ kind: 'app', session })}
          onForget={(notice) => {
            void forgetDevice().then(() => setState({ kind: 'signin', notice }))
          }}
        />
      )
    case 'app': {
      const platform: Platform = { kind: 'android', version, api, updates, serverUrl: server, lock: () => lock(), forgetDevice, downloadFile: fileDownload(api) }
      return <Shell platform={platform} session={state.session} onSignOut={() => lock()} />
    }
  }
}

// ---- 1. the server ----------------------------------------------------------------------

/** Plain http is only accepted for this machine (development); a phone needs https. */
export function normaliseServer(input: string): string {
  let text = input.trim()
  if (!/^[a-z]+:\/\//i.test(text)) text = `https://${text}`
  const url = new URL(text)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('The server address must start with https://. Family Hub needs a secure connection.')
  }
  return url.origin
}

function ServerScreen({ onDone }: { onDone: (url: string) => void }) {
  const [address, setAddress] = useState('')
  const action = useAction(async () => {
    const url = normaliseServer(address)
    let ok = false
    try {
      const res = await fetch(`${url}/api/health`, { cache: 'no-store' })
      ok = res.ok && ((await res.json()) as { ok?: boolean }).ok === true
    } catch {
      throw new Error(`Could not reach ${url}. Check the address, and that this phone can reach it.`)
    }
    if (!ok) throw new Error(`${url} does not look like a Family Hub server.`)
    onDone(url)
  })
  return (
    <AuthLayout title="Connect to your hub" subtitle="Enter the address of your family’s Family Hub server, as you open it in a browser.">
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          void action.run()
        }}
      >
        <Field label="Server address" placeholder="https://hub.example.com" value={address} onChange={(e) => setAddress(e.target.value)} required inputMode="url" autoCapitalize="none" spellCheck={false} autoFocus />
        {action.error && <Banner kind="error">{action.error}</Banner>}
        <Button type="submit" busy={action.busy} icon={<Server size={16} aria-hidden />}>
          Connect
        </Button>
      </form>
    </AuthLayout>
  )
}

// ---- 3. registering the phone -------------------------------------------------------------

function RegisterScreen({ api, onDone, onCancel }: { api: Api; onDone: (deviceId: string) => void; onCancel: () => void }) {
  const [status, setStatus] = useState<DeviceStatus | null>(null)
  const [name, setName] = useState('')
  const check = useCallback(() => {
    DeviceAuth.status().then(
      (s) => {
        setStatus(s)
        setName((n) => n || s.model)
      },
      () => setStatus({ available: false, hasKey: false, model: '', reason: 'This phone cannot keep a secure key.' }),
    )
  }, [])
  useEffect(check, [check])
  const register = useAction(async () => {
    const { publicKey } = await DeviceAuth.createKey()
    const { deviceId } = await api.post<{ deviceId: string }>('/api/devices', { name: name.trim() || 'Phone', publicKey })
    onDone(deviceId)
  })
  return (
    <AuthLayout title="Fingerprint or face unlock" subtitle="Family Hub on this phone always opens with your fingerprint or face. This is required, and keeps the family’s information safe if the phone is lost.">
      {!status && <Spinner />}
      {status && !status.available && (
        <div className="stack">
          <Banner kind="warning">{status.reason ?? 'Set up a fingerprint or face unlock in Android’s settings first.'}</Banner>
          <Button variant="secondary" onClick={check}>
            Check again
          </Button>
        </div>
      )}
      {status?.available && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            void register.run()
          }}
        >
          <Field label="Name for this phone" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} />
          {register.error && <Banner kind="error">{register.error}</Banner>}
          <Button type="submit" busy={register.busy} icon={<Fingerprint size={18} aria-hidden />}>
            Turn on fingerprint unlock
          </Button>
        </form>
      )}
      <button type="button" className="link center" onClick={onCancel}>
        Sign out
      </button>
    </AuthLayout>
  )
}

// ---- 4. unlocking ---------------------------------------------------------------------------

function UnlockScreen({ api, notice, onUnlocked, onForget }: { api: Api; notice?: string; onUnlocked: (s: SessionInfo) => void; onForget: (notice: string) => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const started = useRef(false)

  const unlock = useCallback(async () => {
    setBusy(true)
    setError('')
    const deviceId = read(DEVICE_KEY)
    try {
      const c = await api.post<{ challengeId: string; challenge: string }>('/api/devices/challenge', { deviceId })
      const { signature } = await DeviceAuth.sign({
        message: toBase64(unlockMessage(c.challenge, deviceId)),
        title: 'Unlock Family Hub',
        subtitle: 'Use your fingerprint or face',
      })
      await api.post('/api/devices/unlock', { deviceId, challengeId: c.challengeId, signature })
      onUnlocked(await api.session())
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === CANCELLED) setError('')
      else if (code === INVALIDATED) onForget('Your fingerprints or face changed, so this phone must be set up again. Sign in with your password and code.')
      else if (e instanceof ApiError && (e.code === 'device_removed' || e.code === 'disabled')) onForget(e.message)
      else setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }, [api, onUnlocked, onForget])

  useEffect(() => {
    if (started.current) return
    started.current = true
    void unlock()
  }, [unlock])

  return (
    <AuthLayout title="Family Hub is locked">
      <div className="unlock">
        <Fingerprint size={64} aria-hidden className="unlock-icon" />
        {notice && <Banner kind="info">{notice}</Banner>}
        {error && <Banner kind="error">{error}</Banner>}
        <Button busy={busy} onClick={() => void unlock()}>
          Unlock
        </Button>
      </div>
    </AuthLayout>
  )
}
