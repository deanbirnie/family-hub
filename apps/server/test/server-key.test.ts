import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { totpAt } from '../src/totp.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

describe('saving the server key to a password manager', () => {
  it('reminds parents until one confirms, and shows the key only after a fresh code', async () => {
    server = await startServer()
    const { client, secret } = await setUpAdmin(server)
    expect((await client.get('/api/server-key')).body).toMatchObject({ saved: false })

    // A session alone is not enough; a wrong or reused code is refused.
    expect((await client.post('/api/server-key/reveal', {})).status).toBe(400)
    expect((await client.post('/api/server-key/reveal', { code: '000000' })).body).toMatchObject({ error: 'bad_code' })
    nextStep(server)
    const code = totpAt(secret, server.clock.now)
    const shown = await client.post<{ key: string; file: string }>('/api/server-key/reveal', { code })
    expect(shown.status).toBe(200)
    expect(shown.body.key).toBe(readFileSync(server.services.config.keyFile, 'utf8').trim())
    expect((await client.post('/api/server-key/reveal', { code })).body).toMatchObject({ error: 'bad_code' })

    expect((await client.post('/api/server-key/saved')).status).toBe(200)
    expect((await client.get('/api/server-key')).body).toMatchObject({ saved: true })
    const events = (await client.get<{ events: { event: string }[] }>('/api/account/activity')).body.events.map((e) => e.event)
    expect(events).toEqual(expect.arrayContaining(['server_key.revealed', 'server_key.reveal_failed', 'server_key.saved']))
  })

  it('is for parents only', async () => {
    server = await startServer()
    const { client: parent } = await setUpAdmin(server)
    const invite = await parent.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    const { secret } = await enrollTotp(server, kid)
    nextStep(server)
    expect((await kid.get('/api/server-key')).status).toBe(403)
    expect((await kid.post('/api/server-key/reveal', { code: totpAt(secret, server.clock.now) })).status).toBe(403)
    expect((await kid.post('/api/server-key/saved')).status).toBe(403)
  })
})
