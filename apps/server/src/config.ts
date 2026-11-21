import { resolve } from 'node:path'

/** Everything the server reads from its environment, checked once at start-up. */
export interface Config {
  port: number
  host: string
  /** Folder for the database and (later) stored files. */
  dataDir: string
  /** Built web app to serve; empty to serve the API only. */
  webDir: string
  version: string
  /**
   * Number of reverse proxies in front of the server whose X-Forwarded-For
   * and X-Forwarded-Proto can be trusted. 0 means none: the socket address is used.
   */
  trustProxyHops: number
  /**
   * Allow sign-in over plain http (cookies without the Secure flag). Only for
   * trying the server out on a home network; real use must be behind https.
   */
  allowHttp: boolean
  /** Origins allowed to call the API with a bearer token (the Android app). */
  appOrigins: string[]
  /** Maximum bytes accepted for one shared document. */
  maxFileBytes: number
}

function int(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`)
  }
  return n
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase()
  if (raw === undefined || raw === '') return fallback
  if (['1', 'true', 'yes'].includes(raw)) return true
  if (['0', 'false', 'no'].includes(raw)) return false
  throw new Error(`${name} must be true or false, got "${raw}"`)
}

export function loadConfig(): Config {
  return {
    port: int('PORT', 8080, 1, 65535),
    host: process.env.HOST || '0.0.0.0',
    dataDir: resolve(process.env.FAMILY_HUB_DATA || './data'),
    webDir: process.env.FAMILY_HUB_WEB_DIR ? resolve(process.env.FAMILY_HUB_WEB_DIR) : '',
    version: process.env.FAMILY_HUB_VERSION || 'dev',
    trustProxyHops: int('FAMILY_HUB_TRUST_PROXY', 0, 0, 10),
    allowHttp: bool('FAMILY_HUB_ALLOW_HTTP', false),
    maxFileBytes: int('FAMILY_HUB_MAX_FILE_BYTES', 100 * 1024 * 1024, 1, 2 * 1024 * 1024 * 1024),
    // Capacitor serves the Android app from https://localhost.
    appOrigins: (process.env.FAMILY_HUB_APP_ORIGINS || 'https://localhost')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  }
}
