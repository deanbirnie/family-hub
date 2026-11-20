/**
 * The browser's way in: first-run setup, an invite, or password and code,
 * then the hub. Asks the server where the session stands after every step.
 */
import { useCallback, useEffect, useState } from 'react'
import { ApiError, type SessionInfo } from './api.ts'
import { EnrollScreen, InviteScreen, SetupScreen, SignInScreen, TotpScreen, AuthLayout } from './auth/screens.tsx'
import type { Platform } from './platform.ts'
import { matchPath, navigate, usePath } from './router.ts'
import { Shell } from './Shell.tsx'
import { Banner, Button, Spinner, errorText } from './ui.tsx'

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'setup' }
  | { kind: 'signin'; familyName: string }
  | { kind: 'totp' }
  | { kind: 'enroll' }
  | { kind: 'app'; session: SessionInfo }

export function WebGate({ platform }: { platform: Platform }) {
  const { api } = platform
  const path = usePath()
  const [state, setState] = useState<State>({ kind: 'loading' })

  const refresh = useCallback(async () => {
    try {
      const setup = await api.setupState()
      if (setup.needed) return setState({ kind: 'setup' })
      try {
        const session = await api.session()
        if (session.stage === 'totp') return setState({ kind: 'totp' })
        if (session.stage === 'enroll') return setState({ kind: 'enroll' })
        if (session.stage === 'full') return setState({ kind: 'app', session })
        // A browser never holds a 'device' session.
        await api.logout()
        return setState({ kind: 'signin', familyName: setup.familyName })
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return setState({ kind: 'signin', familyName: setup.familyName })
        throw e
      }
    } catch (e) {
      setState({ kind: 'error', message: errorText(e) })
    }
  }, [api])

  useEffect(() => {
    void refresh()
    api.onSignedOut = () => void refresh()
    return () => {
      api.onSignedOut = null
    }
  }, [api, refresh])

  const restart = async () => {
    await api.logout().catch(() => undefined)
    await refresh()
  }
  const step = () => void refresh()

  const invite = matchPath('/invite/:token', path)
  if (invite && state.kind !== 'app' && state.kind !== 'loading' && state.kind !== 'totp' && state.kind !== 'enroll') {
    return (
      <InviteScreen
        api={api}
        token={invite.token!}
        onStep={() => {
          navigate('/', true)
          step()
        }}
      />
    )
  }

  switch (state.kind) {
    case 'loading':
      return (
        <main className="auth">
          <Spinner />
        </main>
      )
    case 'error':
      return (
        <AuthLayout title="Family Hub is not answering">
          <Banner kind="error">{state.message}</Banner>
          <Button onClick={() => void refresh()}>Try again</Button>
        </AuthLayout>
      )
    case 'setup':
      return <SetupScreen api={api} onStep={step} />
    case 'signin':
      return <SignInScreen api={api} onStep={step} familyName={state.familyName} />
    case 'totp':
      return <TotpScreen api={api} onStep={step} onCancel={() => void restart()} />
    case 'enroll':
      return <EnrollScreen api={api} onStep={step} onCancel={() => void restart()} />
    case 'app':
      return <Shell platform={platform} session={state.session} onSignOut={() => void restart()} />
  }
}
