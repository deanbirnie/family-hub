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
