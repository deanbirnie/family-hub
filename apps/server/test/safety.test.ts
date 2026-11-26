import { createECDH } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanCheckin } from '../src/routes/safety.ts'
import type { PushFetch } from '../src/webpush.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'
import { decryptAsReceiver } from './push-receiver.ts'

let server: TestServer
afterEach(async () => server?.close())

function fakeBrowser() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = Buffer.alloc(16, 3)
  const endpoint = `https://push.example.com/send/${Math.random().toString(36).slice(2)}`
  return {
    endpoint,
    subscription: { kind: 'webpush', endpoint, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') }, label: 'Test browser' },
    read: (body: Buffer) => JSON.parse(decryptAsReceiver(body, ecdh.getPrivateKey(), auth).toString()) as { body: string; url: string },
  }
}

function pushService() {
  const sent: { url: string; body: Buffer }[] = []
  const fetcher: PushFetch = async (url, init) => {
    sent.push({ url, body: init.body })
    return { status: 201 }
  }
  return { sent, fetcher }
}

interface Listing {
  checkins: { name: string; kind: string; where: string; location: { latitude: number; longitude: number; accuracy: number | null } | null }[]
}

describe('home safe and arrived', () => {
  it('refuses what does not make sense', () => {
    expect(() => cleanCheckin({ kind: 'lost' })).toThrow()
    expect(() => cleanCheckin({ kind: 'arrived', location: { latitude: 91, longitude: 0 } })).toThrow()
    expect(cleanCheckin({ kind: 'home', where: 'x', location: { latitude: 1, longitude: 2 } })).toEqual({ kind: 'home', where: '', location: null })
    expect(cleanCheckin({ kind: 'arrived', where: 'Gym', location: { latitude: -33.92491234567, longitude: 18.4241, accuracy: 12.4 } }).location).toEqual({ latitude: -33.924912, longitude: 18.4241, accuracy: 12 })
  })

  it('tells everyone else in the family, keeps it sealed, and forgets it after a day', async () => {
    const push = pushService()
    server = await startServer({}, { pushFetch: push.fetcher })
    const { client: parent } = await setUpAdmin(server)
    const invite = await parent.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    const kidPhone = fakeBrowser()
    const parentPhone = fakeBrowser()
    await kid.post('/api/notifications/subscriptions', kidPhone.subscription)
    await parent.post('/api/notifications/subscriptions', parentPhone.subscription)

    // The parent arrives: the child is told (the parent, who sent it, is not).
    const arrived = await parent.post<{ told: number }>('/api/safety/checkins', { checkin: { kind: 'arrived', where: 'gymnastics', location: { latitude: -33.9249, longitude: 18.4241, accuracy: 15 } } })
    expect(arrived.body.told).toBe(1)
    expect(push.sent.map((p) => p.url)).toEqual([kidPhone.endpoint])
    expect(kidPhone.read(push.sent[0]!.body)).toMatchObject({ body: 'Parent arrived.', url: '/' })

    // The child is home safe: the parent is told.
    await kid.post('/api/safety/checkins', { checkin: { kind: 'home' } })
    expect(parentPhone.read(push.sent[1]!.body).body).toBe('Kid is home safe.')

    // Everyone in the family sees both, newest first, with the location.
    const seen = await kid.get<Listing>('/api/safety')
    expect(seen.body.checkins.map((c) => [c.name, c.kind])).toEqual([
      ['Kid', 'home'],
      ['Parent', 'arrived'],
    ])
    expect(seen.body.checkins[1]).toMatchObject({ where: 'gymnastics', location: { latitude: -33.9249, longitude: 18.4241, accuracy: 15 } })
    const raw = JSON.stringify(server.services.db.prepare('SELECT * FROM safety_checkins').all())
    for (const w of ['gymnastics', '33.92', '18.42', 'home']) expect(raw).not.toContain(w)

    // Someone who turned these off is not told.
    await kid.call('PUT', '/api/notifications/settings', { safety: false })
    await parent.post('/api/safety/checkins', { checkin: { kind: 'home' } })
    expect(push.sent).toHaveLength(2)

    // Not a flood: a few a minute at most.
    await parent.post('/api/safety/checkins', { checkin: { kind: 'home' } })
    expect((await parent.post('/api/safety/checkins', { checkin: { kind: 'home' } })).status).toBe(429)

    // A day later, it is all gone.
    server.clock.now += 24 * 3_600_000 + 1
    expect((await parent.get<Listing>('/api/safety')).body.checkins).toEqual([])
    expect(server.services.db.prepare('SELECT COUNT(*) AS n FROM safety_checkins').get()).toEqual({ n: 0 })
    expect((await new Client(server.url).get('/api/safety')).status).toBe(401)
  })
})

