/**
 * Settings → Family vault, for parents: setting the vault up (with the
 * recovery key), opening it on this device, giving another device access,
 * and managing the passkeys and phones that can open it.
 */
import { CheckCircle2, Fingerprint, KeyRound, Lock, LockOpen, Smartphone, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { CopyButton } from '../auth/screens.tsx'
import { timeAgo } from '../format.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Field, Spinner, errorText, useAction, useLoad } from '../ui.tsx'
import {
  checkWords,
  formatRecoveryKey,
  makeCheck,
  newFamilyKey,
  newPairingKeys,
  openFromApproval,
  parseRecoveryKey,
  passkeyWrappingKey,
  randomBytes,
  sealForNewDevice,
  unwrapFamilyKey,
  verifyCheck,
  VaultCryptoError,
  wrapFamilyKey,
} from './crypto.ts'
import { createVaultPasskey, passkeyPrf, passkeysAvailable } from './passkey.ts'
import { vault } from './store.ts'

interface Method {
  id: string
  kind: 'passkey' | 'device'
  label: string
  credentialId: string | null
  prfSalt: string | null
  createdAt: number
  lastUsedAt: number | null
  thisDevice: boolean
}

interface VaultStatus {
  exists: boolean
  check: string | null
  methods: Method[]
}

type Mode = 'idle' | 'setup' | 'pair' | 'approve' | 'recovery'

export function useVaultUnlocked(): boolean {
  return useSyncExternalStore(vault.subscribe, () => vault.unlocked)
}

export function VaultCard({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const phone = ctx.platform.vaultDevice
  const status = useLoad(() => api.get<VaultStatus>('/api/vault'), [api])
  const unlocked = useVaultUnlocked()
  const [mode, setMode] = useState<Mode>('idle')
  const [notice, setNotice] = useState('')
  const methods = status.data?.methods ?? []
  const deviceMethod = methods.find((m) => m.thisDevice)
  const passkeys = methods.filter((m) => m.kind === 'passkey' && m.credentialId && m.prfSalt)

  /** The family key has reached this device: check it, keep it in memory, and let this phone open it next time. */
  const accept = useCallback(
    async (familyKey: Uint8Array, check: string) => {
      if (!(await verifyCheck(familyKey, check))) throw new VaultCryptoError('That key does not open this family’s vault.')
      vault.unlock(familyKey)
      if (phone && !deviceMethod) {
        await api.post('/api/vault/methods', { kind: 'device', wrapped: await phone.wrap(familyKey) })
        status.reload()
      }
    },
    [api, phone, deviceMethod, status],
  )

  const unlockWithPhone = useAction(async () => {
    if (!phone || !deviceMethod || !status.data?.check) return
    const { wrapped } = await api.get<{ wrapped: string }>(`/api/vault/methods/${deviceMethod.id}`)
    await accept(await phone.unwrap(wrapped), status.data.check)
  })

  const unlockWithPasskey = useAction(async () => {
    if (!status.data?.check) return
    const { credentialId, prfOutput } = await passkeyPrf(passkeys.map((m) => ({ credentialId: m.credentialId!, prfSalt: m.prfSalt! })))
    const method = passkeys.find((m) => m.credentialId === credentialId)
    if (!method) throw new VaultCryptoError('That passkey is not one of yours for the vault.')
    const { wrapped } = await api.get<{ wrapped: string }>(`/api/vault/methods/${method.id}`)
    await accept(await unwrapFamilyKey(await passkeyWrappingKey(prfOutput), wrapped, 'passkey'), status.data.check)
  })

  // On the phone, the fingerprint that opened the app also opens the vault.
  const tried = useRef(false)
  useEffect(() => {
    if (tried.current || unlocked || !phone || !deviceMethod) return
    tried.current = true
    void unlockWithPhone.run()
  }, [unlocked, phone, deviceMethod, unlockWithPhone])

  const addPasskey = useAction(async () => {
    const familyKey = vault.use()
    if (!familyKey) throw new VaultCryptoError('Open the vault first.')
    const created = await createVaultPasskey(ctx.user, ctx.familyName)
    const wrapped = await wrapFamilyKey(await passkeyWrappingKey(created.prfOutput), familyKey, 'passkey')
    await api.post('/api/vault/methods', { kind: 'passkey', credentialId: created.credentialId, prfSalt: created.prfSalt, label: ctx.platform.deviceLabel ?? 'Passkey', wrapped })
    setNotice('Passkey added. This browser can now open the vault with it.')
    status.reload()
  })

  const remove = useAction(async (m: Method) => {
    if (!window.confirm(`Remove “${m.label}”? It will no longer open the family vault.`)) return
    await api.del(`/api/vault/methods/${m.id}`)
    status.reload()
  })

  if (status.error) return <Card title="Family vault"><Banner kind="error">{status.error}</Banner></Card>
  if (!status.data) return <Card title="Family vault"><Spinner /></Card>
  const done = () => {
    setMode('idle')
    status.reload()
  }

  return (
    <Card
      title="Family vault"
      actions={!status.data.exists ? <Badge>Not set up</Badge> : unlocked ? <Badge tone="success">Open on this device</Badge> : <Badge>Locked</Badge>}
    >
      <p className="muted">
        Quick Info is kept in the family vault, encrypted on your devices: the server cannot read it. Only parents can open it.
      </p>
      {notice && <Banner kind="success" onClose={() => setNotice('')}>{notice}</Banner>}

      {!status.data.exists && mode !== 'setup' && (
        <div>
          <Button icon={<KeyRound size={16} aria-hidden />} onClick={() => setMode('setup')}>
            Set up the family vault
          </Button>
        </div>
      )}
      {mode === 'setup' && <SetupVault ctx={ctx} onDone={done} onCancel={() => setMode('idle')} />}

      {status.data.exists && !unlocked && mode === 'idle' && (
        <div className="stack-sm">
          {(unlockWithPhone.error || unlockWithPasskey.error) && <Banner kind="error">{unlockWithPhone.error || unlockWithPasskey.error}</Banner>}
          <div className="row">
            {phone && deviceMethod && (
              <Button busy={unlockWithPhone.busy} icon={<Fingerprint size={16} aria-hidden />} onClick={() => void unlockWithPhone.run()}>
                Open with your fingerprint
              </Button>
            )}
            {!phone && passkeys.length > 0 && (
              <Button busy={unlockWithPasskey.busy} icon={<LockOpen size={16} aria-hidden />} onClick={() => void unlockWithPasskey.run()}>
                Open with your passkey
              </Button>
            )}
          </div>
          {!(phone ? deviceMethod : passkeys.length) && <p>This device cannot open the vault yet.</p>}
          <div className="row">
            <Button variant="secondary" icon={<Smartphone size={16} aria-hidden />} onClick={() => setMode('pair')}>
              Get access from another device
            </Button>
            <Button variant="ghost" onClick={() => setMode('recovery')}>
              Use the recovery key
            </Button>
          </div>
        </div>
      )}
      {mode === 'pair' && <PairRequest ctx={ctx} check={status.data.check!} accept={accept} onDone={done} onCancel={() => setMode('idle')} />}
      {mode === 'recovery' && <RecoveryUnlock ctx={ctx} check={status.data.check!} accept={accept} onDone={done} onCancel={() => setMode('idle')} />}

      {status.data.exists && unlocked && mode === 'idle' && (
        <div className="stack-sm">
          <div className="row">
            <Button variant="secondary" icon={<Smartphone size={16} aria-hidden />} onClick={() => setMode('approve')}>
              Approve a new device
            </Button>
            {!phone && passkeysAvailable() && (
              <Button variant="secondary" busy={addPasskey.busy} icon={<KeyRound size={16} aria-hidden />} onClick={() => void addPasskey.run()}>
                Add a passkey
              </Button>
            )}
            <Button variant="ghost" icon={<Lock size={16} aria-hidden />} onClick={vault.lock}>
              Lock now
            </Button>
          </div>
          {addPasskey.error && <Banner kind="error">{addPasskey.error}</Banner>}
          <p className="muted small">The vault locks itself after 15 minutes without use.</p>
        </div>
      )}
      {mode === 'approve' && <ApproveDevice ctx={ctx} onDone={() => setMode('idle')} />}

      {status.data.exists && methods.length > 0 && (
        <>
          <h3 className="small muted">Your ways to open the vault</h3>
          <ul className="item-list">
            {methods.map((m) => (
              <li key={m.id}>
                {m.kind === 'device' ? <Smartphone size={20} aria-hidden /> : <KeyRound size={20} aria-hidden />}
                <div className="item-main">
                  <div>
                    {m.kind === 'device' ? `Phone: ${m.label}` : `Passkey: ${m.label}`}
                    {m.thisDevice && <Badge tone="accent">This phone</Badge>}
                  </div>
                  <div className="muted small">{m.lastUsedAt ? `Last opened ${timeAgo(m.lastUsedAt)}` : 'Not used yet'}</div>
                </div>
                <Button variant="ghost" icon={<Trash2 size={18} aria-hidden />} aria-label={`Remove ${m.label}`} onClick={() => void remove.run(m)} />
              </li>
            ))}
          </ul>
          {remove.error && <Banner kind="error">{remove.error}</Banner>}
        </>
      )}
    </Card>
  )
}

// ---- setting the vault up ---------------------------------------------------------------------

function SetupVault({ ctx, onDone, onCancel }: { ctx: HubContext; onDone: () => void; onCancel: () => void }) {
  const { api } = ctx.platform
  const phone = ctx.platform.vaultDevice
  const [keys] = useState(() => ({ family: newFamilyKey(), recovery: randomBytes(32) }))
  const recoveryText = formatRecoveryKey(keys.recovery)
  const [saved, setSaved] = useState(false)
  const create = useAction(async (withPasskey: boolean) => {
    let method: Record<string, unknown> | undefined
    if (phone) {
      method = { kind: 'device', wrapped: await phone.wrap(keys.family) }
    } else if (withPasskey) {
      const created = await createVaultPasskey(ctx.user, ctx.familyName)
      method = {
        kind: 'passkey',
        credentialId: created.credentialId,
        prfSalt: created.prfSalt,
        label: ctx.platform.deviceLabel ?? 'Passkey',
        wrapped: await wrapFamilyKey(await passkeyWrappingKey(created.prfOutput), keys.family, 'passkey'),
      }
    }
    await api.post('/api/vault', {
      check: await makeCheck(keys.family),
      recoveryWrapped: await wrapFamilyKey(keys.recovery, keys.family, 'recovery'),
      method,
    })
    vault.unlock(keys.family)
    onDone()
  })
  return (
    <div className="stack">
      <Banner kind="warning">
        <strong>Save this recovery key in your password manager now</strong>, as a secure note named “Family Hub recovery key”. It is
        shown only once. If every device that can open the vault is lost, it is the only way back in: nobody, not even the server’s
        owner, can recover the vault without it.
      </Banner>
      <div className="secret secret-wrap" aria-label="Recovery key">
        {recoveryText}
      </div>
      <div>
        <CopyButton text={recoveryText} label="Copy recovery key" />
      </div>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>I have saved the recovery key in my password manager</span>
      </label>
      {create.error && <Banner kind="error">{create.error}</Banner>}
      <div className="row">
        {phone ? (
          <Button disabled={!saved} busy={create.busy} icon={<Fingerprint size={16} aria-hidden />} onClick={() => void create.run(false)}>
            Create the vault on this phone
          </Button>
        ) : (
          <>
            <Button disabled={!saved || !passkeysAvailable()} busy={create.busy} icon={<KeyRound size={16} aria-hidden />} onClick={() => void create.run(true)}>
              Create the vault and add a passkey
            </Button>
            <Button variant="secondary" disabled={!saved} busy={create.busy} onClick={() => void create.run(false)}>
              Create without a passkey
            </Button>
          </>
        )}
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {!phone && <p className="muted small">Without a passkey, this browser opens the vault from your phone or with the recovery key.</p>}
    </div>
  )
}

// ---- getting the family key on this device ----------------------------------------------

type Accept = (familyKey: Uint8Array, check: string) => Promise<void>

function PairRequest({ ctx, check, accept, onDone, onCancel }: { ctx: HubContext; check: string; accept: Accept; onDone: () => void; onCancel: () => void }) {
  const { api } = ctx.platform
  const [state, setState] = useState<{ code: string; words: string[] } | null>(null)
  const [error, setError] = useState('')
  // One request per time this opens, whatever re-renders around it.
  const finish = useRef({ accept, onDone, check })
  finish.current = { accept, onDone, check }
  useEffect(() => {
    let live = true
    let timer: ReturnType<typeof setTimeout> | undefined
    void (async () => {
      try {
        const keys = await newPairingKeys()
        const label = ctx.platform.deviceLabel ?? 'A new device'
        const req = await api.post<{ id: string; code: string }>('/api/vault/pairings', { publicKey: keys.publicKey, label })
        if (!live) return
        setState({ code: req.code, words: await checkWords(keys.publicKey) })
        const poll = async () => {
          if (!live) return
          try {
            const r = await api.get<{ status: string; payload?: string }>(`/api/vault/pairings/${req.id}`)
            if (r.status === 'approved' && r.payload) {
              await finish.current.accept(await openFromApproval(keys, r.payload, req.id), finish.current.check)
              if (live) finish.current.onDone()
              return
            }
            if (r.status === 'expired') {
              setError('The request expired. Start again.')
              return
            }
          } catch (e) {
            setError(errorText(e))
            return
          }
          timer = setTimeout(() => void poll(), 2000)
        }
        void poll()
      } catch (e) {
        if (live) setError(errorText(e))
      }
    })()
    return () => {
      live = false
      if (timer) clearTimeout(timer)
    }
  }, [api, ctx.platform.deviceLabel])
  return (
    <div className="stack">
      <p>
        On a device where the family vault is open (yours, or the other parent’s), go to <strong>Settings → Family vault → Approve a new
        device</strong> and enter this code:
      </p>
      {state ? (
        <>
          <div className="pairing-code" aria-label="Pairing code">
            {state.code}
          </div>
          <p>Check that the other device shows these same six words before approving:</p>
          <div className="check-words" aria-label="Check words">
            {state.words.join(' · ')}
          </div>
          <p className="muted small">Waiting for approval… The code works for 10 minutes.</p>
        </>
      ) : (
        !error && <Spinner />
      )}
      {error && <Banner kind="error">{error}</Banner>}
      <div>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function RecoveryUnlock({ ctx, check, accept, onDone, onCancel }: { ctx: HubContext; check: string; accept: Accept; onDone: () => void; onCancel: () => void }) {
  const { api } = ctx.platform
  const [recovery, setRecovery] = useState('')
  const [code, setCode] = useState('')
  const action = useAction(async () => {
    const recoveryKey = parseRecoveryKey(recovery)
    const { wrapped } = await api.post<{ wrapped: string }>('/api/vault/recovery', { code })
    await accept(await unwrapFamilyKey(recoveryKey, wrapped, 'recovery'), check)
    setRecovery('')
    onDone()
  })
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault()
        void action.run()
      }}
    >
      <Field label="Recovery key" placeholder="FH1-…" value={recovery} onChange={(e) => setRecovery(e.target.value)} required autoComplete="off" autoCapitalize="characters" spellCheck={false} />
      <Field label="Code from your authenticator app" className="code-input" inputMode="numeric" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="one-time-code" />
      {action.error && <Banner kind="error">{action.error}</Banner>}
      <div className="row">
        <Button type="submit" busy={action.busy}>
          Open the vault
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

// ---- giving another device the family key ---------------------------------------------------

function ApproveDevice({ ctx, onDone }: { ctx: HubContext; onDone: () => void }) {
  const { api } = ctx.platform
  const [code, setCode] = useState('')
  const [found, setFound] = useState<{ id: string; publicKey: string; label: string; requester: string; words: string[] } | null>(null)
  const [approved, setApproved] = useState(false)
  const lookup = useAction(async () => {
    const r = await api.get<{ id: string; publicKey: string; label: string; requester: string }>(`/api/vault/pairings/code/${encodeURIComponent(code.trim())}`)
    setFound({ ...r, words: await checkWords(r.publicKey) })
  })
  const approve = useAction(async () => {
    const familyKey = vault.use()
    if (!familyKey || !found) throw new VaultCryptoError('The vault has locked. Open it again, then approve.')
    await api.post(`/api/vault/pairings/${found.id}/approve`, { payload: await sealForNewDevice(familyKey, found.publicKey, found.id) })
    setApproved(true)
  })
  if (approved) {
    return (
      <div className="stack">
        <Banner kind="success">Approved. The other device can now open the family vault.</Banner>
        <div>
          <Button onClick={onDone}>Done</Button>
        </div>
      </div>
    )
  }
  return found ? (
    <div className="stack">
      <p>
        <strong>{found.requester}</strong> is asking for access on <strong>{found.label}</strong>. Approve only if that device shows exactly
        these six words:
      </p>
      <div className="check-words" aria-label="Check words">
        {found.words.join(' · ')}
      </div>
      {approve.error && <Banner kind="error">{approve.error}</Banner>}
      <div className="row">
        <Button busy={approve.busy} icon={<CheckCircle2 size={16} aria-hidden />} onClick={() => void approve.run()}>
          The words match: approve
        </Button>
        <Button variant="ghost" onClick={onDone}>
          They don’t match: cancel
        </Button>
      </div>
    </div>
  ) : (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault()
        void lookup.run()
      }}
    >
      <Field label="Code shown on the new device" placeholder="XXXX-XXXX" value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="off" autoCapitalize="characters" spellCheck={false} />
      {lookup.error && <Banner kind="error">{lookup.error}</Banner>}
      <div className="row">
        <Button type="submit" busy={lookup.busy}>
          Continue
        </Button>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
