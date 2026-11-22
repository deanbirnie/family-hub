import { generateKeyPairSync, sign } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { unlockMessage } from '../src/routes/devices.ts'
import { totpAt } from '../src/totp.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

// The server never sees keys, only opaque base64url blobs; any will do here.
const blob = (tag: string) => Buffer.from(`ciphertext-${tag}`).toString('base64url')
const pairingKey = () => generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')

async function addParent(admin: Client, username: string) {
  const invite = await admin.post<{ token: string }>('/api/invites', { displayName: username, role: 'admin' })
  const client = new Client(server.url)
  await client.post(`/api/invites/redeem/${invite.body.token}`, { username, displayName: username, password: PASSWORD })
  nextStep(server)
  const { secret } = await enrollTotp(server, client)
  return { client, secret }
}

async function addMember(admin: Client, username: string) {
  const invite = await admin.post<{ token: string }>('/api/invites', { displayName: username })
  const client = new Client(server.url)
  await client.post(`/api/invites/redeem/${invite.body.token}`, { username, displayName: username, password: PASSWORD })
  nextStep(server)
  await enrollTotp(server, client)
  return client
}

const createVault = (client: Client, method?: Record<string, unknown>) =>
  client.post('/api/vault', { check: blob('check'), recoveryWrapped: blob('recovery'), method })

