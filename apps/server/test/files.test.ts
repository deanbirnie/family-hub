import { readdirSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSession } from '../src/sessions.ts'
import { Client, enrollTotp, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())
interface Item { id: string; name: string; size: number; kind: string }
async function upload(client: Client, name = 'policy.txt', body: string | Buffer = 'important paperwork', parent = '') {
  return fetch(`${server.url}/api/files/upload?${new URLSearchParams({ name, parent })}`, {
    method: 'POST', headers: { 'x-requested-with': 'family-hub', cookie: client.cookie, ...(client.token ? { authorization: `Bearer ${client.token}` } : {}) }, body,
  })
}
async function add(client: Client, name = 'policy.txt', contents = 'important paperwork') {
  const res = await upload(client, name, contents)
  expect(res.status).toBe(200)
  return ((await res.json()) as { item: Item }).item
}

describe('shared documents', () => {
  it('creates folders, searches literal names, renames and moves without changing file contents', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const folder = (await client.post<{ item: Item }>('/api/files/folders', { name: 'Policies' })).body.item
    const nested = (await client.post<{ item: Item }>('/api/files/folders', { name: '2026', parentId: folder.id })).body.item
    const item = await add(client, '100% covered.txt')
    expect((await client.patch(`/api/files/${item.id}`, { parentId: nested.id, name: '100% insured.txt' })).status).toBe(200)
    const listing = await client.get<{ items: Item[]; ancestors: { name: string }[] }>(`/api/files?parent=${nested.id}`)
    expect(listing.body.items[0]?.id).toBe(item.id)
    expect(listing.body.ancestors.map((f) => f.name)).toEqual(['Policies', '2026'])
    expect((await client.get<{ items: Item[] }>('/api/files?q=%25')).body.items).toHaveLength(1)
    expect((await client.get<{ items: Item[] }>('/api/files?q=_')).body.items).toHaveLength(0)
    const res = await fetch(`${server.url}/api/files/${item.id}/content`, { headers: { cookie: client.cookie } })
    expect(await res.text()).toBe('important paperwork')
    expect((await client.patch(`/api/files/${folder.id}`, { parentId: nested.id })).body).toMatchObject({ error: 'folder_cycle' })
    expect((await client.patch(`/api/files/${folder.id}`, { parentId: folder.id })).status).toBe(400)
    expect((await client.post('/api/files/folders', { name: 'POLICIES' })).status).toBe(409)
    expect((await client.post('/api/files/folders', { name: 'bad', parentId: item.id })).status).toBe(400)
    expect((await client.patch(`/api/files/${item.id}`, { name: '../bad' })).status).toBe(400)
    expect((await client.get(`/api/files/${folder.id}/content`)).status).toBe(400)
  })

  it('previews only verified PDF/raster signatures and never renders HTML or SVG inline', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    for (const [name, body, type] of [
      ['scan.pdf', '%PDF-1.7\npaperwork', 'application/pdf'],
      ['scan.gif', 'GIF89a' + 'data', 'image/gif'],
      ['scan.webp', 'RIFF1234WEBPdata', 'image/webp'],
    ]) {
      const item = await add(client, name!, body!)
      const res = await fetch(`${server.url}/api/files/${item.id}/content?preview=1`, { headers: { cookie: client.cookie } })
      expect(res.headers.get('content-type')).toBe(type)
      expect(res.headers.get('content-security-policy')).toContain('sandbox')
      expect(res.headers.get('content-disposition')).toContain('attachment')
      expect(await res.text()).toBe(body)
    }
    for (const name of ['fake.pdf', 'script.svg', 'page.html']) {
      const item = await add(client, name, '<script>alert(1)</script>')
      expect((await client.get(`/api/files/${item.id}/content?preview=1`)).status).toBe(415)
      const download = await fetch(`${server.url}/api/files/${item.id}/content`, { headers: { cookie: client.cookie } })
      expect(download.headers.get('content-type')).toBe('application/octet-stream')
      await download.arrayBuffer()
    }
  })

  it('uploads, lists and repeatedly downloads with the existing cookie session', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const item = await add(client, 'Policy é.txt')
    expect((await client.get<{ items: Item[] }>('/api/files')).body.items).toEqual([expect.objectContaining({ id: item.id, name: 'Policy é.txt', size: 19 })])
    expect(readFileSync(join(server.services.config.dataDir, 'files', item.id), 'utf8')).toBe('important paperwork')
    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${server.url}/api/files/${item.id}/content`, { headers: { cookie: client.cookie } })
      expect(res.status).toBe(200)
      expect(res.headers.get('content-disposition')).toContain('attachment;')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(await res.text()).toBe('important paperwork')
    }
    const head = await fetch(`${server.url}/api/files/${item.id}/content`, { method: 'HEAD', headers: { cookie: client.cookie } })
    expect(head.status).toBe(200); expect(await head.text()).toBe('')
  })

  it('requires a full session for listing, uploading and downloading', async () => {
    server = await startServer()
    const { client: admin } = await setUpAdmin(server)
    const item = await add(admin)
    const outsider = new Client(server.url)
    expect((await outsider.get('/api/files')).status).toBe(401)
    expect((await upload(outsider)).status).toBe(401)
    expect((await outsider.get(`/api/files/${item.id}/content`)).status).toBe(401)
    await outsider.post('/api/auth/login', { username: 'parent', password: PASSWORD })
    expect((await outsider.get('/api/files')).status).toBe(403)
    expect((await outsider.get(`/api/files/${item.id}/content`)).status).toBe(403)
    expect((await upload(outsider, 'new.txt')).status).toBe(403)
  })

  it('shares documents with members and accepts a full bearer session without another challenge', async () => {
    server = await startServer()
    const { client: admin } = await setUpAdmin(server)
    const item = await add(admin)
    const invite = await admin.post<{ token: string }>('/api/invites', { displayName: 'Sam' })
    const member = new Client(server.url)
    await member.post(`/api/invites/redeem/${invite.body.token}`, { username: 'sam', displayName: 'Sam', password: PASSWORD })
    await enrollTotp(server, member)
    expect((await member.get('/api/files')).status).toBe(200)
    const self = (await member.get<{ user: { id: string } }>('/api/auth/session')).body.user
    const bearer = createSession(server.services.db, { userId: self.id, stage: 'full', transport: 'bearer', ip: '', userAgent: '' }, server.clock.now)
    member.token = bearer.token; member.cookie = ''
    const res = await fetch(`${server.url}/api/files/${item.id}/content`, { headers: { authorization: `Bearer ${member.token}`, origin: 'https://localhost' } })
    expect(res.status).toBe(200); expect(await res.text()).toBe('important paperwork')
    expect((await upload(member, 'from-phone.txt')).status).toBe(200)
    server.services.db.prepare('DELETE FROM sessions WHERE id = ?').run(bearer.session.id)
    expect((await member.get(`/api/files/${item.id}/content`)).status).toBe(401)
  })

  it('rejects unsafe names, duplicate names and non-folder destinations', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    for (const name of ['../secret', 'a\\b', '.', '', 'a\u0000b', 'x'.repeat(241)]) expect((await upload(client, name)).status).toBe(400)
    const item = await add(client)
    expect((await upload(client, 'POLICY.txt')).status).toBe(409)
    expect((await upload(client, 'new.txt', 'contents', item.id)).status).toBe(400)
    expect((await upload(client, 'new.txt', 'contents', 'missing')).status).toBe(404)
    expect((await client.get('/api/files/%2e%2e%2f/content')).status).toBe(404)
  })

  it('enforces both declared and chunked size limits without leaving disk files', async () => {
    server = await startServer({ maxFileBytes: 4 })
    const { client } = await setUpAdmin(server)
    expect((await upload(client, 'large.txt', '12345')).status).toBe(413)
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${server.url}/api/files/upload?name=chunked`, { method: 'POST', headers: { cookie: client.cookie, 'x-requested-with': 'family-hub' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject); req.write('123'); req.end('45')
    })
    expect(status).toBe(413)
    expect(readdirSync(join(server.services.config.dataDir, 'files'))).toEqual([])
    expect((await add(client, 'empty', '')).size).toBe(0)
  })

  it('cleans an interrupted upload and refuses a session revoked while uploading', async () => {
    server = await startServer()
    const { client } = await setUpAdmin(server)
    const dir = join(server.services.config.dataDir, 'files')
    const pending = request(`${server.url}/api/files/upload?name=interrupted`, { method: 'POST', headers: { cookie: client.cookie, 'x-requested-with': 'family-hub' } })
    pending.on('error', () => undefined); pending.write('partial')
    await expect.poll(() => readdirSync(dir).length).toBe(1)
    pending.destroy()
    await expect.poll(() => readdirSync(dir).length).toBe(0)
    const status = new Promise<number>((resolve, reject) => {
      const req = request(`${server.url}/api/files/upload?name=revoked`, { method: 'POST', headers: { cookie: client.cookie, 'x-requested-with': 'family-hub' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject); req.write('partial')
      void (async () => {
        await expect.poll(() => readdirSync(dir).length).toBe(1)
        await client.post('/api/auth/logout')
        req.end('finished')
      })().catch(reject)
    })
    expect(await status).toBe(401)
    expect(readdirSync(dir)).toEqual([])
  })
})