interface SosListing {
  sos: { id: string; name: string; endedAt: number | null; end: { reason: string; note: string } | null; points: { latitude: number; at: number; batteryLow: boolean }[] }[]
}

describe('SOS', () => {
  async function family() {
    const push = pushService()
    server = await startServer({}, { pushFetch: push.fetcher })
    const { client: parent } = await setUpAdmin(server)
    const invite = await parent.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    const kidPhone = fakeBrowser()
    await kid.post('/api/notifications/subscriptions', kidPhone.subscription)
    // Even with Home safe and Arrived turned off, an SOS comes.
    await kid.call('PUT', '/api/notifications/settings', { safety: false })
    return { push, parent, kid, kidPhone, phone: new Client(server.url) }
  }

  it('alerts the family at once, takes locations by its pass (also several at once), and ends with a reason', async () => {
    const { push, parent, kid, kidPhone, phone } = await family()
    const start = await parent.post<{ sos: { id: string }; pass: string; told: number }>('/api/safety/sos', { location: { latitude: -33.9249, longitude: 18.4241, accuracy: 20 } })
    expect(start.body.told).toBe(1)
    expect(kidPhone.read(push.sent[0]!.body).body).toBe('SOS from Parent. Tap to see.')
    const { id } = start.body.sos
    const pass = start.body.pass

    // The phone, locked (no session), sends locations: two kept while there was no signal go up together.
    const t = server.clock.now
    server.clock.now += 6 * 60_000
    const batch = await phone.post<{ added: number }>(`/api/safety/sos/${id}/points`, {
      pass,
      points: [
        { latitude: -33.925, longitude: 18.425, accuracy: 10, at: t + 2 * 60_000 },
        { latitude: -33.926, longitude: 18.426, accuracy: 10, at: t + 4 * 60_000, batteryLow: true },
      ],
    })
    expect(batch.body.added).toBe(2)
    // One alert at the start, not one per location.
    expect(push.sent).toHaveLength(1)
    expect((await phone.post(`/api/safety/sos/${id}/points`, { pass: 'wrong', points: [] })).status).toBe(404)

    const seen = await kid.get<SosListing>('/api/safety')
    expect(seen.body.sos[0]).toMatchObject({ name: 'Parent', endedAt: null })
    expect(seen.body.sos[0]!.points.map((p) => [p.latitude, p.batteryLow])).toEqual([
      [-33.9249, false],
      [-33.925, false],
      [-33.926, true],
    ])
    const raw = JSON.stringify([...server.services.db.prepare('SELECT * FROM safety_sos').all(), ...server.services.db.prepare('SELECT * FROM safety_sos_points').all()])
    for (const w of ['33.92', '18.42', pass]) expect(raw).not.toContain(w)

    // Ending it: the family is told why.
    expect((await phone.post(`/api/safety/sos/${id}/end`, { pass, reason: 'panic' })).status).toBe(400)
    expect((await phone.post(`/api/safety/sos/${id}/end`, { pass, reason: 'whoops' })).status).toBe(200)
    expect(kidPhone.read(push.sent[1]!.body).body).toBe('Parent ended the SOS: Whoops: sent by mistake.')
    expect((await kid.get<SosListing>('/api/safety')).body.sos[0]!.end).toEqual({ reason: 'whoops', note: '' })
    // The pass is spent.
    expect((await phone.post(`/api/safety/sos/${id}/points`, { pass, points: [] })).status).toBe(410)

    // A day after it ended, it is gone.
    server.clock.now += 24 * 3_600_000 + 1
    expect((await kid.get<SosListing>('/api/safety')).body.sos).toEqual([])
    expect(server.services.db.prepare('SELECT COUNT(*) AS n FROM safety_sos_points').get()).toEqual({ n: 0 })
  })

  it('keeps one SOS per person (starting again hands back a new pass), and ends one left running after a day without a location', async () => {
    const { parent, kid, phone } = await family()
    const a = await parent.post<{ sos: { id: string }; pass: string }>('/api/safety/sos', {})
    const b = await parent.post<{ sos: { id: string }; pass: string }>('/api/safety/sos', {})
    expect(b.body.sos.id).toBe(a.body.sos.id)
    expect((await phone.post(`/api/safety/sos/${a.body.sos.id}/points`, { pass: a.body.pass, points: [] })).status).toBe(404)
    expect((await phone.post(`/api/safety/sos/${a.body.sos.id}/points`, { pass: b.body.pass, points: [{ latitude: 1, longitude: 2 }] })).status).toBe(200)
    server.clock.now += 24 * 3_600_000 + 60_000
    const seen = await kid.get<SosListing>('/api/safety')
    expect(seen.body.sos[0]!.end).toEqual({ reason: 'stale', note: '' })
  })
})

