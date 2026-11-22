// End-to-end check of the web app against a real server: first-run setup,
// two-factor set-up (the code is worked out here from the key the page shows,
// as an authenticator app would), the hub, inviting a member who joins and
// sets up their own two-factor sign-in, signing out and back in, and the
// phone layout.
//
//   npm run e2e -w @family-hub/web        (builds first)
//   SCREENSHOTS=1 ... also saves screenshots to apps/web/test-results
//
// Uses CHROME_PATH when set (CI), otherwise Playwright's own Chromium.
import { spawn } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { documentChecks } from './documents.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const out = resolve(here, '../test-results')
const shots = process.env.SCREENSHOTS === '1'
mkdirSync(out, { recursive: true })

// ---- an authenticator app, in a few lines ----
function base32(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const bytes = []
  for (const ch of text.replace(/\s/g, '')) {
    value = ((value << 5) | alphabet.indexOf(ch)) & 0xffff
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(bytes)
}
function totp(secret, offsetSteps = 0) {
  const counter = Math.floor(Date.now() / 30000) + offsetSteps
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', base32(secret)).update(msg).digest()
  const o = mac[mac.length - 1] & 15
  return String((mac.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0')
}
/** Waits for the next 30-second step, so a code is not the one just used. */
async function nextCode(secret) {
  const wait = 30000 - (Date.now() % 30000) + 200
  await new Promise((r) => setTimeout(r, wait))
  return totp(secret)
}

const freePort = () =>
  new Promise((res) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => res(port))
    })
  })

