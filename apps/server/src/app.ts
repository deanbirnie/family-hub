/**
 * The Family Hub server: wires the API routes, authentication and the web
 * app together into one node:http request handler.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Config } from './config.ts'
import type { Db } from './db.ts'
import { clientIp, HttpError, isSecure, parseCookies, Router, securityHeaders, sendJson, type Ctx } from './http.ts'
import { AccountLockout, RateLimiter } from './limits.ts'
import { DEFAULT_ARGON2, type Argon2Params } from './secrets.ts'
import { cookieName, findSession, getUser, pruneSessions, type Session, type Stage, type User } from './sessions.ts'
import { serveStatic } from './static.ts'
import { accountRoutes } from './routes/account.ts'
import { authRoutes } from './routes/auth.ts'
import { deviceRoutes } from './routes/devices.ts'
import { memberRoutes } from './routes/members.ts'
import { serverKeyRoutes } from './routes/server-key.ts'
import { vaultRoutes } from './routes/vault.ts'
import { quickInfoRoutes } from './routes/quick-info.ts'
import { contactRoutes } from './routes/contacts.ts'
import { fileRoutes } from './routes/files.ts'
import { maintainFiles } from './file-maintenance.ts'
import type { ServerKey } from './server-key.ts'

export interface AppOptions {
  db: Db
  config: Config
  /** Encrypts data at rest (see server-key.ts). */
  serverKey: ServerKey
  /** Lower Argon2 settings make tests fast; production uses the default. */
  argon2?: Argon2Params
  now?: () => number
}

/** Everything a route needs. */
export interface Services {
  db: Db
  config: Config
  serverKey: ServerKey
  argon2: Argon2Params
  now: () => number
  limits: {
    /** Sign-in attempts per address. */
    signIn: RateLimiter
    /** Invite look-ups and other unauthenticated endpoints, per address. */
    open: RateLimiter
    accounts: AccountLockout
  }
  audit(event: string, ctx: Ctx, userId?: string | null, detail?: string): void
}

/** A request with a session already checked. */
export interface AuthedCtx extends Ctx {
  session: Session
  user: User
}

/** Rules for an API route: which sessions may call it. */
export interface Guard {
  /** Stages allowed; default ['full']. Empty means no session needed. */
  stages?: Stage[]
  admin?: boolean
}

export type Api = {
  open(method: string, path: string, handler: (ctx: Ctx) => unknown): void
  authed(method: string, path: string, guard: Guard, handler: (ctx: AuthedCtx) => unknown): void
}

/** A connection is closed after this long without receiving or sending anything. */
export const IDLE_TIMEOUT_MS = 2 * 60_000

export const CSRF_HEADER = 'x-requested-with'
export const CSRF_VALUE = 'family-hub'

export function createApp(opts: AppOptions): { server: Server; services: Services; handle: (req: IncomingMessage, res: ServerResponse) => void } {
  const { db, config } = opts
  const services: Services = {
    db,
    config,
    serverKey: opts.serverKey,
    argon2: opts.argon2 ?? DEFAULT_ARGON2,
    now: opts.now ?? Date.now,
    limits: {
      signIn: new RateLimiter(30, 15 * 60_000),
      open: new RateLimiter(60, 15 * 60_000),
      accounts: new AccountLockout(),
    },
    audit(event, ctx, userId = null, detail = '') {
      db.prepare('INSERT INTO audit_log (at, user_id, event, ip, detail) VALUES (?, ?, ?, ?, ?)').run(
        services.now(),
        userId,
        event,
        ctx.ip,
        detail.slice(0, 500),
      )
    },
  }

  const router = new Router()
  const api: Api = {
    open: (method, path, handler) => router.add(method, path, handler),
    authed: (method, path, guard, handler) =>
      router.add(method, path, (ctx) => {
        const authed = authenticate(services, ctx, guard)
        return handler(authed)
      }),
  }

  api.open('GET', '/api/health', () => ({ ok: true, version: config.version }))
  authRoutes(api, services)
  accountRoutes(api, services)
  memberRoutes(api, services)
  deviceRoutes(api, services)
  fileRoutes(api, services)
  serverKeyRoutes(api, services)
  vaultRoutes(api, services)
  quickInfoRoutes(api, services)
  contactRoutes(api, services)

  const handle = (req: IncomingMessage, res: ServerResponse) => {
    void dispatch(services, router, req, res)
  }
  const server = createServer(handle)
  // Slow clients must not hold connections open forever.
  server.headersTimeout = 20_000
  // No limit on the whole request: a large document upload from a phone can
  // take many minutes. A connection that sends nothing for two minutes is
  // closed instead, so idle and stalled clients still cannot linger.
  server.requestTimeout = 0
  server.timeout = IDLE_TIMEOUT_MS

  const prune = setInterval(() => {
    try {
      pruneSessions(db, services.now())
      services.limits.signIn.prune()
      services.limits.open.prune()
      services.limits.accounts.prune()
      void maintainFiles(services).catch((e) => console.error('Document cleanup failed', e))
    } catch {
      // the next run will try again
    }
  }, 10 * 60_000)
  prune.unref()
  server.on('close', () => clearInterval(prune))

  return { server, services, handle }
}

