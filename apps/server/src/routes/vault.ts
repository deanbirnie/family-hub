/**
 * The family vault: parents' end-to-end encrypted records (Quick Info, and
 * later Health), under a family key the server never sees.
 *
 * What the server keeps, and why it cannot open any of it:
 *
 * - A **check value**: a known text encrypted under the family key, so a
 *   device can confirm it holds the right key.
 * - **Wrapped copies** of the family key, one per way of opening the vault:
 *     recovery  wrapped by the recovery key, which only the owner's password
 *               manager holds
 *     passkey   wrapped by a secret only that passkey can produce (WebAuthn PRF)
 *     device    wrapped by a key in that phone's hardware keystore, usable
 *               only after a fingerprint or face check
 *   Each is handed only to the person and device it belongs to.
 * - **Pairing requests**, to give the family key to a new device: the new
 *   device posts a one-time public key; an unlocked parent device encrypts the
 *   family key to it after the person has checked that both screens show the
 *   same words (so even a server that swapped the public key would be found
 *   out). The server relays the result once and forgets it.
 *
 * Everything here is for parents only (the admin role).
 */
import { createPublicKey } from 'node:crypto'
import type { Api, AuthedCtx, Services } from '../app.ts'
import { tx } from '../db.ts'
import { HttpError, readJson, str } from '../http.ts'
import { hashToken, newId } from '../secrets.ts'
import { requireFreshCode } from '../step-up.ts'
import { tooMany } from './auth.ts'

const VAULT_SETTING = 'vault'
const PAIRING_MS = 10 * 60_000
const MAX_METHODS = 20
/** Pairing codes: 8 characters without look-alikes, shown as XXXX-XXXX. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

interface VaultKeyRow {
  id: string
  kind: 'recovery' | 'passkey' | 'device'
  user_id: string | null
  device_id: string | null
  credential_id: string | null
  prf_salt: string | null
  label: string
  wrapped: string
  created_at: number
  last_used_at: number | null
}

interface PairingRow {
  id: string
  user_id: string
  public_key: string
  label: string
  created_at: number
  expires_at: number
  approved_by: string | null
  payload: string | null
}

/** Wrapped keys and payloads are base64url text of bounded size. */
const blob = (body: Record<string, unknown>, key: string, max = 2000) => {
  const value = str(body, key, { max })
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, `"${key}" is not valid.`, 'invalid')
  return value
}

export const normalisePairingCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '')

function newPairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let code = ''
  for (const b of bytes) {
    if (code.length === 8) break
    code += CODE_ALPHABET[b % CODE_ALPHABET.length] // 32 divides 256: uniform
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

export function vaultRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const

  const vaultInfo = () => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(VAULT_SETTING) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as { check: string; createdAt: number; createdBy: string }) : null
  }
  const requireVault = () => {
    const v = vaultInfo()
    if (!v) throw new HttpError(409, 'The family vault has not been set up yet.', 'no_vault')
    return v
  }
  const methodInfo = (ctx: AuthedCtx, m: VaultKeyRow) => ({
    id: m.id,
    kind: m.kind,
    label: m.label,
    credentialId: m.credential_id,
    prfSalt: m.prf_salt,
    createdAt: m.created_at,
    lastUsedAt: m.last_used_at,
    thisDevice: m.kind === 'device' && m.device_id !== null && m.device_id === ctx.session.deviceId,
  })

  /** Adds (or, for this phone, replaces) one way for this parent to open the vault. */
  const addMethod = (ctx: AuthedCtx, body: Record<string, unknown>): VaultKeyRow => {
    const kind = body.kind
    const wrapped = blob(body, 'wrapped')
    const now = s.now()
    const id = newId()
    if (kind === 'passkey') {
      const credentialId = blob(body, 'credentialId', 1400)
      const prfSalt = blob(body, 'prfSalt', 100)
      const label = str(body, 'label', { max: 60 })
      const count = (db.prepare('SELECT COUNT(*) AS n FROM vault_keys WHERE user_id = ?').get(ctx.user.id) as { n: number }).n
      if (count >= MAX_METHODS) throw new HttpError(409, 'Remove an old passkey or phone first.', 'too_many')
      db.prepare(
        "INSERT INTO vault_keys (id, kind, user_id, credential_id, prf_salt, label, wrapped, created_at) VALUES (?, 'passkey', ?, ?, ?, ?, ?, ?)",
      ).run(id, ctx.user.id, credentialId, prfSalt, label, wrapped, now)
    } else if (kind === 'device') {
      // Only from the phone itself, signed in with its own key.
      const deviceId = ctx.session.deviceId
      if (!deviceId || ctx.session.transport !== 'bearer') throw new HttpError(403, 'Only a registered phone can do that.', 'forbidden')
      const device = db.prepare('SELECT name FROM devices WHERE id = ? AND user_id = ?').get(deviceId, ctx.user.id) as { name: string } | undefined
      if (!device) throw new HttpError(403, 'Only a registered phone can do that.', 'forbidden')
      db.prepare('DELETE FROM vault_keys WHERE device_id = ?').run(deviceId)
      db.prepare("INSERT INTO vault_keys (id, kind, user_id, device_id, label, wrapped, created_at) VALUES (?, 'device', ?, ?, ?, ?, ?)").run(
        id,
        ctx.user.id,
        deviceId,
        device.name,
        wrapped,
        now,
      )
    } else {
      throw new HttpError(400, 'Choose a passkey or this phone.', 'invalid')
    }
    s.audit('vault.method_added', ctx, ctx.user.id, String(kind))
    return db.prepare('SELECT * FROM vault_keys WHERE id = ?').get(id) as unknown as VaultKeyRow
  }

  api.authed('GET', '/api/vault', parents, (ctx) => {
    const v = vaultInfo()
    const methods = db.prepare('SELECT * FROM vault_keys WHERE user_id = ? ORDER BY created_at').all(ctx.user.id) as unknown as VaultKeyRow[]
    return {
      exists: v !== null,
      check: v?.check ?? null,
      createdAt: v?.createdAt ?? null,
      methods: methods.map((m) => methodInfo(ctx, m)),
    }
  })

  /** Sets the vault up: done once, by the first parent, on a device that made the family key. */
  api.authed('POST', '/api/vault', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const check = blob(body, 'check', 200)
    const recovery = blob(body, 'recoveryWrapped')
    const method = body.method && typeof body.method === 'object' ? (body.method as Record<string, unknown>) : null
    const created = tx(db, () => {
      if (vaultInfo()) throw new HttpError(409, 'The family vault is already set up. Get access from another device instead.', 'vault_exists')
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(VAULT_SETTING, JSON.stringify({ check, createdAt: s.now(), createdBy: ctx.user.id }))
      db.prepare("INSERT INTO vault_keys (id, kind, label, wrapped, created_at) VALUES (?, 'recovery', 'Recovery key', ?, ?)").run(newId(), recovery, s.now())
      return method ? addMethod(ctx, method) : null
    })
    s.audit('vault.created', ctx, ctx.user.id)
    return { method: created ? methodInfo(ctx, created) : null }
  })

  api.authed('POST', '/api/vault/methods', parents, async (ctx) => {
    requireVault()
    const body = await readJson(ctx.req)
    return { method: methodInfo(ctx, tx(db, () => addMethod(ctx, body))) }
  })

  /** One of this parent's wrapped copies, to open the vault on this device. */
  api.authed('GET', '/api/vault/methods/:id', parents, (ctx) => {
    requireVault()
    const m = db.prepare("SELECT * FROM vault_keys WHERE id = ? AND user_id = ? AND kind != 'recovery'").get(ctx.params.id!, ctx.user.id) as
      | VaultKeyRow
      | undefined
    if (!m) throw new HttpError(404, 'That way of opening the vault has been removed.', 'not_found')
    // A phone's copy is only for that phone.
    if (m.kind === 'device' && m.device_id !== ctx.session.deviceId) throw new HttpError(404, 'That way of opening the vault has been removed.', 'not_found')
    db.prepare('UPDATE vault_keys SET last_used_at = ? WHERE id = ?').run(s.now(), m.id)
    s.audit('vault.unlocked', ctx, ctx.user.id, m.kind)
    return { wrapped: m.wrapped }
  })

  api.authed('DELETE', '/api/vault/methods/:id', parents, (ctx) => {
    const result = db.prepare("DELETE FROM vault_keys WHERE id = ? AND user_id = ? AND kind != 'recovery'").run(ctx.params.id!, ctx.user.id)
    if (Number(result.changes) === 0) throw new HttpError(404, 'That way of opening the vault has been removed.', 'not_found')
    s.audit('vault.method_removed', ctx, ctx.user.id)
    return undefined
  })

  /** The recovery copy: needs a fresh authenticator code as well as the recovery key itself. */
  api.authed('POST', '/api/vault/recovery', parents, async (ctx) => {
    requireVault()
    const body = await readJson(ctx.req)
    requireFreshCode(s, ctx, body.code, 'vault.recovery_failed')
    const row = db.prepare("SELECT wrapped FROM vault_keys WHERE kind = 'recovery'").get() as { wrapped: string } | undefined
    if (!row) throw new HttpError(404, 'There is no recovery key for this vault.', 'not_found')
    s.audit('vault.recovery_used', ctx, ctx.user.id)
    return { wrapped: row.wrapped }
  })

  // ---- giving the family key to a new device -------------------------------------

  const livePairing = (id: string) => {
    db.prepare('DELETE FROM vault_pairings WHERE expires_at <= ?').run(s.now())
    return db.prepare('SELECT * FROM vault_pairings WHERE id = ?').get(id) as unknown as PairingRow | undefined
  }

  /** The new device asks: posts a one-time ECDH P-256 public key. */
  api.authed('POST', '/api/vault/pairings', parents, async (ctx) => {
    requireVault()
    const body = await readJson(ctx.req)
    const publicKey = blob(body, 'publicKey', 600)
    try {
      const key = createPublicKey({ key: Buffer.from(publicKey, 'base64url'), format: 'der', type: 'spki' })
      if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('curve')
    } catch {
      throw new HttpError(400, 'That is not a valid pairing key.', 'invalid_key')
    }
    const label = str(body, 'label', { max: 60 })
    db.prepare('DELETE FROM vault_pairings WHERE user_id = ? OR expires_at <= ?').run(ctx.user.id, s.now())
    const code = newPairingCode()
    const id = newId()
    const expiresAt = s.now() + PAIRING_MS
    db.prepare('INSERT INTO vault_pairings (id, code_hash, user_id, public_key, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      id,
      hashToken(normalisePairingCode(code)),
      ctx.user.id,
      publicKey,
      label,
      s.now(),
      expiresAt,
    )
    s.audit('vault.pairing_requested', ctx, ctx.user.id, label)
    return { id, code, expiresAt }
  })

  /** An unlocked parent device looks up the code it was given. */
  api.authed('GET', '/api/vault/pairings/code/:code', parents, (ctx) => {
    if (!s.limits.open.hit(`pairing:${ctx.user.id}`)) throw tooMany()
    db.prepare('DELETE FROM vault_pairings WHERE expires_at <= ?').run(s.now())
    const p = db
      .prepare('SELECT p.*, u.display_name FROM vault_pairings p JOIN users u ON u.id = p.user_id WHERE p.code_hash = ? AND p.approved_by IS NULL')
      .get(hashToken(normalisePairingCode(ctx.params.code!))) as unknown as (PairingRow & { display_name: string }) | undefined
    if (!p) throw new HttpError(404, 'No device is waiting with that code. Check it, or start again on the new device.', 'not_found')
    return { id: p.id, publicKey: p.public_key, label: p.label, requester: p.display_name, expiresAt: p.expires_at }
  })

  /** ...and, once the person has compared the words, sends the family key encrypted to it. */
  api.authed('POST', '/api/vault/pairings/:id/approve', parents, async (ctx) => {
    requireVault()
    const body = await readJson(ctx.req)
    const payload = blob(body, 'payload')
    const p = livePairing(ctx.params.id!)
    if (!p || p.approved_by) throw new HttpError(404, 'That request has expired. Start again on the new device.', 'not_found')
    const requester = db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(p.user_id) as { role: string; disabled: number } | undefined
    if (!requester || requester.role !== 'admin' || requester.disabled) throw new HttpError(403, 'Only a parent can get access to the vault.', 'forbidden')
    db.prepare('UPDATE vault_pairings SET approved_by = ?, payload = ? WHERE id = ?').run(ctx.user.id, payload, p.id)
    s.audit('vault.pairing_approved', ctx, ctx.user.id, p.label)
    s.audit('vault.pairing_approved_for_you', ctx, p.user_id, p.label)
    return undefined
  })

  /** The new device waits for the answer; it is handed over once, then forgotten. */
  api.authed('GET', '/api/vault/pairings/:id', parents, (ctx) => {
    const p = livePairing(ctx.params.id!)
    if (!p || p.user_id !== ctx.user.id) return { status: 'expired' }
    if (!p.payload) return { status: 'pending', expiresAt: p.expires_at }
    db.prepare('DELETE FROM vault_pairings WHERE id = ?').run(p.id)
    return { status: 'approved', payload: p.payload }
  })
}
