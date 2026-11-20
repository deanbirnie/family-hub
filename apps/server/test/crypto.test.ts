import { describe, expect, it } from 'vitest'
import { hashPassword, needsRehash, passwordProblem, verifyPassword } from '../src/secrets.ts'
import { base32Decode, base32Encode, checkTotp, hotp, newRecoveryCodes, newTotpSecret, normaliseRecoveryCode, otpauthUrl, totpAt } from '../src/totp.ts'

const FAST = { memory: 1024, passes: 1, parallelism: 1 }

describe('passwords', () => {
  it('hashes with Argon2id and verifies', async () => {
    const hash = await hashPassword('a long enough password', FAST)
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=1024,t=1,p=1\$/)
    expect(await verifyPassword('a long enough password', hash)).toBe(true)
    expect(await verifyPassword('a long enough passworD', hash)).toBe(false)
  })

  it('refuses hashes it cannot trust', async () => {
    expect(await verifyPassword('x', 'plain text')).toBe(false)
    // Absurd memory settings in a tampered row are not attempted.
    expect(await verifyPassword('x', '$argon2id$v=19$m=99999999,t=1,p=1$c2FsdHNhbHQ$aGFzaA')).toBe(false)
  })

  it('knows when a hash should be redone with current settings', async () => {
    const hash = await hashPassword('a long enough password', FAST)
    expect(needsRehash(hash, FAST)).toBe(false)
    expect(needsRehash(hash)).toBe(true)
  })

  it('asks for long passwords and nothing arbitrary', () => {
    expect(passwordProblem('short')).toMatch(/12 characters/)
    expect(passwordProblem('aaaaaaaaaaaaaaaa')).toMatch(/easy/)
    expect(passwordProblem('dean-is-the-best-dad', 'dean')).toMatch(/username/)
    expect(passwordProblem('four random words here')).toBeNull()
    expect(passwordProblem(undefined)).toMatch(/Enter/)
  })
})

describe('TOTP (RFC 6238)', () => {
  // The RFC's SHA-1 test secret, "12345678901234567890".
  const secret = base32Encode(Buffer.from('12345678901234567890'))

  it('matches the RFC test vectors (last 6 digits)', () => {
    expect(totpAt(secret, 59_000)).toBe('287082')
    expect(totpAt(secret, 1111111109_000)).toBe('081804')
    expect(totpAt(secret, 1111111111_000)).toBe('050471')
    expect(totpAt(secret, 1234567890_000)).toBe('005924')
    expect(totpAt(secret, 2000000000_000)).toBe('279037')
  })

  it('matches RFC 4226 HOTP vectors', () => {
    const key = Buffer.from('12345678901234567890')
    expect([0, 1, 2, 9].map((c) => hotp(key, c))).toEqual(['755224', '287082', '359152', '520489'])
  })

  it('round-trips base32', () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 255))
      expect(base32Decode(base32Encode(bytes))).toEqual(bytes)
    }
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/)
  })

  it('accepts one step of clock drift either way, and each code only once', () => {
    const s = newTotpSecret()
    const now = 1_800_000_000_000
    const code = totpAt(s, now)
    const counter = checkTotp(s, code, null, now)
    expect(counter).not.toBeNull()
    expect(checkTotp(s, code, counter, now)).toBeNull()
    expect(checkTotp(s, totpAt(s, now - 30_000), null, now)).not.toBeNull()
    expect(checkTotp(s, totpAt(s, now + 30_000), null, now)).not.toBeNull()
    expect(checkTotp(s, totpAt(s, now - 90_000), null, now)).toBeNull()
    expect(checkTotp(s, '12345', null, now)).toBeNull()
    expect(checkTotp(s, 123456, null, now)).toBeNull()
    expect(checkTotp(s, `${code.slice(0, 3)} ${code.slice(3)}`, null, now)).not.toBeNull()
  })

  it('makes an otpauth link authenticator apps read', () => {
    const url = new URL(otpauthUrl('ABC', 'parent', 'Family Hub'))
    expect(url.protocol).toBe('otpauth:')
    expect(url.searchParams.get('secret')).toBe('ABC')
    expect(url.searchParams.get('issuer')).toBe('Family Hub')
  })

  it('makes distinct, readable recovery codes', () => {
    const codes = newRecoveryCodes()
    expect(codes).toHaveLength(10)
    expect(new Set(codes).size).toBe(10)
    for (const c of codes) expect(c).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}$/)
    expect(normaliseRecoveryCode(' ABCDE-fghjk ')).toBe('abcdefghjk')
  })
})
