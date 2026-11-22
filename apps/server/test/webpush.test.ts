import { createECDH, verify } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptAsReceiver } from './push-receiver.ts'
import { encryptPayload, generateVapidKeys, validEndpoint, validPushKeys, vapidAuthorization, vapidPublicKeyObject } from '../src/webpush.ts'

const b = (s: string) => Buffer.from(s, 'base64url')

// RFC 8291, section 5 (and Appendix A): "Push Message Encryption Example".
const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  message:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

describe('Web Push encryption (RFC 8291)', () => {
  it('produces exactly the RFC example message', () => {
    const out = encryptPayload({ p256dh: RFC.uaPublic, auth: RFC.auth }, b(RFC.plaintext), { senderPrivate: b(RFC.asPrivate), salt: b(RFC.salt) })
    expect(out.toString('base64url')).toBe(RFC.message)
  })

  it('round-trips with random keys, and only the receiver can read it', () => {
    const ua = createECDH('prime256v1')
    ua.generateKeys()
    const auth = Buffer.alloc(16, 7)
    const keys = { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
    const out = encryptPayload(keys, Buffer.from('{"title":"Family Hub"}'))
    expect(decryptAsReceiver(out, ua.getPrivateKey(), auth).toString()).toBe('{"title":"Family Hub"}')
    expect(() => decryptAsReceiver(out, ua.getPrivateKey(), Buffer.alloc(16, 8))).toThrow()
  })

  it('checks receiver keys', () => {
    expect(validPushKeys({ p256dh: RFC.uaPublic, auth: RFC.auth })).toBe(true)
    expect(validPushKeys({ p256dh: RFC.uaPublic, auth: 'short' })).toBe(false)
    // Right length, but not a point on the curve.
    expect(validPushKeys({ p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url'), auth: RFC.auth })).toBe(false)
  })
})

describe('VAPID (RFC 8292)', () => {
  it('signs a token for the push service origin that verifies with the public key', () => {
    const vapid = generateVapidKeys()
    const now = Date.UTC(2026, 10, 20)
    const header = vapidAuthorization('https://ntfy.sh/upAbc123?up=1', vapid, 'https://hub.example.com', now)
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!
    expect(m[4]).toBe(vapid.publicKey)
    const claims = JSON.parse(b(m[2]!).toString()) as { aud: string; exp: number; sub: string }
    expect(claims).toEqual({ aud: 'https://ntfy.sh', exp: now / 1000 + 12 * 3600, sub: 'https://hub.example.com' })
    const ok = verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key: vapidPublicKeyObject(vapid.publicKey), dsaEncoding: 'ieee-p1363' }, b(m[3]!))
    expect(ok).toBe(true)
  })
})

describe('push addresses', () => {
  it('accepts https only, without credentials', () => {
    expect(validEndpoint('https://fcm.googleapis.com/fcm/send/abc', false)).toBe(true)
    expect(validEndpoint('https://ntfy.home.lan/upXYZ?up=1', false)).toBe(true)
    expect(validEndpoint('http://ntfy.home.lan/upXYZ', false)).toBe(false)
    expect(validEndpoint('https://user:pw@ntfy.sh/x', false)).toBe(false)
    expect(validEndpoint('file:///etc/passwd', true)).toBe(false)
    expect(validEndpoint(`https://x.example/${'a'.repeat(1100)}`, false)).toBe(false)
  })
})
