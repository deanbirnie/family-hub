/**
 * Opening the vault in a browser with a passkey (Windows Hello, Touch ID, a
 * phone or a security key), through the WebAuthn PRF extension: the passkey
 * turns a stored salt into a secret that only it can produce, and that secret
 * unwraps the family key. The server is not involved in the passkey check;
 * it only stores the credential ID, salt and wrapped key, none of which open
 * anything on their own.
 */
import { fromB64u, randomBytes, toB64u, VaultCryptoError } from './crypto.ts'

export const passkeysAvailable = () => typeof window !== 'undefined' && 'PublicKeyCredential' in window && !!navigator.credentials

interface PrfResults {
  enabled?: boolean
  results?: { first?: ArrayBuffer }
}

const prfOf = (cred: PublicKeyCredential) => (cred.getClientExtensionResults() as { prf?: PrfResults }).prf

/** Creates a passkey for the vault and returns its PRF output for a new salt. */
export async function createVaultPasskey(user: { username: string; displayName: string }, familyName: string): Promise<{ credentialId: string; prfSalt: string; prfOutput: Uint8Array }> {
  const salt = randomBytes(32)
  const cred = (await navigator.credentials.create({
    publicKey: {
      challenge: randomBytes(32) as BufferSource,
      rp: { name: `Family Hub (${familyName})`, id: location.hostname },
      user: { id: randomBytes(16) as BufferSource, name: `${user.username} · family vault`, displayName: `${user.displayName} (family vault)` },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
      timeout: 120_000,
      extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new VaultCryptoError('No passkey was created.')
  const credentialId = toB64u(new Uint8Array(cred.rawId))
  const prf = prfOf(cred)
  if (prf?.enabled === false) {
    throw new VaultCryptoError('This passkey cannot protect the vault (it does not support the PRF extension). Try another, or use your phone instead.')
  }
  const first = prf?.results?.first
  const prfOutput = first ? new Uint8Array(first) : (await passkeyPrf([{ credentialId, prfSalt: toB64u(salt) }])).prfOutput
  return { credentialId, prfSalt: toB64u(salt), prfOutput }
}

/** Asks for one of these passkeys and returns which one answered, with its PRF output. */
export async function passkeyPrf(options: { credentialId: string; prfSalt: string }[]): Promise<{ credentialId: string; prfOutput: Uint8Array }> {
  if (!options.length) throw new VaultCryptoError('No passkey has been added for the vault.')
  const evalByCredential: Record<string, { first: BufferSource }> = {}
  for (const o of options) evalByCredential[o.credentialId] = { first: fromB64u(o.prfSalt) as BufferSource }
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: randomBytes(32) as BufferSource,
      rpId: location.hostname,
      allowCredentials: options.map((o) => ({ type: 'public-key' as const, id: fromB64u(o.credentialId) as BufferSource })),
      userVerification: 'required',
      timeout: 120_000,
      extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null
  if (!cred) throw new VaultCryptoError('The passkey was not used.')
  const first = prfOf(cred)?.results?.first
  if (!first) throw new VaultCryptoError('This passkey cannot open the vault (no PRF support). Use another way in.')
  return { credentialId: toB64u(new Uint8Array(cred.rawId)), prfOutput: new Uint8Array(first) }
}
