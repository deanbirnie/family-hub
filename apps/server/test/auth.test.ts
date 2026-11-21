import { afterEach, describe, expect, it } from 'vitest'
import { IDLE_TIMEOUT_MS } from '../src/app.ts'
import { AUDIT_DAYS, pruneSessions } from '../src/sessions.ts'
import { totpAt } from '../src/totp.ts'
import { Client, nextStep, PASSWORD, setUpAdmin, signIn, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

describe('first-run setup', () => {
  it('creates the first admin once, who must set up two-factor before anything else', async () => {
    server = await startServer()
    const client = new Client(server.url)
    expect((await client.get('/api/setup')).body).toMatchObject({ needed: true })

    const setup = await client.post('/api/setup', { familyName: 'The Tests', username: 'Parent', displayName: 'Parent', password: PASSWORD })
    expect(setup.status).toBe(200)
    expect(setup.body).toMatchObject({ stage: 'enroll' })
    expect(setup.body.token).toBeUndefined() // browsers get a cookie, never the token
    expect(setup.headers.getSetCookie()[0]).toMatch(/^__Host-fh_session=.+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/)

    // Not signed in yet: only the two-factor set-up is open.
    expect((await client.get('/api/members')).status).toBe(403)
    const session = await client.get('/api/auth/session')
    expect(session.body).toMatchObject({ stage: 'enroll', user: { username: 'parent', role: 'admin' } })

    const again = await new Client(server.url).post('/api/setup', { familyName: 'X', username: 'other', displayName: 'Other', password: PASSWORD })
    expect(again.status).toBe(409)
    expect((await client.get('/api/setup')).body).toMatchObject({ needed: false, familyName: 'The Tests' })
  })

  it('refuses weak passwords and odd usernames', async () => {
    server = await startServer()
    const client = new Client(server.url)
    expect((await client.post('/api/setup', { familyName: 'F', username: 'parent', displayName: 'P', password: 'short' })).status).toBe(400)
    expect((await client.post('/api/setup', { familyName: 'F', username: 'no spaces', displayName: 'P', password: PASSWORD })).status).toBe(400)
  })
})

describe('two-factor sign-in', () => {
  it('sets up an authenticator, then needs password and code to sign in', async () => {
    server = await startServer()
    const { client, secret, recoveryCodes } = await setUpAdmin(server)
    expect(recoveryCodes).toHaveLength(10)
    expect((await client.get('/api/auth/session')).body).toMatchObject({ stage: 'full' })
    expect((await client.get('/api/members')).status).toBe(200)

    await client.post('/api/auth/logout')
    expect(client.cookie).toBe('')
    expect((await client.get('/api/members')).status).toBe(401)

    const login = await client.post('/api/auth/login', { username: 'PARENT', password: PASSWORD })
    expect(login.body).toMatchObject({ stage: 'totp' })
    expect((await client.get('/api/members')).status).toBe(403)

    nextStep(server)
    expect((await client.post('/api/auth/totp', { code: '000000' })).status).toBe(401)
    const ok = await client.post('/api/auth/totp', { code: totpAt(secret, server.clock.now) })
    expect(ok.status).toBe(200)
    expect(ok.body).toMatchObject({ stage: 'full' })
    expect((await client.get('/api/members')).status).toBe(200)
  })

  it('accepts each code only once', async () => {
    server = await startServer()
    const { secret } = await setUpAdmin(server)
    nextStep(server)
    const code = totpAt(secret, server.clock.now)
    const a = new Client(server.url)
    await a.post('/api/auth/login', { username: 'parent', password: PASSWORD })
    expect((await a.post('/api/auth/totp', { code })).status).toBe(200)
    const b = new Client(server.url)
    await b.post('/api/auth/login', { username: 'parent', password: PASSWORD })
    expect((await b.post('/api/auth/totp', { code })).status).toBe(401)
  })

  it('a session token from before a step does not work after it', async () => {
    server = await startServer()
    const { secret } = await setUpAdmin(server)
    const client = new Client(server.url)
    await client.post('/api/auth/login', { username: 'parent', password: PASSWORD })
    const before = client.cookie
    nextStep(server)
    await client.post('/api/auth/totp', { code: totpAt(secret, server.clock.now) })
    expect(client.cookie).not.toBe(before)
    const stale = new Client(server.url)
    stale.cookie = before
    expect((await stale.get('/api/auth/session')).status).toBe(401)
  })

  it('recovery codes work once each', async () => {
    server = await startServer()
    const { recoveryCodes } = await setUpAdmin(server)
    const client = new Client(server.url)
    await client.post('/api/auth/login', { username: 'parent', password: PASSWORD })
    const used = await client.post('/api/auth/totp', { recoveryCode: recoveryCodes[0]!.toUpperCase() })
    expect(used.body).toMatchObject({ stage: 'full', recoveryCodesLeft: 9 })

    const again = new Client(server.url)
    await again.post('/api/auth/login', { username: 'parent', password: PASSWORD })
    expect((await again.post('/api/auth/totp', { recoveryCode: recoveryCodes[0] })).status).toBe(401)
  })

  it('ends the attempt after five wrong codes', async () => {
    server = await startServer()
    await setUpAdmin(server)
    const client = new Client(server.url)
    await client.post('/api/auth/login', { username: 'parent', password: PASSWORD })
    for (let i = 0; i < 4; i++) expect((await client.post('/api/auth/totp', { code: '000000' })).body).toMatchObject({ error: 'bad_code' })
    expect((await client.post('/api/auth/totp', { code: '000000' })).body).toMatchObject({ error: 'restart' })
    expect((await client.get('/api/auth/session')).status).toBe(401)
  })

  it('locks the account after repeated wrong passwords, without saying whether it exists', async () => {
    server = await startServer()
    const { secret } = await setUpAdmin(server)
    const client = new Client(server.url)
    const unknown = await client.post('/api/auth/login', { username: 'nobody', password: PASSWORD })
    const wrong = await client.post('/api/auth/login', { username: 'parent', password: 'wrong password!!' })
    expect(unknown.status).toBe(401)
    expect(wrong.body).toEqual(unknown.body)

    for (let i = 0; i < 4; i++) await client.post('/api/auth/login', { username: 'parent', password: 'wrong password!!' })
    const locked = await client.post('/api/auth/login', { username: 'parent', password: PASSWORD })
    expect(locked.status).toBe(429)
    expect(locked.body).toMatchObject({ error: 'locked' })

    server.clock.now += 16 * 60_000
    await signIn(server, 'parent', secret)
  })

  it('a member set up later must also set up two-factor first', async () => {
    server = await startServer()
    const { client: admin } = await setUpAdmin(server)
    const invite = await admin.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    const joined = await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    expect(joined.body).toMatchObject({ stage: 'enroll' })
    expect((await kid.get('/api/members')).status).toBe(403)
  })
})

describe('request rules', () => {
  it('needs the request header on anything that changes state', async () => {
    server = await startServer()
    const res = await fetch(`${server.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost' },
      body: JSON.stringify({ username: 'a', password: 'b' }),
    })
    expect(res.status).toBe(403)
  })

  it('refuses requests from other websites', async () => {
    server = await startServer()
    const client = new Client(server.url, { 'sec-fetch-site': 'cross-site', origin: 'https://evil.example' })
    expect((await client.get('/api/setup')).status).toBe(403)
    const preflight = await fetch(`${server.url}/api/setup`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } })
    expect(preflight.status).toBe(403)
  })

  it('refuses other services on the same domain, but not the page itself', async () => {
    server = await startServer()
    const sibling = new Client(server.url, { 'sec-fetch-site': 'same-site', origin: 'https://photos.example.com' })
    expect((await sibling.get('/api/setup')).status).toBe(403)
    expect((await new Client(server.url, { 'sec-fetch-site': 'same-origin' }).get('/api/setup')).status).toBe(200)
    expect((await new Client(server.url, { 'sec-fetch-site': 'none' }).get('/api/setup')).status).toBe(200)
  })

  it('lets large uploads take their time, but closes idle connections', async () => {
    server = await startServer()
    expect(server.server.requestTimeout).toBe(0)
    expect(server.server.timeout).toBe(IDLE_TIMEOUT_MS)
    expect(server.server.headersTimeout).toBeGreaterThan(0)
  })

  it('keeps a year of security history', async () => {
    server = await startServer()
    const { db } = server.services
    db.prepare("INSERT INTO audit_log (at, event) VALUES (?, 'old'), (?, 'recent')").run(
      server.clock.now - (AUDIT_DAYS + 1) * 86_400_000,
      server.clock.now - 86_400_000,
    )
    pruneSessions(db, server.clock.now)
    expect((db.prepare('SELECT event FROM audit_log').all() as { event: string }[]).map((r) => r.event)).toEqual(['recent'])
  })

  it('lets the Android app call with a bearer token', async () => {
    server = await startServer()
    const preflight = await fetch(`${server.url}/api/setup`, { method: 'OPTIONS', headers: { origin: 'https://localhost' } })
    expect(preflight.status).toBe(204)
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://localhost')
    expect(preflight.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('will not set a session cookie over plain http to another host, unless allowed', async () => {
    server = await startServer()
    const lan = new Client(server.url, { host: '192.168.1.10:8080' })
    const res = await lan.post('/api/setup', { familyName: 'F', username: 'parent', displayName: 'P', password: PASSWORD })
    expect(res.body).toMatchObject({ error: 'https_required' })
    await server.close()

    server = await startServer({ allowHttp: true })
    const allowed = new Client(server.url, { host: '192.168.1.10:8080' })
    const ok = await allowed.post('/api/setup', { familyName: 'F', username: 'parent', displayName: 'P', password: PASSWORD })
    expect(ok.status).toBe(200)
    expect(ok.headers.getSetCookie()[0]).toMatch(/^fh_session=/)
    expect(ok.headers.getSetCookie()[0]).not.toMatch(/Secure/)
  })

  it('treats a trusted proxy’s https as secure', async () => {
    server = await startServer({ trustProxyHops: 1 })
    const client = new Client(server.url, { host: 'hub.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': '203.0.113.9' })
    const res = await client.post('/api/setup', { familyName: 'F', username: 'parent', displayName: 'P', password: PASSWORD })
    expect(res.status).toBe(200)
    expect(res.headers.get('strict-transport-security')).toMatch(/max-age/)
    const row = server.services.db.prepare('SELECT ip FROM audit_log WHERE event = ?').get('setup') as { ip: string }
    expect(row.ip).toBe('203.0.113.9')
  })

  it('sends security headers and no-store on the API', async () => {
    server = await startServer()
    const res = await fetch(`${server.url}/api/health`)
    expect(await res.json()).toEqual({ ok: true, version: 'test' })
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
})
