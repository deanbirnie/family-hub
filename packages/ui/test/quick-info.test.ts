import { describe, expect, it } from 'vitest'
import { checkSaId, decryptRecord, encryptRecord, mask } from '../src/quickinfo/model.ts'
import { fromB64u, newFamilyKey } from '../src/vault/crypto.ts'

describe('Quick Info records', () => {
  it('encrypt with the family key, bound to their kind and person', async () => {
    const key = newFamilyKey()
    const content = { fields: { idNumber: '8001015009087', fullName: 'Sam Tester' }, documents: [{ id: 'f1', name: 'ID scan.pdf' }] }
    const ciphertext = await encryptRecord(key, 'personal', 'p1', content)
    expect(ciphertext).not.toContain('8001015009087')
    expect(String.fromCharCode(...fromB64u(ciphertext))).not.toContain('8001015009087')
    expect(await decryptRecord(key, { kind: 'personal', profileId: 'p1', ciphertext })).toEqual(content)
    // Moved to another person or another kind, or opened with another key: refused.
    await expect(decryptRecord(key, { kind: 'personal', profileId: 'p2', ciphertext })).rejects.toThrow()
    await expect(decryptRecord(key, { kind: 'passport', profileId: 'p1', ciphertext })).rejects.toThrow()
    await expect(decryptRecord(newFamilyKey(), { kind: 'personal', profileId: 'p1', ciphertext })).rejects.toThrow()
  })

  it('ignores anything malformed inside a record', async () => {
    const key = newFamilyKey()
    const ciphertext = await encryptRecord(key, 'household', null, { fields: { street: '1 Main Rd', bad: 5 as unknown as string }, documents: [{ id: 1 } as unknown as { id: string; name: string }] })
    expect(await decryptRecord(key, { kind: 'household', profileId: null, ciphertext })).toEqual({ fields: { street: '1 Main Rd' }, documents: [] })
  })
})

describe('South African ID numbers', () => {
  const today = new Date('2026-11-22')
  it('accepts valid numbers and reads the date of birth', () => {
    expect(checkSaId('8001015009087', today)).toEqual({ ok: true, dateOfBirth: '1980-01-01' })
    expect(checkSaId('800101 5009 087', today)).toEqual({ ok: true, dateOfBirth: '1980-01-01' })
    expect(checkSaId('1501014800086', today)).toEqual({ ok: true, dateOfBirth: '2015-01-01' })
  })

  it('refuses typos, wrong lengths and impossible dates', () => {
    expect(checkSaId('8001015009088', today)).toMatchObject({ ok: false, problem: expect.stringMatching(/check digit/) })
    expect(checkSaId('800101500908', today)).toMatchObject({ ok: false, problem: expect.stringMatching(/13 digits/) })
    // A valid check digit, but 30 February.
    expect(checkSaId('8002305009084', today)).toMatchObject({ ok: false, problem: expect.stringMatching(/real date/) })
  })

  it('masks sensitive values without giving away their length exactly', () => {
    expect(mask('12')).toBe('••••••')
    expect(mask('')).toBe('')
  })
})
