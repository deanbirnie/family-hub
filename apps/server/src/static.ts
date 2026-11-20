/**
 * Serves the built web app. Files under /assets/ have content hashes in their
 * names and are cached for a year; everything else is revalidated. Paths that
 * are not files (the app's own routes, such as /invite/…) get index.html.
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, sep } from 'node:path'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
}

/**
 * The page's content security policy: nothing loads from anywhere but this
 * server, and no inline or injected script runs.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ')

export function serveStatic(webDir: string, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!webDir || (req.method !== 'GET' && req.method !== 'HEAD')) return false
  let file = resolveFile(webDir, pathname)
  let fallback = false
  if (!file) {
    // A missing file with an extension is a real 404, not an app route.
    if (extname(pathname)) return false
    file = join(webDir, 'index.html')
    fallback = true
    if (!existsSync(file)) return false
  }
  const ext = extname(file)
  res.setHeader('Content-Type', TYPES[ext] ?? 'application/octet-stream')
  if (pathname.startsWith('/assets/') && !fallback) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  } else {
    res.setHeader('Cache-Control', 'no-cache')
  }
  if (ext === '.html') res.setHeader('Content-Security-Policy', CSP)
  const size = statSync(file).size
  res.setHeader('Content-Length', size)
  res.statusCode = 200
  if (req.method === 'HEAD') {
    res.end()
    return true
  }
  createReadStream(file).pipe(res)
  return true
}

function resolveFile(webDir: string, pathname: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const root = normalize(webDir + sep)
  const full = normalize(join(root, decoded))
  if (!full.startsWith(root)) return null
  try {
    const st = statSync(full)
    if (st.isFile()) return full
    if (st.isDirectory()) {
      const index = join(full, 'index.html')
      if (existsSync(index)) return index
    }
  } catch {
    // not there
  }
  return null
}
