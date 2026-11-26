// The Android app's web layer in a phone-sized browser, against a real
// server: connect, password and code, register the phone's key, unlock by
// signing a challenge, lock and unlock again, sign the phone out.
//
// The fingerprint-bound keystore key is replaced by a WebCrypto key in this
// build only (FAMILY_HUB_FAKE_DEVICE=1 → dist-e2e); release builds never
// contain it. The native side is covered by the APK build in CI.
//
//   npm run e2e -w @family-hub/mobile   (builds first)
import { spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { documentChecks } from '../../web/e2e/documents.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '..')
const repo = resolve(app, '../..')
const out = resolve(app, 'test-results')
mkdirSync(out, { recursive: true })

const build = spawnSync(process.execPath, [join(repo, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: app, env: { ...process.env, FAMILY_HUB_FAKE_DEVICE: '1' }, stdio: 'inherit' })
if (build.status !== 0) process.exit(1)

function totp(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const bytes = []
  for (const ch of secret) {
    value = ((value << 5) | alphabet.indexOf(ch)) & 0xffff
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)))
  const mac = createHmac('sha1', Buffer.from(bytes)).update(msg).digest()
  const o = mac[mac.length - 1] & 15
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0')
}
const freePort = () =>
  new Promise((res) => {
    const s = netServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })

// The app's files, as Capacitor would serve them.
const appPort = await freePort()
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }
const files = createServer((req, res) => {
  const path = join(app, 'dist-e2e', decodeURIComponent(new URL(req.url, 'http://x').pathname))
  const file = existsSync(path) && statSync(path).isFile() ? path : join(app, 'dist-e2e', 'index.html')
  res.setHeader('Content-Type', types[extname(file)] ?? 'application/octet-stream')
  createReadStream(file).pipe(res)
}).listen(appPort, '127.0.0.1')
const appOrigin = `http://localhost:${appPort}`

const data = mkdtempSync(join(tmpdir(), 'family-hub-mobile-e2e-'))
const port = await freePort()
const server = spawn(process.execPath, ['apps/server/src/main.ts'], {
  cwd: repo,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', FAMILY_HUB_DATA: data, FAMILY_HUB_KEY_FILE: join(data + '-key', 'server.key'), FAMILY_HUB_APP_ORIGINS: appOrigin },
  stdio: ['ignore', 'inherit', 'inherit'],
})
const base = `http://localhost:${port}`
for (let i = 0; ; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break
  } catch {}
  if (i > 50) throw new Error('server did not start')
  await new Promise((r) => setTimeout(r, 100))
}