describe('SOS from the lock screen (10c)', () => {
  it('a phone’s SOS key starts an SOS with a one-time challenge, and does nothing else', async () => {
    const { generateKeyPairSync, sign } = await import('node:crypto')
    const { sosMessage } = await import('../src/routes/safety.ts')
    const { signedInPhone } = await import('./helpers.ts')
    const push = pushService()
    server = await startServer({}, { pushFetch: push.fetcher })
    const { client: parent, secret } = await setUpAdmin(server)
    const { client: phone, deviceId } = await signedInPhone(server, secret)
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    // Only a phone's session can set it, from the unlocked app.
    expect((await parent.call('PUT', '/api/safety/sos-key', { publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })).status).toBe(400)
    expect((await phone.call('PUT', '/api/safety/sos-key', { publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') })).status).toBe(200)

    // Locked: no session at all.
    const locked = new Client(server.url)
    const start = async (msg = (c: string) => sosMessage(c, deviceId), key = privateKey) => {
      const c = await locked.post<{ challengeId: string; challenge: string }>('/api/devices/challenge', { deviceId })
      const signature = sign('sha256', msg(c.body.challenge), { key, dsaEncoding: 'der' }).toString('base64')
      return locked.post<{ sos: { id: string }; pass: string }>('/api/safety/sos/by-key', { deviceId, challengeId: c.body.challengeId, signature, location: { latitude: -33.9, longitude: 18.4 } })
    }
    // A signature for something else, or by another key, does not start one.
    const { unlockMessage } = await import('../src/routes/devices.ts')
    expect((await start((c) => unlockMessage(c, deviceId))).status).toBe(401)
    expect((await start(undefined, generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey)).status).toBe(401)
    const ok = await start()
    expect(ok.status).toBe(200)
    expect(ok.body.pass.length).toBeGreaterThan(30)
    // It opened no session: the family's data stays shut.
    expect((await locked.get('/api/safety')).status).toBe(401)
    expect((await parent.get<{ sos: { endedAt: number | null; points: unknown[] }[] }>('/api/safety')).body.sos[0]).toMatchObject({ endedAt: null, points: [{ latitude: -33.9 }] })
    // The SOS key cannot unlock the phone either.
    const c = await locked.post<{ challengeId: string; challenge: string }>('/api/devices/challenge', { deviceId })
    const forged = sign('sha256', unlockMessage(c.body.challenge, deviceId), { key: privateKey, dsaEncoding: 'der' }).toString('base64')
    expect((await locked.post('/api/devices/unlock', { deviceId, challengeId: c.body.challengeId, signature: forged })).status).toBe(401)
  })

  it('gives a phone the rest of the family’s mobile numbers, from their own Contacts entries', async () => {
    server = await startServer()
    const { client: parent } = await setUpAdmin(server)
    const invite = await parent.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    const profiles = (await parent.get<{ profiles: { id: string; userId: string | null; mine: boolean }[] }>('/api/wishlists')).body.profiles
    const mine = profiles.find((p) => p.mine)!
    const kids = profiles.find((p) => !p.mine && p.userId)!
    await parent.post('/api/contacts', { name: 'Parent', profileId: mine.id, phones: [{ label: 'mobile', number: '082 555 0001' }] })
    await parent.post('/api/contacts', { name: 'Kid', profileId: kids.id, phones: [{ label: 'home', number: '021 555 0002' }, { label: 'mobile', number: '083 555 0002' }] })
    expect((await kid.get<{ numbers: unknown[] }>('/api/safety/sos-numbers')).body.numbers).toEqual([{ name: 'Parent', phone: '082 555 0001' }])
    expect((await parent.get<{ numbers: unknown[] }>('/api/safety/sos-numbers')).body.numbers).toEqual([{ name: 'Kid', phone: '083 555 0002' }])
  })
})
