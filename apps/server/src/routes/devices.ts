/**
 * Phones sign in with biometrics, enforced by the server rather than only by
 * the app:
 *
 * 1. After a password and an authenticator code on the phone, the app makes
 *    an ECDSA P-256 key pair inside Android's hardware keystore. The keystore
 *    only lets the private key sign straight after a fingerprint or face
 *    check, and destroys it if a new fingerprint or face is enrolled. The app
 *    registers the public key here.
 * 2. To unlock, the app asks for a one-time challenge, the person touches the
 *    sensor, the keystore signs the challenge, and this server checks the
 *    signature before issuing a short session.
 *
 * So a full session on a phone always means "this registered phone, and a
 * biometric check on it just now". The private key never leaves the phone.
 */
import { createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto'
import type { Api, Services } from '../app.ts'
import { HttpError, readJson, str } from '../http.ts'
import { newId } from '../secrets.ts'
import { deleteSession, getUser } from '../sessions.ts'
import { issue, publicUser, tooMany } from './auth.ts'

const CHALLENGE_MS = 2 * 60_000
const MAX_DEVICES = 10

/** What the phone signs: fixed context, the challenge and the device id, so a signature is useless anywhere else. */
export const unlockMessage = (challenge: string, deviceId: string) => Buffer.from(`family-hub-device-unlock\n${challenge}\n${deviceId}`, 'utf8')

function parsePublicKey(base64: string): KeyObject {
  let key: KeyObject
  try {
    key = createPublicKey({ key: Buffer.from(base64, 'base64'), format: 'der', type: 'spki' })
  } catch {
    throw new HttpError(400, 'That is not a valid public key.', 'invalid_key')
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new HttpError(400, 'The device key must be ECDSA P-256.', 'invalid_key')
  }
  return key
}

export function deviceRoutes(api: Api, services: Services): void {
  const { db } = services

  /** Only from a phone that has just passed password and code (stage 'device'). */
  api.authed('POST', '/api/devices', { stages: ['device'] }, async (ctx) => {
    if (ctx.session.transport !== 'bearer') throw new HttpError(403, 'Only the app registers devices.', 'forbidden')
    const body = await readJson(ctx.req)
    const name = str(body, 'name', { max: 60 })
    const publicKey = str(body, 'publicKey', { max: 400 })
    parsePublicKey(publicKey)
    const count = (db.prepare('SELECT COUNT(*) AS n FROM devices WHERE user_id = ?').get(ctx.user.id) as { n: number }).n
    if (count >= MAX_DEVICES) {
      throw new HttpError(409, `You have ${MAX_DEVICES} phones registered. Remove one in Settings → Security first.`, 'too_many_devices')
    }
    const id = newId()
    db.prepare('INSERT INTO devices (id, user_id, name, public_key, created_at) VALUES (?, ?, ?, ?, ?)').run(
      id,
      ctx.user.id,
      name,
      publicKey,
      services.now(),
    )
    // That session was only for this; the phone now unlocks with its key.
    deleteSession(db, ctx.session.id)
    services.audit('device.added', ctx, ctx.user.id, name)
    return { deviceId: id }
  })

  api.open('POST', '/api/devices/challenge', async (ctx) => {
    if (!services.limits.signIn.hit(`ip:${ctx.ip}`)) throw tooMany()
    const body = await readJson(ctx.req)
    const deviceId = str(body, 'deviceId', { max: 40 })
    const device = db.prepare('SELECT id FROM devices WHERE id = ?').get(deviceId)
    // Same answer shape whether or not the device exists would only hide what
    // the id itself (random, private to the phone) already hides; be explicit
    // so a removed phone can tell its person why.
    if (!device) throw new HttpError(404, 'This phone is no longer registered. Sign in again.', 'device_removed')
    const id = newId()
    const challenge = randomBytes(32).toString('base64url')
    db.prepare('INSERT INTO device_challenges (id, device_id, challenge, expires_at) VALUES (?, ?, ?, ?)').run(
      id,
      deviceId,
      challenge,
      services.now() + CHALLENGE_MS,
    )
    return { challengeId: id, challenge }
  })

  api.open('POST', '/api/devices/unlock', async (ctx) => {
    if (!services.limits.signIn.hit(`ip:${ctx.ip}`)) throw tooMany()
    const body = await readJson(ctx.req)
    const deviceId = str(body, 'deviceId', { max: 40 })
    const challengeId = str(body, 'challengeId', { max: 40 })
    const signature = str(body, 'signature', { max: 200 })
    // Each challenge is used once, whether or not the signature is right.
    const challenge = db
      .prepare('DELETE FROM device_challenges WHERE id = ? AND device_id = ? AND expires_at > ? RETURNING challenge')
      .get(challengeId, deviceId, services.now()) as { challenge: string } | undefined
    const device = db.prepare('SELECT id, user_id, public_key FROM devices WHERE id = ?').get(deviceId) as
      | { id: string; user_id: string; public_key: string }
      | undefined
    if (!challenge || !device) throw new HttpError(401, 'Unlock again.', 'bad_challenge')
    const ok = verify(
      'sha256',
      unlockMessage(challenge.challenge, deviceId),
      { key: parsePublicKey(device.public_key), dsaEncoding: 'der' },
      Buffer.from(signature, 'base64'),
    )
    if (!ok) {
      services.audit('device.unlock_failed', ctx, device.user_id)
      throw new HttpError(401, 'Unlock again.', 'bad_signature')
    }
    const user = getUser(db, device.user_id)
    if (!user || user.disabled) throw new HttpError(401, 'This account is turned off.', 'disabled')
    db.prepare('UPDATE devices SET last_used_at = ? WHERE id = ?').run(services.now(), deviceId)
    services.audit('device.unlocked', ctx, user.id)
    return { ...issue(services, ctx, user.id, 'full', 'bearer', deviceId), user: publicUser(user) }
  })
}
