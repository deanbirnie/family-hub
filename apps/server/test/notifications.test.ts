import { createECDH } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { runReminders } from '../src/notifications.ts'
import type { PushFetch } from '../src/webpush.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, signedInPhone, startServer, type TestServer } from './helpers.ts'
import { decryptAsReceiver } from './push-receiver.ts'

let server: TestServer
afterEach(async () => server?.close())

const DAY = 86_400_000
const ct = (tag: string) => Buffer.from(`ciphertext-${tag}`).toString('base64url')

/** A pretend browser: its push keys, and a push service that keeps what it receives. */
function fakeBrowser(endpoint = `https://push.example.com/send/${Math.random().toString(36).slice(2)}`) {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  const auth = Buffer.alloc(16, 3)
  return {
    endpoint,
    subscription: { kind: 'webpush', endpoint, keys: { p256dh: ecdh.getPublicKey('base64url'), auth: auth.toString('base64url') }, label: 'Test browser' },
    read: (body: Buffer) => JSON.parse(decryptAsReceiver(body, ecdh.getPrivateKey(), auth).toString()) as { title: string; body: string; tag: string; url: string },
  }
}

interface Sent {
  url: string
  headers: Record<string, string>
  body: Buffer
}

function pushService(status = () => 201) {
  const sent: Sent[] = []
  const fetcher: PushFetch = async (url, init) => {
    sent.push({ url, headers: init.headers, body: init.body })
    return { status: status() }
  }
  return { sent, fetcher }
}

async function withPassport(client: Client, expiry: string) {
  const kid = await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })
  const rec = await client.post<{ record: { id: string } }>('/api/quick-info/records', { profileId: kid.body.profile.id, kind: 'passport', ciphertext: ct('p') })
  const put = await client.call('PUT', `/api/reminders/quick-info/${rec.body.record.id}`, { dates: { expiry } })
  expect(put.status).toBe(204)
  return rec.body.record.id
}