describe('the family vault', () => {
  it('is set up once, by a parent, and keeps only wrapped copies', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    expect((await client.get('/api/vault')).body).toMatchObject({ exists: false })
    const passkey = { kind: 'passkey', credentialId: blob('cred'), prfSalt: blob('salt'), label: 'Laptop', wrapped: blob('passkey') }
    expect((await createVault(client, passkey)).status).toBe(200)
    expect((await createVault(client)).body).toMatchObject({ error: 'vault_exists' })

    const status = await client.get<{ exists: boolean; check: string; methods: { id: string; kind: string; credentialId: string }[] }>('/api/vault')
    expect(status.body).toMatchObject({ exists: true, check: blob('check') })
    expect(status.body.methods).toEqual([expect.objectContaining({ kind: 'passkey', credentialId: blob('cred') })])
    expect((await client.get(`/api/vault/methods/${status.body.methods[0]!.id}`)).body).toEqual({ wrapped: blob('passkey') })
    const events = (await client.get<{ events: { event: string }[] }>('/api/account/activity')).body.events.map((e) => e.event)
    expect(events).toEqual(expect.arrayContaining(['vault.created', 'vault.unlocked']))
  })

  it('is closed to members', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    await createVault(client)
    const kid = await addMember(client, 'kid')
    for (const res of [await kid.get('/api/vault'), await kid.post('/api/vault/pairings', { publicKey: pairingKey(), label: 'X' }), await kid.post('/api/vault/recovery', { code: '000000' })]) {
      expect(res.status).toBe(403)
    }
  })

  it('gives each wrapped copy only to its owner', async () => {
    server = await startServer()
    const { client: alex } = await setUpAdmin(server)
    await createVault(alex, { kind: 'passkey', credentialId: blob('c'), prfSalt: blob('s'), label: 'Laptop', wrapped: blob('w') })
    const id = (await alex.get<{ methods: { id: string }[] }>('/api/vault')).body.methods[0]!.id
    const { client: sam } = await addParent(alex, 'sam')
    expect((await sam.get<{ methods: unknown[] }>('/api/vault')).body.methods).toEqual([])
    expect((await sam.get(`/api/vault/methods/${id}`)).status).toBe(404)
    expect((await sam.del(`/api/vault/methods/${id}`)).status).toBe(404)
  })

  it('needs a fresh authenticator code for the recovery copy', async () => {
    server = await startServer()
    const { client, secret } = await setUpAdmin(server)
    await createVault(client)
    expect((await client.post('/api/vault/recovery', { code: '000000' })).body).toMatchObject({ error: 'bad_code' })
    nextStep(server)
    const code = totpAt(secret, server.clock.now)
    expect((await client.post('/api/vault/recovery', { code })).body).toEqual({ wrapped: blob('recovery') })
    expect((await client.post('/api/vault/recovery', { code })).body).toMatchObject({ error: 'bad_code' })
  })

  it('relays a pairing between two parents once, then forgets it', async () => {
    server = await startServer()
    const { client: alex } = await setUpAdmin(server)
    await createVault(alex)
    const { client: sam } = await addParent(alex, 'sam')
    const publicKey = pairingKey()
    const req = await sam.post<{ id: string; code: string }>('/api/vault/pairings', { publicKey, label: 'Sam’s phone' })
    expect(req.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect((await sam.get(`/api/vault/pairings/${req.body.id}`)).body).toMatchObject({ status: 'pending' })

    // Alex looks the code up (case and dash do not matter) and sees Sam's public key.
    const found = await alex.get<{ id: string; publicKey: string; requester: string }>(`/api/vault/pairings/code/${req.body.code.toLowerCase().replace('-', '')}`)
    expect(found.body).toMatchObject({ id: req.body.id, publicKey, requester: 'sam' })
    expect((await alex.post(`/api/vault/pairings/${req.body.id}/approve`, { payload: blob('for-sam') })).status).toBe(204)
    // Only the requester gets the answer, and only once.
    expect((await alex.get(`/api/vault/pairings/${req.body.id}`)).body).toMatchObject({ status: 'expired' })
    expect((await sam.get(`/api/vault/pairings/${req.body.id}`)).body).toEqual({ status: 'approved', payload: blob('for-sam') })
    expect((await sam.get(`/api/vault/pairings/${req.body.id}`)).body).toMatchObject({ status: 'expired' })
    expect((await alex.get(`/api/vault/pairings/code/${req.body.code}`)).status).toBe(404)
  })

  it('expires pairing requests, and refuses keys that are not P-256', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    await createVault(client)
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64url')
    expect((await client.post('/api/vault/pairings', { publicKey: rsa, label: 'X' })).body).toMatchObject({ error: 'invalid_key' })
    const req = await client.post<{ id: string; code: string }>('/api/vault/pairings', { publicKey: pairingKey(), label: 'Laptop' })
    server.clock.now += 11 * 60_000
    expect((await client.get(`/api/vault/pairings/code/${req.body.code}`)).status).toBe(404)
    expect((await client.get(`/api/vault/pairings/${req.body.id}`)).body).toMatchObject({ status: 'expired' })
  })

  it('lets a phone store its own copy, for that phone only, and removes it with the phone', async () => {
    server = await startServer()
    const { client: alex, secret } = await setUpAdmin(server)
    await createVault(alex)
    // A browser cannot store a phone copy.
    expect((await alex.post('/api/vault/methods', { kind: 'device', wrapped: blob('d') })).status).toBe(403)

    const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const phone = new Client(server.url, { origin: 'https://localhost' })
    await phone.post('/api/auth/login', { username: 'parent', password: PASSWORD, client: 'app' })
    nextStep(server)
    await phone.post('/api/auth/totp', { code: totpAt(secret, server.clock.now) })
    const { deviceId } = (await phone.post<{ deviceId: string }>('/api/devices', { name: 'Pixel', publicKey: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })).body
    const c = await phone.post<{ challengeId: string; challenge: string }>('/api/devices/challenge', { deviceId })
    await phone.post('/api/devices/unlock', { deviceId, challengeId: c.body.challengeId, signature: sign('sha256', unlockMessage(c.body.challenge, deviceId), { key: keys.privateKey, dsaEncoding: 'der' }).toString('base64') })

    expect((await phone.post('/api/vault/methods', { kind: 'device', wrapped: blob('phone') })).status).toBe(200)
    const methods = (await phone.get<{ methods: { id: string; thisDevice: boolean }[] }>('/api/vault')).body.methods
    expect(methods).toEqual([expect.objectContaining({ thisDevice: true })])
    expect((await phone.get(`/api/vault/methods/${methods[0]!.id}`)).body).toEqual({ wrapped: blob('phone') })
    // The same person in a browser cannot fetch the phone's copy.
    expect((await alex.get(`/api/vault/methods/${methods[0]!.id}`)).status).toBe(404)
    await alex.del(`/api/account/devices/${deviceId}`)
    expect((await alex.get<{ methods: unknown[] }>('/api/vault')).body.methods).toEqual([])
  })

  it('takes vault access away from a parent who becomes a member', async () => {
    server = await startServer()
    const { client: alex } = await setUpAdmin(server)
    await createVault(alex)
    const { client: sam } = await addParent(alex, 'sam')
    await sam.post('/api/vault/methods', { kind: 'passkey', credentialId: blob('c'), prfSalt: blob('s'), label: 'Sam laptop', wrapped: blob('w') })
    const samId = (await alex.get<{ members: { id: string; username: string }[] }>('/api/members')).body.members.find((m) => m.username === 'sam')!.id
    await alex.patch(`/api/members/${samId}`, { role: 'member' })
    const left = server.services.db.prepare('SELECT COUNT(*) AS n FROM vault_keys WHERE user_id = ?').get(samId) as { n: number }
    expect(left.n).toBe(0)
  })
})