// The family exists already (set up in a browser); its admin has an authenticator.
const call = async (path, body, token) => {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'family-hub', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`)
  return res.json()
}
const setup = await call('/api/setup', { familyName: 'The Testers', username: 'alex', displayName: 'Alex Tester', password: 'correct horse battery staple', client: 'app' })
const { secret } = await call('/api/auth/totp/setup', {}, setup.token)
await call('/api/auth/totp/confirm', { code: totp(secret) }, setup.token)
// A fresh step, so the phone's code is not the one just used.
await new Promise((r) => setTimeout(r, 30000 - (Date.now() % 30000) + 200))

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
let failed = false
try {
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, geolocation: { latitude: -33.9249, longitude: 18.4241, accuracy: 20 }, permissions: ['geolocation'] })).newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const shot = (name) => page.screenshot({ path: join(out, `${name}.png`) })

  await page.goto(appOrigin)
  await page.getByRole('heading', { name: 'Connect to your hub' }).waitFor()
  await page.getByLabel('Server address').fill('http://192.168.1.5:8080')
  await page.getByRole('button', { name: 'Connect' }).click()
  await page.getByText('must start with https://').waitFor()
  await page.getByLabel('Server address').fill(base)
  await page.getByRole('button', { name: 'Connect' }).click()

  await page.getByRole('heading', { name: 'Sign in' }).waitFor()
  await page.getByLabel('Username').fill('alex')
  await page.getByLabel('Password').fill('correct horse battery staple')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('heading', { name: 'Two-factor sign-in' }).waitFor()
  await page.getByLabel('Code').fill(totp(secret))
  await page.getByRole('button', { name: 'Sign in' }).click()

  // Biometric unlock is required before the hub opens.
  await page.getByRole('heading', { name: 'Fingerprint or face unlock' }).waitFor()
  await shot('01-register')
  await page.getByLabel('Name for this phone').fill('Test phone')
  await page.getByRole('button', { name: 'Turn on fingerprint unlock' }).click()
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening), Alex/ }).waitFor()
  await shot('02-home')

  // File operations reuse this unlocked session; no extra device challenge.
  await page.getByRole('link', { name: 'Files', exact: true }).click()
  await page.getByRole('heading', { name: 'No documents yet' }).waitFor()
  let challenges = 0
  page.on('request', (req) => { if (req.url().endsWith('/api/devices/challenge')) challenges++ })
  await page.getByLabel('Choose documents').setInputFiles({ name: 'Phone.txt', mimeType: 'text/plain', buffer: Buffer.from('From the phone') })
  await page.getByText('1 document uploaded.').waitFor()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download Phone.txt', exact: true }).click()])
  if (download.suggestedFilename() !== 'Phone.txt' || challenges !== 0) throw new Error('file access requested an extra unlock or lost its filename')
  await documentChecks(page, shot)
  if (challenges !== 0) throw new Error('document operations requested an extra device unlock')

  // Lock, then unlock with the key again.
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByText('This phone', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Lock now' }).click()
  await page.getByRole('heading', { name: 'Family Hub is locked' }).waitFor()
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening), Alex/ }).waitFor()

  // A reload forgets the session (it is only in memory) but not the phone.
  await page.reload()
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening), Alex/ }).waitFor()

  // The family vault, set up on the phone: its keystore key (a WebCrypto
  // stand-in here) holds the family key.
  await page.getByRole('link', { name: 'Settings' }).click()
  const vaultCard = page.locator('section', { has: page.getByRole('heading', { name: 'Family vault' }) })
  await vaultCard.getByRole('button', { name: 'Set up the family vault' }).click()
  await page.getByLabel('I have saved the recovery key in my password manager').check()
  await vaultCard.getByRole('button', { name: 'Create the vault on this phone' }).click()
  await vaultCard.getByText('Open on this device').waitFor()
  await vaultCard.getByText('This phone', { exact: true }).waitFor()
  await shot('03-vault')
  // Locking the app locks the vault; the unlock that opens the app opens it again.
  await page.getByRole('button', { name: 'Lock now' }).last().click()
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening), Alex/ }).waitFor()
  await page.getByRole('link', { name: 'Settings' }).click()
  await vaultCard.getByText('Open on this device').waitFor()

  // Health on the phone keeps an offline emergency card: updated while the
  // vault is open, opened by fingerprint from the locked screen with no signal.
  await page.getByRole('link', { name: 'Quick Info', exact: true }).click()
  await page.getByRole('button', { name: 'Add a person' }).click()
  await page.getByRole('dialog').getByRole('button', { name: /^Alex/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  // On the phone, Health is on the home page's grid.
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await page.locator('a.module-card', { hasText: 'Health' }).click()
  await page.getByRole('button', { name: 'Add an allergy' }).waitFor()
  await page.waitForFunction(() => !!localStorage.getItem('familyhub.emergencyCard'))
  const cardBefore = await page.evaluate(() => localStorage.getItem('familyhub.emergencyCard'))
  await page.getByRole('button', { name: 'Add an allergy' }).click()
  await page.getByRole('dialog').getByLabel('Allergic to').fill('Peanuts')
  await page.getByRole('dialog').getByLabel('How severe').selectOption('anaphylaxis')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await page.getByText('Severe allergies:').waitFor()
  await page.waitForFunction((before) => localStorage.getItem('familyhub.emergencyCard') !== before, cardBefore)
  if ((await page.evaluate(() => localStorage.getItem('familyhub.emergencyCard'))).includes('Peanuts')) throw new Error('the emergency card is stored unencrypted')
  // In the app: the card opens from Health.
  await page.getByRole('button', { name: 'Emergency card' }).click()
  await page.getByRole('dialog', { name: 'Emergency card' }).getByText('Peanuts', { exact: false }).waitFor()
  await page.getByRole('button', { name: 'Close the emergency card' }).click()
  // Locked and offline: unlocking cannot reach the server, but the card opens.
  await page.context().setOffline(true)
  await page.getByRole('link', { name: 'Settings' }).click()
  await page.getByRole('button', { name: 'Lock now' }).first().click()
  await page.getByRole('heading', { name: 'Family Hub is locked' }).waitFor()
  await page.getByRole('button', { name: 'Emergency card' }).click()
  const card = page.getByRole('dialog', { name: 'Emergency card' })
  await card.getByText('Severe allergies').waitFor()
  await card.getByText('Peanuts', { exact: false }).waitFor()
  await shot('04-emergency-card')
  await page.getByRole('button', { name: 'Close the emergency card' }).click()
  await page.context().setOffline(false)
  await page.getByRole('button', { name: 'Unlock' }).click()
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening), Alex/ }).waitFor()

  // SOS: the red screen over everything, the first location sent at once, ended with a reason.
  await page.getByRole('link', { name: 'Home', exact: true }).click()
  await page.getByRole('button', { name: 'SOS', exact: true }).click()
  const sos = page.getByRole('alertdialog', { name: 'SOS' })
  await sos.getByText('Your family has been alerted.').waitFor()
  await sos.getByText(/last sent just now/).waitFor()
  await shot('05-sos')
  await sos.getByRole('button', { name: 'End the SOS' }).click()
  await sos.getByRole('button', { name: 'Whoops: sent by mistake' }).click()
  await sos.waitFor({ state: 'detached' })
  const safety = page.locator('section.card', { has: page.getByRole('heading', { name: 'Safety' }) })
  await safety.getByText('Your SOS ended').waitFor()
  await safety.getByText(': Whoops: sent by mistake').waitFor()
  await safety.getByText(/Last location .*-33\.92490, 18\.42410/).waitFor()

  // Signing the phone out removes it.
  await page.getByRole('link', { name: 'Settings' }).click()
  page.once('dialog', (d) => d.accept())
  await page.getByRole('button', { name: 'Sign this phone out' }).click()
  await page.getByRole('heading', { name: 'Sign in' }).waitFor()
  if (await page.evaluate(() => localStorage.getItem('familyhub.emergencyCard'))) throw new Error('the emergency card stayed on a signed-out phone')

  if (errors.length) throw new Error(`errors in the page:\n${errors.join('\n')}`)
  console.log('mobile e2e: passed')
} catch (e) {
  failed = true
  console.error(e)
  for (const [i, p] of browser.contexts().flatMap((c) => c.pages()).entries()) {
    await p.screenshot({ path: join(out, `failure-${i}.png`) }).catch(() => {})
  }
} finally {
  await browser.close()
  await new Promise((resolve) => { server.once('exit', resolve); server.kill() })
  files.close()
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(data + '-key', { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
