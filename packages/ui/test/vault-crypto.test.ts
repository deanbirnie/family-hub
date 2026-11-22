import { describe, expect, it } from 'vitest'
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
  wrapFamilyKey,
} from '../src/vault/crypto.ts'
import { VaultStore } from '../src/vault/store.ts'
import { WORDS } from '../src/vault/words.ts'

describe('family key', () => {
  it('wraps and unwraps per way of opening, and nothing else opens it', async () => {
    const familyKey = newFamilyKey()
    const recovery = randomBytes(32)
    const wrapped = await wrapFamilyKey(recovery, familyKey, 'recovery')
    expect(await unwrapFamilyKey(recovery, wrapped, 'recovery')).toEqual(familyKey)
    await expect(unwrapFamilyKey(randomBytes(32), wrapped, 'recovery')).rejects.toThrow(/does not open/)
    // A wrapped copy cannot be passed off as another kind.
    await expect(unwrapFamilyKey(recovery, wrapped, 'passkey')).rejects.toThrow()
    const tampered = wrapped.slice(0, -2) + (wrapped.endsWith('A') ? 'B' : 'A') + wrapped.slice(-1)
    await expect(unwrapFamilyKey(recovery, tampered, 'recovery')).rejects.toThrow()
  })

  it('checks it holds the right family key', async () => {
    const familyKey = newFamilyKey()
    const check = await makeCheck(familyKey)
    expect(await verifyCheck(familyKey, check)).toBe(true)
    expect(await verifyCheck(newFamilyKey(), check)).toBe(false)
  })

  it('derives a passkey wrapping key from the PRF output, the same every time', async () => {
    const prf = randomBytes(32)
    expect(await passkeyWrappingKey(prf)).toEqual(await passkeyWrappingKey(prf))
    expect(await passkeyWrappingKey(prf)).not.toEqual(prf)
  })
})

describe('recovery key', () => {
  it('round-trips through the written form, forgiving case, spaces and dashes', () => {
    const bytes = randomBytes(32)
    const text = formatRecoveryKey(bytes)
    expect(text).toMatch(/^FH1-([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/)
    expect(parseRecoveryKey(text)).toEqual(bytes)
    expect(parseRecoveryKey(` ${text.toLowerCase().replace(/-/g, ' ')} `)).toEqual(bytes)
  })

  it('refuses something that is not a whole recovery key', () => {
    const text = formatRecoveryKey(randomBytes(32))
    expect(() => parseRecoveryKey(text.slice(0, -5))).toThrow(/not complete/)
    expect(() => parseRecoveryKey('FH1-0000-1111')).toThrow(/not a recovery key/)
  })
})

describe('pairing a new device', () => {
  it('gets the family key to the new device, and only to it', async () => {
    const familyKey = newFamilyKey()
    const newDevice = await newPairingKeys()
    const payload = await sealForNewDevice(familyKey, newDevice.publicKey, 'pairing-1')
    expect(await openFromApproval(newDevice, payload, 'pairing-1')).toEqual(familyKey)
    // Another device, or the same payload for another request, gets nothing.
    await expect(openFromApproval(await newPairingKeys(), payload, 'pairing-1')).rejects.toThrow()
    await expect(openFromApproval(newDevice, payload, 'pairing-2')).rejects.toThrow()
    await expect(openFromApproval(newDevice, 'bm90IGpzb24', 'pairing-1')).rejects.toThrow(/damaged/)
  })

  it('shows six check words, different for a swapped key', async () => {
    const a = await newPairingKeys()
    const b = await newPairingKeys()
    const words = await checkWords(a.publicKey)
    expect(words).toHaveLength(6)
    for (const w of words) expect(WORDS).toContain(w)
    expect(await checkWords(a.publicKey)).toEqual(words)
    expect(await checkWords(b.publicKey)).not.toEqual(words)
  })

  it('has 256 distinct words', () => {
    expect(new Set(WORDS).size).toBe(256)
  })
})

describe('the unlocked vault in memory', () => {
  it('locks after the idle time, and use keeps it open', async () => {
    const store = new VaultStore(40)
    const key = newFamilyKey()
    store.unlock(key)
    await new Promise((r) => setTimeout(r, 25))
    expect(store.use()).not.toBeNull()
    await new Promise((r) => setTimeout(r, 25))
    expect(store.unlocked).toBe(true)
    await new Promise((r) => setTimeout(r, 60))
    expect(store.unlocked).toBe(false)
    expect(key.every((b) => b === 0)).toBe(true)
  })
})