describe('notifications', () => {
  it('sends each expiry reminder once, encrypted and generic, at 90, 30 and 7 days', async () => {
    const push = pushService()
    server = await startServer({}, { pushFetch: push.fetcher })
    const { client } = await setUpAdmin(server)
    const browser = fakeBrowser()
    const on = await client.post<{ route: { id: string } }>('/api/notifications/subscriptions', browser.subscription)
    expect(on.status).toBe(200)

    // Today is 20 November 2026 (14:00 in Johannesburg); the passport expires in 100 days.
    await withPassport(client, '2027-02-28')
    expect(await runReminders(server.services)).toBe(0)

    server.clock.now += 10 * DAY // 90 days left
    expect(await runReminders(server.services)).toBe(1)
    expect(await runReminders(server.services)).toBe(0)
    expect(push.sent).toHaveLength(1)
    const msg = browser.read(push.sent[0]!.body)
    expect(msg).toMatchObject({ title: 'Family Hub', body: 'A family document expires soon', url: '/' })
    // Nothing about whose passport, or when, reaches the push service.
    expect(JSON.stringify(msg)).not.toContain('Sam')
    expect(push.sent[0]!.headers['Content-Encoding']).toBe('aes128gcm')
    expect(push.sent[0]!.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/)
    expect(push.sent[0]!.url).toBe(browser.endpoint)

    server.clock.now += 59 * DAY // 31 days left: nothing new
    expect(await runReminders(server.services)).toBe(0)
    server.clock.now += 1 * DAY // 30 days left
    expect(await runReminders(server.services)).toBe(1)
    server.clock.now += 23 * DAY // 7 days left
    expect(await runReminders(server.services)).toBe(1)
    server.clock.now += 8 * DAY // expired
    expect(await runReminders(server.services)).toBe(0)
    expect(push.sent.map((s) => browser.read(s.body).tag)).toHaveLength(3)
  })

  it('shows what is coming up on the home page, for parents only', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    await withPassport(client, '2026-12-20')
    const up = await client.get<{ items: { title: string; whose: string; date: string; daysLeft: number }[] }>('/api/reminders/upcoming')
    expect(up.body.items).toEqual([expect.objectContaining({ title: 'Passport renewal', whose: 'Sam', date: '2026-12-20', daysLeft: 30 })])

    const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    expect((await kid.get<{ items: unknown[] }>('/api/reminders/upcoming')).body.items).toEqual([])
    expect((await kid.get('/api/reminders/quick-info')).status).toBe(403)
    // Members can still turn notifications on for themselves (later phases use them).
    expect((await kid.post('/api/notifications/subscriptions', fakeBrowser().subscription)).status).toBe(200)
  })

  it('keeps reminder dates in step with Quick Info records', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const id = await withPassport(client, '2027-03-01')
    expect((await client.get('/api/reminders/quick-info')).body).toEqual({ dates: [{ recordId: id, field: 'expiry', date: '2027-03-01' }] })
    await client.call('PUT', `/api/reminders/quick-info/${id}`, { dates: { expiry: '2027-04-01' } })
    expect((await client.get<{ dates: { date: string }[] }>('/api/reminders/quick-info')).body.dates[0]!.date).toBe('2027-04-01')
    // Bad input is refused.
    expect((await client.call('PUT', `/api/reminders/quick-info/${id}`, { dates: { expiry: '2027-02-30' } })).status).toBe(400)
    expect((await client.call('PUT', `/api/reminders/quick-info/${id}`, { dates: { number: '2027-02-01' } })).status).toBe(400)
    // Clearing the date removes the reminder; deleting the record does too.
    await client.call('PUT', `/api/reminders/quick-info/${id}`, { dates: {} })
    expect((await client.get<{ dates: unknown[] }>('/api/reminders/quick-info')).body.dates).toEqual([])
    await client.call('PUT', `/api/reminders/quick-info/${id}`, { dates: { expiry: '2027-04-01' } })
    await client.del(`/api/quick-info/records/${id}`)
    expect((await client.get<{ dates: unknown[] }>('/api/reminders/quick-info')).body.dates).toEqual([])
    // Only passports and vehicles have reminders.
    const p = await client.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Alex' })
    const personal = await client.post<{ record: { id: string } }>('/api/quick-info/records', { profileId: p.body.profile.id, kind: 'personal', ciphertext: ct('x') })
    expect((await client.call('PUT', `/api/reminders/quick-info/${personal.body.record.id}`, { dates: { expiry: '2027-01-01' } })).status).toBe(400)
  })

  it('respects each parent’s settings and sending hour', async () => {
    const push = pushService()
    server = await startServer({}, { pushFetch: push.fetcher })
    const { client } = await setUpAdmin(server)
    await client.post('/api/notifications/subscriptions', fakeBrowser().subscription)
    await withPassport(client, '2026-12-20') // 30 days left
    expect((await client.call('PUT', '/api/notifications/settings', { expiry: false })).status).toBe(200)
    expect(await runReminders(server.services)).toBe(0)
    await client.call('PUT', '/api/notifications/settings', { expiry: true, sendHour: 15 })
    expect(await runReminders(server.services)).toBe(0) // 14:00 in Johannesburg
    server.clock.now += 3600_000
    expect(await runReminders(server.services)).toBe(1)
    expect((await client.call('PUT', '/api/notifications/settings', { sendHour: 24 })).status).toBe(400)
    expect((await client.get<{ settings: unknown }>('/api/notifications')).body.settings).toEqual({ enabled: true, expiry: true, sendHour: 15 })
  })

  it('tracks push health, sends tests, and forgets addresses the push service says are gone', async () => {
    let status = 500
    const push = pushService(() => status)
    server = await startServer({}, { pushFetch: push.fetcher })
    const { client } = await setUpAdmin(server)
    const on = await client.post<{ route: { id: string } }>('/api/notifications/subscriptions', fakeBrowser().subscription)
    const id = on.body.route.id

    const failed = await client.post<{ ok: boolean; message: string }>(`/api/notifications/subscriptions/${id}/test`)
    expect(failed.body.ok).toBe(false)
    type Routes = { routes: { id: string; failing: boolean; lastOkAt: number | null; lastError: string | null }[] }
    expect((await client.get<Routes>('/api/notifications')).body.routes[0]).toMatchObject({ failing: true, lastError: 'push service answered 500' })

    status = 201
    expect((await client.post<{ ok: boolean }>(`/api/notifications/subscriptions/${id}/test`)).body.ok).toBe(true)
    expect((await client.get<Routes>('/api/notifications')).body.routes[0]).toMatchObject({ failing: false, lastOkAt: server.clock.now })

    status = 410
    expect((await client.post<{ gone: boolean }>(`/api/notifications/subscriptions/${id}/test`)).body.gone).toBe(true)
    expect((await client.get<Routes>('/api/notifications')).body.routes).toEqual([])
  })

  it('checks push addresses, and lets each person remove only their own', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const browser = fakeBrowser()
    expect((await client.post('/api/notifications/subscriptions', { ...browser.subscription, endpoint: 'http://push.example.com/x' })).status).toBe(400)
    expect((await client.post('/api/notifications/subscriptions', { ...browser.subscription, keys: { p256dh: 'x', auth: 'y' } })).status).toBe(400)
    expect((await client.post('/api/notifications/subscriptions', { ...browser.subscription, kind: 'unifiedpush' })).status).toBe(400)
    const a = await client.post<{ route: { id: string } }>('/api/notifications/subscriptions', browser.subscription)
    // The same browser again refreshes the same entry.
    const b = await client.post<{ route: { id: string } }>('/api/notifications/subscriptions', { ...browser.subscription, label: 'Renamed' })
    expect(b.body.route.id).toBe(a.body.route.id)
    // The address itself is sealed with the server key.
    const raw = server.services.db.prepare('SELECT sealed FROM push_subscriptions').get() as { sealed: string }
    expect(raw.sealed.startsWith('s1.')).toBe(true)
    expect(raw.sealed).not.toContain('push.example.com')

    const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    expect((await kid.del(`/api/notifications/subscriptions/${a.body.route.id}`)).status).toBe(404)
    expect((await client.del(`/api/notifications/subscriptions/${a.body.route.id}`)).status).toBe(204)
  })

  it('lets a phone’s daily check read its owner’s due reminders, and nothing else', async () => {
    server = await startServer()
    const { client, secret } = await setUpAdmin(server)
    await withPassport(client, '2026-12-20') // 30 days left
    // Browsers have no daily check.
    expect((await client.post('/api/notifications/check-token')).status).toBe(400)
    const phone = await signedInPhone(server, secret)
    const issued = await phone.client.post<{ checkToken: string }>('/api/notifications/check-token')
    expect(issued.status).toBe(200)
    const check = (token: string) => new Client(server.url, { authorization: `Check ${token}` }).get<{ items: { title: string; body: string; tag: string }[] }>('/api/notifications/due')

    const due = await check(issued.body.checkToken)
    expect(due.status).toBe(200)
    expect(due.body.items).toEqual([expect.objectContaining({ title: 'Family Hub', body: 'A family document expires soon' })])
    expect(JSON.stringify(due.body)).not.toContain('Sam')
    // The same reminder carries the same tag as its push message, so the phone shows it once.
    expect(due.body.items[0]!.tag).toMatch(/^r:.+@2026-12-20\/30$/)
    // Settings apply; the sending hour does not (the check runs when Android lets it).
    await client.call('PUT', '/api/notifications/settings', { sendHour: 23 })
    expect((await check(issued.body.checkToken)).body.items).toHaveLength(1)
    await client.call('PUT', '/api/notifications/settings', { expiry: false })
    expect((await check(issued.body.checkToken)).body.items).toHaveLength(0)
    await client.call('PUT', '/api/notifications/settings', { expiry: true })

    // The token is not a session, and a session is not a token.
    expect((await new Client(server.url, { authorization: `Bearer ${issued.body.checkToken}` }).get('/api/quick-info')).status).toBe(401)
    expect((await check(phone.client.token)).status).toBe(401)
    expect((await check('nonsense')).status).toBe(401)

    // Settings show the phone's last check.
    const state = await phone.client.get<{ checks: { deviceId: string; current: boolean; lastCheckAt: number }[] }>('/api/notifications')
    expect(state.body.checks).toEqual([expect.objectContaining({ deviceId: phone.deviceId, current: true, lastCheckAt: server.clock.now })])

    // A new token replaces the old; turning off (or removing the phone) ends it.
    const again = await phone.client.post<{ checkToken: string }>('/api/notifications/check-token')
    expect((await check(issued.body.checkToken)).status).toBe(401)
    expect((await check(again.body.checkToken)).status).toBe(200)
    expect((await phone.client.del('/api/notifications/check-token')).status).toBe(204)
    expect((await check(again.body.checkToken)).status).toBe(401)
    const third = await phone.client.post<{ checkToken: string }>('/api/notifications/check-token')
    expect((await client.del(`/api/account/devices/${phone.deviceId}`)).status).toBe(204)
    expect((await check(third.body.checkToken)).status).toBe(401)
  })

  it('lets a phone register its UnifiedPush address, which goes when the phone does', async () => {
    server = await startServer()
    const { client, secret } = await setUpAdmin(server)
    const phone = await signedInPhone(server, secret)
    const up = { ...fakeBrowser('https://ntfy.sh/upAbCdEf123?up=1').subscription, kind: 'unifiedpush', label: 'Pixel' }
    expect((await client.post('/api/notifications/subscriptions', up)).status).toBe(400) // browsers cannot
    const on = await phone.client.post<{ route: { phone: boolean } }>('/api/notifications/subscriptions', up)
    expect(on.body.route.phone).toBe(true)
    // A new address from the distributor replaces the old one.
    await phone.client.post('/api/notifications/subscriptions', { ...up, endpoint: 'https://ntfy.sh/upNew456?up=1' })
    expect((await client.get<{ routes: unknown[] }>('/api/notifications')).body.routes).toHaveLength(1)
    await phone.client.del('/api/notifications/check-token')
    expect((await client.get<{ routes: unknown[] }>('/api/notifications')).body.routes).toHaveLength(0)
  })
})