const data = mkdtempSync(join(tmpdir(), 'family-hub-e2e-'))
const port = await freePort()
const server = spawn(process.execPath, ['apps/server/src/main.ts'], {
  cwd: repo,
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', FAMILY_HUB_DATA: data, FAMILY_HUB_KEY_FILE: join(data + '-key', 'server.key'), FAMILY_HUB_WEB_DIR: 'apps/web/dist', FAMILY_HUB_VERSION: 'e2e' },
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

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
let failed = false
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: shots ? 2 : 1 })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  // 401s while signed out (and for the deliberately wrong password) are expected.
  page.on('console', (m) => m.type() === 'error' && !/status of 401/.test(m.text()) && errors.push(m.text()))
  const shot = async (p, name) => shots && p.screenshot({ path: join(out, `${name}.png`), fullPage: true })

  // First run: the admin.
  await page.goto(base)
  await page.getByRole('heading', { name: 'Welcome' }).waitFor()
  await shot(page, '01-setup')
  await page.getByLabel('Family name').fill('The Testers')
  await page.getByLabel('Your name').fill('Alex Tester')
  await page.getByLabel('Username').fill('alex')
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery staple')
  await page.getByLabel('Password again').fill('correct horse battery staple')
  await page.getByRole('button', { name: 'Create the family hub' }).click()

  // Two-factor set-up is required before anything else.
  await page.getByRole('heading', { name: 'Set up two-factor sign-in' }).waitFor()
  await page.getByRole('img', { name: 'QR code for your authenticator app' }).waitFor()
  await shot(page, '02-two-factor-setup')
  const secret = (await page.getByLabel('Setup key').textContent()).replace(/\s/g, '')
  await page.getByLabel('6-digit code').fill(totp(secret))
  await page.getByRole('button', { name: 'Turn on two-factor sign-in' }).click()
  await page.getByRole('heading', { name: 'Save your recovery codes' }).waitFor()
  const codes = await page.getByRole('list', { name: 'Recovery codes' }).locator('li').allTextContents()
  if (codes.length !== 10) throw new Error(`expected 10 recovery codes, got ${codes.length}`)
  await shot(page, '03-recovery-codes')
  await page.getByLabel('I have saved my recovery codes').check()
  await page.getByRole('button', { name: 'Continue' }).click()

  // The hub.
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening), Alex/ }).waitFor()
  await page.getByText('Important family documents, stored on your own server.').waitFor()
  // Parents are reminded to save the server key until one confirms it.
  await page.getByText('Save the server key to your password manager.').waitFor()
  await shot(page, '04-home')
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Files' }).click()
  await page.getByRole('heading', { name: 'No documents yet' }).waitFor()
  await page.getByLabel('Choose documents').setInputFiles({ name: 'Policy.txt', mimeType: 'text/plain', buffer: Buffer.from('Family paperwork') })
  await page.getByText('1 document uploaded.').waitFor()
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download Policy.txt', exact: true }).click()])
  if (download.suggestedFilename() !== 'Policy.txt') throw new Error('wrong document name')
  await documentChecks(page, (name) => shot(page, name))
  await shot(page, '05-files')

  // Invite a member.
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Family' }).click()
  await page.getByRole('button', { name: 'Invite someone' }).click()
  await page.getByLabel('Their name').fill('Sam Tester')
  await page.getByRole('button', { name: 'Create invite link' }).click()
  const link = (await page.locator('.dialog .secret').textContent()).trim()
  if (!link.startsWith(`${base}/invite/`)) throw new Error(`unexpected invite link ${link}`)
  await shot(page, '06-invite')
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByText('Waiting to join').waitFor()

  // The member joins in their own browser and must set up two-factor too.
  const sam = await (await browser.newContext({ viewport: { width: 1280, height: 860 } })).newPage()
  await sam.goto(link)
  await sam.getByRole('heading', { name: 'Join The Testers' }).waitFor()
  await sam.getByLabel('Username').fill('sam')
  await sam.getByLabel('Password', { exact: true }).fill('another long passphrase')
  await sam.getByLabel('Password again').fill('another long passphrase')
  await sam.getByRole('button', { name: 'Join' }).click()
  await sam.getByRole('heading', { name: 'Set up two-factor sign-in' }).waitFor()
  const samSecret = (await sam.getByLabel('Setup key').textContent()).replace(/\s/g, '')
  await sam.getByLabel('6-digit code').fill(totp(samSecret))
  await sam.getByRole('button', { name: 'Turn on two-factor sign-in' }).click()
  await sam.getByLabel('I have saved my recovery codes').check()
  await sam.getByRole('button', { name: 'Continue' }).click()
  await sam.getByRole('heading', { name: /Good (morning|afternoon|evening), Sam/ }).waitFor()
  // Members cannot invite.
  await sam.goto(`${base}/files`)
  await sam.getByText('Policy.txt', { exact: true }).waitFor()
  await sam.getByRole('button', { name: 'Rename Policy.txt', exact: true }).click()
  await sam.getByLabel('Name', { exact: true }).fill('Shared policy.txt')
  await sam.getByRole('button', { name: 'Save', exact: true }).click()
  await sam.getByRole('dialog').waitFor({ state: 'hidden' })
  await sam.getByRole('button', { name: 'Shared policy.txt', exact: true }).waitFor()
  await sam.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Family' }).click()
  await sam.getByText('Alex Tester').waitFor()
  if (await sam.getByRole('button', { name: 'Invite someone' }).count()) throw new Error('a member can see the invite button')

  // Members are not reminded about the server key.
  if (await sam.getByText('Save the server key to your password manager.').count()) throw new Error('a member sees the server key reminder')

  // The reminder leads to Settings: show the key with a fresh code, confirm it is saved.
  await page.getByRole('button', { name: 'Save it now' }).click()
  await page.getByRole('heading', { name: 'Server key' }).waitFor()
  await page.getByLabel('Enter a code from your authenticator app to show the key').fill(await nextCode(secret))
  await page.getByRole('button', { name: 'Show the key' }).click()
  const shownKey = (await page.getByLabel('Server key').textContent()).trim()
  if (!/^[A-Za-z0-9+/]{43}=$/.test(shownKey)) throw new Error(`unexpected server key ${shownKey}`)
  await shot(page, '07a-server-key')
  await page.getByRole('button', { name: 'I’ve saved it in my password manager' }).click()
  await page.getByText('Saved', { exact: true }).waitFor()
  await page.goto(base)
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening), Alex/ }).waitFor()
  if (await page.getByText('Save the server key to your password manager.').count()) throw new Error('the server key reminder is still shown after saving')

  // Settings, then sign out and back in with password and a fresh code.
  await page.goto(`${base}/settings`)
  await page.getByRole('heading', { name: 'Where you’re signed in' }).waitFor()
  await page.getByText('This one', { exact: true }).waitFor()
  await shot(page, '07-settings')
  await page.getByRole('button', { name: 'Sign out' }).first().click()
  await page.getByRole('heading', { name: 'Sign in' }).waitFor()
  await page.getByLabel('Username').fill('alex')
  await page.getByLabel('Password').fill('wrong password here')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByText('Wrong username or password.').waitFor()
  await page.getByLabel('Password').fill('correct horse battery staple')
  await page.getByRole('button', { name: 'Continue' }).click()
  await page.getByRole('heading', { name: 'Two-factor sign-in' }).waitFor()
  await shot(page, '08-code')
  await page.getByLabel('Code').fill(await nextCode(secret))
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening), Alex/ }).waitFor()

  // Phone-sized layout: bottom navigation instead of the sidebar.
  const phone = page
  await phone.setViewportSize({ width: 390, height: 844 })
  await phone.goto(base)
  await phone.getByRole('heading', { name: /Good (morning|afternoon|evening), Alex/ }).waitFor()
  if (!(await phone.locator('.bottom-nav').isVisible())) throw new Error('no bottom navigation on a phone-sized screen')
  await shot(phone, '09-phone-home')

  if (errors.length) throw new Error(`errors in the page:\n${errors.join('\n')}`)
  console.log('web e2e: passed')
} catch (e) {
  failed = true
  console.error(e)
  for (const [i, p] of browser.contexts().flatMap((c) => c.pages()).entries()) {
    await p.screenshot({ path: join(out, `failure-${i}.png`), fullPage: true }).catch(() => {})
  }
} finally {
  await browser.close()
  await new Promise((resolve) => { server.once('exit', resolve); server.kill() })
  rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  rmSync(data + '-key', { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