async function dispatch(services: Services, router: Router, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { config } = services
  const secure = isSecure(req, config.trustProxyHops)
  securityHeaders(res, secure)
  let url: URL
  try {
    url = new URL(req.url ?? '/', 'http://local')
  } catch {
    sendJson(res, 400, { error: 'bad_request', message: 'Bad request.' })
    return
  }
  const method = (req.method ?? 'GET').toUpperCase()
  const ctx: Ctx = { req, res, method, url, params: {}, ip: clientIp(req, config.trustProxyHops), secure }

  try {
    if (!url.pathname.startsWith('/api/')) {
      if (serveStatic(config.webDir, req, res, url.pathname)) return
      throw new HttpError(404, 'Not found.', 'not_found')
    }

    // The Android app calls from its own origin (https://localhost).
    const origin = req.headers.origin
    const appOrigin = typeof origin === 'string' && config.appOrigins.includes(origin)
    if (appOrigin) {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    if (method === 'OPTIONS') {
      if (!appOrigin) throw new HttpError(403, 'Not allowed.', 'forbidden')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE')
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Requested-With')
      res.setHeader('Access-Control-Max-Age', '600')
      res.statusCode = 204
      res.end()
      return
    }

    // Requests from other websites are refused outright. Anything that
    // changes something must also carry a header a cross-site form or
    // simple request cannot add (and a cross-origin script cannot either,
    // because the preflight above refuses unknown origins).
    // Other services on the same domain (same-site, e.g. another app on a
    // sibling subdomain of the home server) are refused too.
    const site = req.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none' && !appOrigin) {
      throw new HttpError(403, 'Not allowed.', 'forbidden')
    }
    if (method !== 'GET' && method !== 'HEAD' && req.headers[CSRF_HEADER] !== CSRF_VALUE) {
      throw new HttpError(403, 'Missing request header.', 'csrf')
    }

    const match = router.match(method === 'HEAD' ? 'GET' : method, url.pathname)
    if (match === null) throw new HttpError(404, 'Not found.', 'not_found')
    if (match === 'method') throw new HttpError(405, 'Method not allowed.', 'method_not_allowed')
    ctx.params = match.params
    const result = await match.handler(ctx)
    if (res.headersSent || res.writableEnded) return
    if (result === undefined) {
      res.statusCode = 204
      res.setHeader('Cache-Control', 'no-store')
      res.end()
    } else {
      sendJson(res, 200, result)
    }
  } catch (e) {
    if (res.headersSent) {
      res.destroy()
      return
    }
    if (e instanceof HttpError) {
      sendJson(res, e.status, { error: e.code, message: e.message })
    } else {
      console.error(e)
      sendJson(res, 500, { error: 'internal', message: 'Something went wrong on the server.' })
    }
  }
}

/** The session token a request presents, and how. */
export function presentedToken(services: Services, ctx: Ctx): { token: string; transport: 'cookie' | 'bearer' } | null {
  const auth = ctx.req.headers.authorization
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return { token: auth.slice(7).trim(), transport: 'bearer' }
  const cookie = parseCookies(ctx.req.headers.cookie)[cookieName(ctx.secure || !services.config.allowHttp)]
  return cookie ? { token: cookie, transport: 'cookie' } : null
}

function authenticate(services: Services, ctx: Ctx, guard: Guard): AuthedCtx {
  const presented = presentedToken(services, ctx)
  const session = presented ? findSession(services.db, presented.token, presented.transport, services.now()) : null
  if (!session) throw new HttpError(401, 'Please sign in.', 'unauthenticated')
  const allowed = guard.stages ?? ['full']
  if (!allowed.includes(session.stage)) {
    throw new HttpError(403, 'Finish signing in first.', `stage_${session.stage}`)
  }
  const user = getUser(services.db, session.userId)
  if (!user || user.disabled) throw new HttpError(401, 'Please sign in.', 'unauthenticated')
  if (guard.admin && user.role !== 'admin') throw new HttpError(403, 'Only a parent can do that.', 'forbidden')
  return Object.assign(ctx, { session, user })
}
