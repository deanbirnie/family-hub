import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

function webDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fh-web-'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Family Hub</title>')
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'console.log(1)')
  return dir
}

describe('the web app', () => {
  it('serves the page with a strict content security policy', async () => {
    server = await startServer({ webDir: webDir() })
    const res = await fetch(`${server.url}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('Family Hub')
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('caches hashed assets for long, and the page not at all', async () => {
    server = await startServer({ webDir: webDir() })
    expect((await fetch(`${server.url}/assets/app-abc123.js`)).headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${server.url}/`)).headers.get('cache-control')).toBe('no-cache')
  })

  it('answers app routes with the page, and missing files with 404', async () => {
    server = await startServer({ webDir: webDir() })
    expect((await fetch(`${server.url}/invite/abc`)).status).toBe(200)
    expect((await fetch(`${server.url}/assets/missing.js`)).status).toBe(404)
    expect((await fetch(`${server.url}/api/nothing-here`)).status).toBe(404)
  })

  it('never serves files outside its folder', async () => {
    server = await startServer({ webDir: webDir() })
    for (const path of ['/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2f..%2fetc%2fhosts']) {
      const res = await fetch(`${server.url}${path}`)
      const text = await res.text()
      expect(text).not.toContain('root:')
      expect(text).not.toContain('localhost')
    }
  })
})
