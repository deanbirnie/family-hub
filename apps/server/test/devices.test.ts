import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { unlockMessage } from '../src/routes/devices.ts'
import { totpAt } from '../src/totp.ts'
import { Client, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

/** Plays the phone: its keystore key pair, and the app's bearer-token client. */
function phone() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return {
    client: new Client(server.url, { origin: 'https://localhost' }),
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey,
  }
}

async function unlock(client: Client, deviceId: string, key: KeyObject) {
  const c = await client.post<{ challengeId: string; challenge: string }>('/api/devices/challenge', { deviceId })
  const signature = sign('sha256', unlockMessage(c.body.challenge, deviceId), { key, dsaEncoding: 'der' }).toString('base64')
  return client.post('/api/devices/unlock', { deviceId, challengeId: c.body.challengeId, signature })
}

async function registerPhone(secret: string) {
  const p = phone()
  const login = await p.client.post('/api/auth/login', { username: 'parent', password: PASSWORD, client: 'app' })
  expect(login.body).toMatchObject({ stage: 'totp' })
  expect(login.headers.getSetCookie()).toHaveLength(0)
  nextStep(server)
  const code = await p.client.post('/api/auth/totp', { code: totpAt(secret, server.clock.now) })
  expect(code.body).toMatchObject({ stage: 'device' })
  const added = await p.client.post<{ deviceId: string }>('/api/devices', { name: 'Pixel', publicKey: p.publicKey })
  expect(added.status).toBe(200)
  return { ...p, deviceId: added.body.deviceId }
}

describe('phone sign-in with a biometric-bound key', () => {
  it('after password and code, the app can only register its key; then it unlocks by signing a challenge', async () => {
    server = await startServer()
    const { secret } = await setUpAdmin(server)
    const p = phone()
    await p.client.post('/api/auth/login', { username: 'parent', password: PASSWORD, client: 'app' })
    nextStep(server)
    await p.client.post('/api/auth/totp', { code: totpAt(secret, server.clock.now) })
    // Password and code are not enough to use the app.
    expect((await p.client.get('/api/members')).body).toMatchObject({ error: 'stage_device' })

    const added = await p.client.post<{ deviceId: string }>('/api/devices', { name: 'Pixel', publicKey: p.publicKey })
    // The registration session is used up.
    expect((await p.client.get('/api/auth/session')).status).toBe(401)

    const unlocked = await unlock(p.client, added.body.deviceId, p.privateKey)
    expect(unlocked.body).toMatchObject({ stage: 'full', user: { username: 'parent' } })
    expect((await p.client.get('/api/members')).status).toBe(200)
    const devices = await p.client.get<{ devices: { current: boolean }[] }>('/api/account/devices')
    expect(devices.body.devices).toEqual([expect.objectContaining({ name: 'Pixel', current: true })])
  })

  it('refuses a signature from another key, and a challenge used twice', async () => {
    server = await startServer()
    const { secret } = await setUpAdmin(server)
    const p = await registerPhone(secret)
    const stranger = phone()
    expect((await unlock(p.client, p.deviceId, stranger.privateKey)).status).toBe(401)

    const c = await p.client.post<{ challengeId: string; challenge: string }>('/api/devices/challenge', { deviceId: p.deviceId })
    const signature = sign('sha256', unlockMessage(c.body.challenge, p.deviceId), { key: p.privateKey, dsaEncoding: 'der' }).toString('base64')
    const body = { deviceId: p.deviceId, challengeId: c.body.challengeId, signature }
    expect((await p.client.post('/api/devices/unlock', body)).status).toBe(200)
    expect((await new Client(server.url).post('/api/devices/unlock', body)).status).toBe(401)
  })

  it('refuses an expired challenge', async () => {
    server = await startServer()
    const { secret } = await setUpAdmin(server)
    const p = await registerPhone(secret)
    const c = await p.client.post<{ challengeId: string; challenge: string }>('/api/devices/challenge', { deviceId: p.deviceId })
    server.clock.now += 3 * 60_000
    const signature = sign('sha256', unlockMessage(c.body.challenge, p.deviceId), { key: p.privateKey, dsaEncoding: 'der' }).toString('base64')
    expect((await p.client.post('/api/devices/unlock', { deviceId: p.deviceId, challengeId: c.body.challengeId, signature })).status).toBe(401)
  })

  it('only accepts P-256 keys', async () => {
    server = await startServer()
    const { secret } = await setUpAdmin(server)
    const p = phone()
    await p.client.post('/api/auth/login', { username: 'parent', password: PASSWORD, client: 'app' })
    nextStep(server)
    await p.client.post('/api/auth/totp', { code: totpAt(secret, server.clock.now) })
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    expect((await p.client.post('/api/devices', { name: 'X', publicKey: rsa })).body).toMatchObject({ error: 'invalid_key' })
    expect((await p.client.post('/api/devices', { name: 'X', publicKey: 'nonsense' })).body).toMatchObject({ error: 'invalid_key' })
  })

  it('a browser session cannot register a device, and an app token does not work as a cookie', async () => {
    server = await startServer()
    const { client, secret } = await setUpAdmin(server)
    expect((await client.post('/api/devices', { name: 'X', publicKey: phone().publicKey })).status).toBe(403)

    const p = await registerPhone(secret)
    await unlock(p.client, p.deviceId, p.privateKey)
    const asCookie = new Client(server.url)
    asCookie.cookie = `__Host-fh_session=${p.client.token}`
    expect((await asCookie.get('/api/account')).status).toBe(401)
  })

  it('removing the phone signs it out and stops it unlocking', async () => {
    server = await startServer()
    const { client, secret } = await setUpAdmin(server)
    const p = await registerPhone(secret)
    await unlock(p.client, p.deviceId, p.privateKey)
    expect((await client.del(`/api/account/devices/${p.deviceId}`)).status).toBe(204)
    expect((await p.client.get('/api/account')).status).toBe(401)
    expect((await p.client.post('/api/devices/challenge', { deviceId: p.deviceId })).body).toMatchObject({ error: 'device_removed' })
  })

  it('a phone session lasts a working day at most', async () => {
    server = await startServer()
    const { secret } = await setUpAdmin(server)
    const p = await registerPhone(secret)
    await unlock(p.client, p.deviceId, p.privateKey)
    for (let i = 0; i < 7; i++) {
      server.clock.now += 100 * 60_000
      expect((await p.client.get('/api/account')).status).toBe(200)
    }
    server.clock.now += 100 * 60_000
    expect((await p.client.get('/api/account')).status).toBe(401)
  })
})
