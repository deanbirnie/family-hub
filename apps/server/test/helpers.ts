import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createApp, type Services } from '../src/app.ts'
import type { Config } from '../src/config.ts'
import { openDb } from '../src/db.ts'
import { totpAt } from '../src/totp.ts'

export const PASSWORD = 'correct horse battery staple'

export interface TestServer {
  url: string
  services: Services
  clock: { now: number }
  close(): Promise<void>
}

export async function startServer(overrides: Partial<Config> = {}): Promise<TestServer> {
  const clock = { now: Date.UTC(2026, 10, 20, 12, 0, 0) }
  const config: Config = {
    port: 0,
    host: '127.0.0.1',
    dataDir: '',
    webDir: '',
    version: 'test',
    trustProxyHops: 0,
    allowHttp: false,
    appOrigins: ['https://localhost'],
    ...overrides,
  }
  const db = openDb(':memory:')
  const { server, services } = createApp({
    db,
    config,
    argon2: { memory: 1024, passes: 1, parallelism: 1 },
    now: () => clock.now,
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    services,
    clock,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

export interface Reply<T = Record<string, unknown>> {
  status: number
  body: T
  headers: Headers
}

/** node:http rather than fetch, which will not send a Host header of our choosing. */
function rawRequest(url: string, method: string, headers: Record<string, string>, body?: string): Promise<{ status: number; headers: Headers; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: body === undefined ? headers : { ...headers, 'content-length': String(Buffer.byteLength(body)) } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const h = new Headers()
        for (const [name, value] of Object.entries(res.headers)) {
          for (const v of Array.isArray(value) ? value : [value ?? '']) h.append(name, v)
        }
        resolve({ status: res.statusCode ?? 0, headers: h, text: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end(body)
  })
}

/** A client that behaves like a browser (keeps the session cookie) or like the app (bearer token). */
export class Client {
  cookie = ''
  token = ''
  base: string
  headers: Record<string, string>

  constructor(base: string, headers: Record<string, string> = {}) {
    this.base = base
    // The server only accepts the session cookie from "localhost" when not on https.
    this.headers = { host: 'localhost', ...headers }
  }

  async call<T = Record<string, unknown>>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Reply<T>> {
    const headers: Record<string, string> = { 'x-requested-with': 'family-hub', ...this.headers, ...extra }
    if (body !== undefined) headers['content-type'] = 'application/json'
    if (this.cookie) headers.cookie = this.cookie
    if (this.token) headers.authorization = `Bearer ${this.token}`
    const res = await rawRequest(this.base + path, method, headers, body === undefined ? undefined : JSON.stringify(body))
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0]!
      this.cookie = pair.endsWith('=') ? '' : pair
    }
    const parsed = res.text ? (JSON.parse(res.text) as T) : ({} as T)
    // Sign-in steps hand the app a new token; an invite's token is something else.
    const token = (parsed as { token?: unknown }).token
    if (typeof token === 'string' && path !== '/api/invites') this.token = token
    return { status: res.status, body: parsed, headers: res.headers }
  }

  get = <T = Record<string, unknown>>(path: string) => this.call<T>('GET', path)
  post = <T = Record<string, unknown>>(path: string, body: unknown = {}) => this.call<T>('POST', path, body)
  patch = <T = Record<string, unknown>>(path: string, body: unknown = {}) => this.call<T>('PATCH', path, body)
  del = <T = Record<string, unknown>>(path: string) => this.call<T>('DELETE', path)
}

/** Sets up the first (admin) account and its authenticator; returns the client signed in, and the secret. */
export async function setUpAdmin(server: TestServer, client = new Client(server.url)): Promise<{ client: Client; secret: string; recoveryCodes: string[] }> {
  const setup = await client.post('/api/setup', { familyName: 'The Tests', username: 'parent', displayName: 'Parent', password: PASSWORD })
  if (setup.status !== 200) throw new Error(`setup failed: ${JSON.stringify(setup.body)}`)
  const { secret, recoveryCodes } = await enrollTotp(server, client)
  return { client, secret, recoveryCodes }
}

export async function enrollTotp(server: TestServer, client: Client): Promise<{ secret: string; recoveryCodes: string[] }> {
  const offer = await client.post<{ secret: string }>('/api/auth/totp/setup')
  if (offer.status !== 200) throw new Error(`totp setup failed: ${JSON.stringify(offer.body)}`)
  const confirm = await client.post<{ recoveryCodes: string[] }>('/api/auth/totp/confirm', { code: totpAt(offer.body.secret, server.clock.now) })
  if (confirm.status !== 200) throw new Error(`totp confirm failed: ${JSON.stringify(confirm.body)}`)
  return { secret: offer.body.secret, recoveryCodes: confirm.body.recoveryCodes }
}

/** Moves the clock on to the next 30-second step, so a fresh code is valid. */
export const nextStep = (server: TestServer) => {
  server.clock.now += 30_000
}

export async function signIn(server: TestServer, username: string, secret: string, client = new Client(server.url), extra: Record<string, unknown> = {}): Promise<Client> {
  const login = await client.post('/api/auth/login', { username, password: PASSWORD, ...extra })
  if (login.status !== 200) throw new Error(`login failed: ${JSON.stringify(login.body)}`)
  nextStep(server)
  const code = await client.post('/api/auth/totp', { code: totpAt(secret, server.clock.now) })
  if (code.status !== 200) throw new Error(`code failed: ${JSON.stringify(code.body)}`)
  return client
}
