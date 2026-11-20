/**
 * Just enough HTTP plumbing for the API, on node:http: a router with
 * `:param` segments, JSON bodies with a size limit, cookies, and the security
 * headers every response carries.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, message: string, code = 'error') {
    super(message)
    this.status = status
    this.code = code
  }
}

export interface Ctx {
  req: IncomingMessage
  res: ServerResponse
  method: string
  url: URL
  params: Record<string, string>
  /** The client's address (after trusted proxies). */
  ip: string
  /** Whether the client reached us over https (directly or through a trusted proxy). */
  secure: boolean
}

/** A handler's return value is sent as JSON; `undefined` sends 204 No Content. */
export type Handler<C extends Ctx = Ctx> = (ctx: C) => unknown

interface Route {
  method: string
  parts: string[]
  handler: Handler
}

export class Router {
  private routes: Route[] = []

  add(method: string, path: string, handler: Handler): void {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler })
  }

  /** The handler for a request, with its parameters; `null` if no path matches; 'method' if only the method is wrong. */
  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null | 'method' {
    const parts = pathname.split('/').filter(Boolean)
    let pathMatched = false
    for (const route of this.routes) {
      if (route.parts.length !== parts.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let i = 0; i < parts.length; i++) {
        const want = route.parts[i]!
        const got = parts[i]!
        if (want.startsWith(':')) {
          try {
            params[want.slice(1)] = decodeURIComponent(got)
          } catch {
            ok = false
            break
          }
        } else if (want !== got) {
          ok = false
          break
        }
      }
      if (!ok) continue
      pathMatched = true
      if (route.method === method) return { handler: route.handler, params }
    }
    return pathMatched ? 'method' : null
  }
}

export const JSON_LIMIT = 64 * 1024

/** Reads a JSON object body (at most `limit` bytes). */
export async function readJson(req: IncomingMessage, limit = JSON_LIMIT): Promise<Record<string, unknown>> {
  const type = req.headers['content-type'] ?? ''
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'Send JSON.', 'unsupported_media_type')
  const declared = Number(req.headers['content-length'] ?? 0)
  if (declared > limit) throw new HttpError(413, 'The request is too large.', 'too_large')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'The request is too large.', 'too_large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  let data: unknown
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new HttpError(400, 'The request is not valid JSON.', 'bad_json')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpError(400, 'Send a JSON object.', 'bad_json')
  }
  return data as Record<string, unknown>
}

/** A required string field, trimmed, of bounded length. */
export function str(body: Record<string, unknown>, key: string, opts: { max?: number; min?: number; trim?: boolean } = {}): string {
  const raw = body[key]
  if (typeof raw !== 'string') throw new HttpError(400, `"${key}" is required.`, 'invalid')
  const value = opts.trim === false ? raw : raw.trim()
  if (value.length < (opts.min ?? 1)) throw new HttpError(400, `"${key}" is required.`, 'invalid')
  if (value.length > (opts.max ?? 200)) throw new HttpError(400, `"${key}" is too long.`, 'invalid')
  return value
}

export function optStr(body: Record<string, unknown>, key: string, max = 200): string | undefined {
  if (body[key] === undefined || body[key] === null) return undefined
  return str(body, key, { max, min: 0 })
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    if (!name || name in out) continue
    out[name] = part.slice(i + 1).trim()
  }
  return out
}

export function appendHeader(res: ServerResponse, name: string, value: string): void {
  const existing = res.getHeader(name)
  if (existing === undefined) res.setHeader(name, value)
  else res.setHeader(name, [...(Array.isArray(existing) ? existing : [String(existing)]), value])
}

/** Headers every response carries. */
export function securityHeaders(res: ServerResponse, secure: boolean): void {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()')
  if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000')
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Content-Length', Buffer.byteLength(data))
  res.end(data)
}

/** The client address: the socket's, or the one the trusted proxies report. */
export function clientIp(req: IncomingMessage, trustProxyHops: number): string {
  const socket = req.socket.remoteAddress ?? ''
  if (trustProxyHops <= 0) return socket
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  // Each trusted proxy appends the address it saw; anything further left
  // could have been written by the client itself.
  return forwarded[forwarded.length - trustProxyHops] ?? forwarded[0] ?? socket
}

export function isSecure(req: IncomingMessage, trustProxyHops: number): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true
  if (trustProxyHops <= 0) return false
  const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',').pop()?.trim().toLowerCase()
  return proto === 'https'
}
