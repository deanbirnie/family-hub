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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

  // The family vault. Chromium's virtual authenticator stands in for a passkey
  // (with the PRF extension, which is what unwraps the family key).
  const authenticator = async (p) => {
    const cdp = await p.context().newCDPSession(p)
    await cdp.send('WebAuthn.enable')
    await cdp.send('WebAuthn.addVirtualAuthenticator', {
      options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, hasPrf: true, automaticPresenceSimulation: true },
    })
  }
  await authenticator(page)
  await page.goto(`${base}/settings`)
  const vaultCard = page.locator('section', { has: page.getByRole('heading', { name: 'Family vault' }) })
  await vaultCard.getByRole('button', { name: 'Set up the family vault' }).click()
  const recoveryKey = (await page.getByLabel('Recovery key', { exact: true }).textContent()).trim()
  if (!/^FH1-([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/.test(recoveryKey)) throw new Error(`unexpected recovery key ${recoveryKey}`)
  await shot(page, '07b-vault-setup')
  // Not until the recovery key is confirmed saved.
  if (await vaultCard.getByRole('button', { name: 'Create the vault and add a passkey' }).isEnabled()) throw new Error('the vault can be created before saving the recovery key')
  await page.getByLabel('I have saved the recovery key in my password manager').check()
  await vaultCard.getByRole('button', { name: 'Create the vault and add a passkey' }).click()
  await vaultCard.getByText('Open on this device').waitFor()
  await vaultCard.getByText(/^Passkey: /).waitFor()
  await vaultCard.getByRole('button', { name: 'Lock now' }).click()
  await vaultCard.getByRole('button', { name: 'Open with your passkey' }).click()
  await vaultCard.getByText('Open on this device').waitFor()
  await shot(page, '07c-vault-open')

  // A second browser for the same parent gets access by pairing: a code and
  // six words that must match on both screens.
  const second = await (await browser.newContext({ viewport: { width: 1280, height: 860 }, storageState: await context.storageState() })).newPage()
  second.on('pageerror', (e) => errors.push(e.message))
  await second.goto(`${base}/settings`)
  const secondVault = second.locator('section', { has: second.getByRole('heading', { name: 'Family vault' }) })
  await secondVault.getByText('Locked', { exact: true }).waitFor()
  await secondVault.getByRole('button', { name: 'Get access from another device' }).click()
  const pairingCode = (await second.getByLabel('Pairing code').textContent()).trim()
  const newDeviceWords = (await second.getByLabel('Check words').textContent()).trim()
  await shot(second, '07d-vault-pair-request')
  await vaultCard.getByRole('button', { name: 'Approve a new device' }).click()
  await page.getByLabel('Code shown on the new device').fill(pairingCode.toLowerCase())
  await vaultCard.getByRole('button', { name: 'Continue' }).click()
  const approverWords = (await page.getByLabel('Check words').textContent()).trim()
  if (approverWords !== newDeviceWords) throw new Error(`check words differ: ${approverWords} / ${newDeviceWords}`)
  await shot(page, '07e-vault-approve')
  await vaultCard.getByRole('button', { name: 'The words match: approve' }).click()
  await vaultCard.getByText('Approved. The other device can now open the family vault.').waitFor()
  await vaultCard.getByRole('button', { name: 'Done' }).click()
  await secondVault.getByText('Open on this device').waitFor({ timeout: 15000 })

  // Locked again, the second browser opens the vault with the recovery key
  // (and a fresh authenticator code).
  await secondVault.getByRole('button', { name: 'Lock now' }).click()
  await secondVault.getByRole('button', { name: 'Use the recovery key' }).click()
  await secondVault.getByLabel('Recovery key', { exact: true }).fill(recoveryKey.toLowerCase())
  await secondVault.getByLabel('Code from your authenticator app').fill(await nextCode(secret))
  await secondVault.getByRole('button', { name: 'Open the vault' }).click()
  await secondVault.getByText('Open on this device').waitFor()
  await second.context().close()

  // Members never see the vault.
  await sam.goto(`${base}/settings`)
  await sam.getByRole('heading', { name: 'Where you’re signed in' }).waitFor()
  if (await sam.getByRole('heading', { name: 'Family vault' }).count()) throw new Error('a member sees the family vault')

  // Quick Info, in the open vault: records are encrypted on the device.
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Quick Info' }).click()
  await page.getByRole('heading', { name: 'Quick Info' }).waitFor()
  await page.getByRole('button', { name: 'Add a person' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Alex Tester' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click()
  const alexCard = page.locator('section.card', { has: page.getByRole('heading', { name: 'Alex Tester' }) })
  await alexCard.getByRole('button', { name: 'Add personal details' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Full legal name').fill('Alex Quinn Tester')
  await dialog.getByLabel('South African ID number').fill('8001015009088')
  await dialog.getByText('check digit is wrong').waitFor()
  await dialog.getByLabel('South African ID number').fill('8001015009087')
  if ((await dialog.getByLabel('Date of birth').inputValue()) !== '1980-01-01') throw new Error('date of birth not filled from the ID number')
  await dialog.getByRole('button', { name: 'Save' }).click()
  await alexCard.getByText('Alex Quinn Tester').waitFor()
  // Masked until tapped.
  if (await alexCard.getByText('8001015009087').count()) throw new Error('the ID number is shown unmasked')
  await alexCard.getByRole('button', { name: 'Show South African ID number' }).click()
  await alexCard.getByText('8001015009087').waitFor()
  await shot(page, '07f-quick-info')
  // The server holds only ciphertext.
  const stored = await page.evaluate(async () => (await fetch('/api/quick-info')).text())
  if (stored.includes('8001015009087') || stored.includes('Alex Quinn Tester')) throw new Error('Quick Info reached the server unencrypted')

  // Family Contacts: add, search, export, and use as an emergency contact.
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Contacts' }).click()
  await page.getByRole('heading', { name: 'Contacts', exact: true }).waitFor()
  await page.getByRole('button', { name: 'Add contact' }).click()
  const contactDialog = page.getByRole('dialog')
  await contactDialog.getByLabel('Name').fill('Gran Tester')
  await contactDialog.getByLabel('Phone 1', { exact: true }).fill('+27 82 555 0101')
  await contactDialog.getByLabel('Shared note').fill('Spare key is with her')
  await contactDialog.getByRole('button', { name: 'Save' }).click()
  await page.getByRole('button', { name: 'Edit Gran Tester' }).waitFor()
  await page.getByLabel('Search contacts').fill('0101')
  await page.getByRole('link', { name: 'Call Gran Tester (Mobile)' }).waitFor()
  await shot(page, '07g-contacts')
  await page.getByRole('button', { name: 'Export' }).click()
  const [vcf] = await Promise.all([page.waitForEvent('download'), page.getByRole('dialog').getByRole('button', { name: 'Save file' }).click()])
  const vcard = readFileSync(await vcf.path(), 'utf8')
  if (!vcard.includes('FN:Gran Tester') || vcard.includes('Spare key')) throw new Error(`unexpected vCard export:\n${vcard}`)
  // People and dates: Gran's birthday (year known) in five days, and a grandchild added in one step.
  const soon = new Date(Date.now() + 5 * 86_400_000)
  await page.getByRole('button', { name: 'Edit Gran Tester' }).click()
  const gran = page.getByRole('dialog')
  await gran.getByRole('button', { name: 'Add a date' }).click()
  await gran.getByLabel('Date 1: day').selectOption(String(soon.getDate()))
  await gran.getByLabel('Date 1: month').selectOption(String(soon.getMonth() + 1))
  await gran.getByLabel('Date 1: year (optional)').fill(String(soon.getFullYear() - 80))
  // A young grandchild is kept on Gran's contact (not a contact of her own).
  await gran.getByRole('button', { name: 'Add a child' }).click()
  await gran.getByLabel('Child’s name').fill('Isla Tester')
  await gran.getByLabel('I know their birthday').uncheck()
  await gran.getByRole('button', { name: 'Add child', exact: true }).click()
  await gran.getByRole('button', { name: 'Edit Isla Tester' }).waitFor()
  await gran.getByRole('button', { name: 'Save' }).click()
  await gran.waitFor({ state: 'detached' })
  const thisMonth = page.locator('section.card', { has: page.getByRole('heading', { name: 'Coming up this month' }) })
  await thisMonth.getByText('in 5 days · turns 80').waitFor()
  await shot(page, '07g2-people-dates')
  await page.getByLabel('Search contacts').fill('')
  if (await page.getByRole('button', { name: 'Edit Isla Tester' }).count()) throw new Error('a child kept on a contact shows in the main list')
  // Thandi, a full contact, linked as Gran's daughter: she shows Gran as her parent.
  await page.getByRole('button', { name: 'Add contact' }).click()
  await page.getByRole('dialog').getByLabel('Name').fill('Thandi Tester')
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.getByRole('button', { name: 'Edit Thandi Tester' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Link someone in Contacts' }).click()
  await page.getByRole('dialog').getByLabel('Who').selectOption({ label: 'Gran Tester' })
  await page.getByRole('dialog').getByLabel('Relationship').selectOption('parent')
  await page.getByRole('dialog').getByRole('button', { name: 'Link', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Gran Tester', exact: true }).waitFor()
  await page.getByRole('dialog').getByText('Parent', { exact: true }).waitFor()
  // Keeping in touch: "We spoke", a life event and a gift idea, all on her timeline.
  const thandi = page.getByRole('dialog')
  await thandi.getByRole('button', { name: 'We spoke today' }).click()
  await thandi.getByText('· in touch').waitFor()
  await thandi.getByRole('button', { name: 'Add a note or life event' }).click()
  await thandi.getByLabel('Kind of entry').selectOption('event')
  await thandi.getByLabel('Life event').selectOption('new_job')
  await thandi.getByLabel('Entry text').fill('Started at the hospital')
  await thandi.getByRole('button', { name: 'Add to timeline' }).click()
  await thandi.getByText('Started at the hospital').waitFor()
  await thandi.getByRole('button', { name: 'Add a gift idea' }).click()
  await thandi.getByLabel('Gift idea').fill('Hiking boots')
  await thandi.getByRole('button', { name: 'Add gift idea', exact: true }).click()
  await thandi.getByRole('button', { name: 'Mark Hiking boots as given' }).click()
  await thandi.getByText('Given before').waitFor()
  await shot(page, '07g3-timeline')
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).first().click()
  // Nothing readable about Gran in what the server stores is checked by the server tests; the home page lists her birthday.
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Home' }).click()
  await page.locator('section.card', { has: page.getByRole('heading', { name: 'Coming up' }) }).getByText('Gran Tester’s birthday').waitFor()
  // Import from a vCard file: a preview first, then the chosen people, with family linked by name.
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Contacts' }).click()
  await page.getByRole('button', { name: 'Import' }).click()
  const importing = page.getByRole('dialog')
  await importing.getByLabel('vCard file').setInputFiles({
    name: 'contacts.vcf',
    mimeType: 'text/vcard',
    buffer: Buffer.from(
      'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Sipho Tester\r\nBDAY:--03-15\r\nitem1.X-ABRELATEDNAMES:Thandi Tester\r\nitem1.X-ABLabel:_$!<Spouse>!$_\r\nEND:VCARD\r\n' +
        'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Gran Tester\r\nEND:VCARD\r\n',
    ),
  })
  await importing.getByText('Looks like Gran Tester').waitFor()
  await importing.getByRole('button', { name: 'Add 1 person' }).click()
  await importing.getByText('Added 1 person, and linked 1 relationship').waitFor()
  await importing.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Edit Sipho Tester' }).waitFor()
  // A group, Gran in it, and its address labels.
  await page.getByRole('button', { name: 'Groups' }).click()
  await page.getByRole('dialog').getByLabel('New group name').fill('Christmas cards')
  await page.getByRole('dialog').getByRole('button', { name: 'Add group' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Rename Christmas cards' }).waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click()
  await page.getByRole('button', { name: 'Edit Gran Tester' }).click()
  await page.getByRole('dialog').getByLabel('Christmas cards').check()
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  await page.getByRole('group', { name: 'Group' }).getByRole('button', { name: 'Christmas cards' }).click()
  if (await page.getByRole('button', { name: 'Edit Sipho Tester' }).count()) throw new Error('the group filter shows people outside the group')
  await page.getByRole('button', { name: 'Export' }).click()
  await page.getByRole('dialog').getByLabel('Who').selectOption({ label: 'Group: Christmas cards' })
  await page.getByRole('dialog').getByLabel(/Birthdays and anniversaries \(\.ics\)/).check()
  const [ics] = await Promise.all([page.waitForEvent('download'), page.getByRole('dialog').getByRole('button', { name: 'Save file' }).click()])
  const calendar = readFileSync(await ics.path(), 'utf8')
  if (!calendar.includes('SUMMARY:Gran Tester’s birthday') || calendar.includes('Sipho')) throw new Error(`unexpected calendar export:\n${calendar}`)
  await page.getByRole('group', { name: 'Group' }).getByRole('button', { name: 'Christmas cards' }).click()
  // The family calendar: a weekly event tagged to me, sent out as .ics.
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Calendar' }).click()
  await page.getByRole('heading', { name: 'Calendar', exact: true }).waitFor()
  await page.getByRole('button', { name: 'New event' }).click()
  const ev = page.getByRole('dialog')
  const tomorrow = new Date(Date.now() + 86_400_000)
  const tomorrowIso = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`
  await ev.getByLabel('Title').fill('Swimming')
  await ev.locator('#ev-start').fill(tomorrowIso)
  await ev.locator('#ev-start-time').fill('16:00')
  await ev.locator('#ev-end').fill(tomorrowIso)
  await ev.locator('#ev-end-time').fill('17:00')
  await ev.getByRole('button', { name: 'Family' }).click()
  await ev.locator('#ev-repeat').selectOption('weekly')
  await ev.getByRole('button', { name: 'Save' }).click()
  await ev.waitFor({ state: 'detached' })
  await page.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Agenda' }).click()
  await page.getByRole('button', { name: /Swimming/ }).first().click()
  await page.getByRole('dialog').getByText('Every week').waitFor()
  const [evIcs] = await Promise.all([page.waitForEvent('download'), page.getByRole('dialog').getByRole('button', { name: 'Add to my calendar' }).click()])
  const evText = readFileSync(await evIcs.path(), 'utf8')
  if (!evText.includes('SUMMARY:Swimming') || !evText.includes('RRULE:FREQ=WEEKLY')) throw new Error(`unexpected event export:\n${evText}`)
  await shot(page, '07i-calendar')
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click()
  // Importing an .ics file: its events wait in the inbox until accepted.
  const concert = new Date(Date.now() + 3 * 86_400_000)
  const concertDay = `${concert.getFullYear()}${String(concert.getMonth() + 1).padStart(2, '0')}${String(concert.getDate()).padStart(2, '0')}`
  await page.getByRole('button', { name: 'Outside calendars' }).click()
  await page.getByRole('dialog').getByLabel('Calendar file').setInputFiles({
    name: 'school.ics',
    mimeType: 'text/calendar',
    buffer: Buffer.from(`BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:concert@school\r\nDTSTART;VALUE=DATE:${concertDay}\r\nSUMMARY:School concert\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`),
  })
  await page.getByRole('dialog').getByText('1 event is waiting in the inbox').waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click()
  await page.getByRole('button', { name: 'Inbox (1)' }).click()
  await page.getByRole('dialog').getByText('School concert').waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Accept School concert' }).click()
  await page.getByRole('dialog').getByText('Nothing waiting.').waitFor()
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).last().click()
  await page.getByRole('button', { name: /School concert/ }).first().waitFor()
  const nav2 = page.getByRole('navigation', { name: 'Main' }).first()
  await nav2.getByRole('link', { name: 'Quick Info' }).click()
  await alexCard.getByRole('button', { name: 'Choose emergency contacts' }).click()
  await alexCard.getByLabel('First call').selectOption({ label: 'Gran Tester' })
  await alexCard.getByRole('button', { name: 'Save', exact: true }).click()
  await alexCard.getByRole('link', { name: 'Call Gran Tester' }).waitFor()
  // A passport expiry date becomes a reminder (only the date leaves the device) and shows under "Coming up".
  await alexCard.getByRole('button', { name: 'Add passport' }).click()
  const expiry = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)
  await page.getByRole('dialog').getByLabel('Passport number').fill('A12345678')
  await page.getByRole('dialog').getByLabel('Expiry date').fill(expiry)
  await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
  await page.getByRole('dialog').waitFor({ state: 'detached' })
  for (let i = 0; ; i++) {
    const dates = await page.evaluate(async () => (await fetch('/api/reminders/quick-info')).json())
    if (dates.dates.some((d) => d.field === 'expiry' && d.date)) {
      if (JSON.stringify(dates).includes('A12345678')) throw new Error('the passport number reached the server')
      break
    }
    if (i > 50) throw new Error(`the passport reminder was not registered: ${JSON.stringify(dates)}`)
    await page.waitForTimeout(100)
  }
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Home' }).click()
  const comingUp = page.locator('section.card', { has: page.getByRole('heading', { name: 'Coming up' }) })
  await comingUp.getByText('Passport renewal').waitFor()
  await comingUp.getByText('Alex Tester').waitFor()
  await comingUp.getByText('in 4 weeks').waitFor()
  await shot(page, '07h-coming-up')
  // Settings has the notifications card; the service worker that shows them is served.
  await page.getByRole('navigation', { name: 'Main' }).first().getByRole('link', { name: 'Settings' }).click()
  await page.locator('section.card', { has: page.getByRole('heading', { name: 'Notifications' }) }).getByText('Send date and expiry reminders from').waitFor()
  const sw = await page.evaluate(async () => {
    const r = await fetch('/sw.js')
    return { status: r.status, type: r.headers.get('content-type'), text: await r.text() }
  })
  if (sw.status !== 200 || !sw.type?.includes('javascript') || !sw.text.includes("addEventListener('push'")) throw new Error(`service worker not served: ${JSON.stringify(sw)}`)
  // Locking the vault hides it all (in-app navigation: a reload would already forget the key).
  const nav = page.getByRole('navigation', { name: 'Main' }).first()
  await nav.getByRole('link', { name: 'Settings' }).click()
  await page.locator('section', { has: page.getByRole('heading', { name: 'Family vault' }) }).getByRole('button', { name: 'Lock now' }).click()
  await nav.getByRole('link', { name: 'Quick Info' }).click()
  await page.getByRole('heading', { name: 'Family vault' }).waitFor()
  // And a reload forgets the key: the vault is locked again.
  await page.reload()
  await page.getByRole('heading', { name: 'Family vault' }).waitFor()
  if (await page.getByText('Alex Quinn Tester').count()) throw new Error('Quick Info is shown while the vault is locked')
  // Members neither see it in the menu nor can open it.
  await sam.goto(`${base}/`)
  if (await sam.getByRole('link', { name: 'Quick Info' }).count()) throw new Error('a member sees Quick Info in the menu')
  await sam.goto(`${base}/info`)
  await sam.getByText('It is kept for parents only.').waitFor()
  // But everyone sees the family calendar: tomorrow's swimming is on the home page.
  await sam.goto(`${base}/`)
  await sam.locator('section.card', { has: sam.getByRole('heading', { name: 'Today' }) }).getByText('Swimming').waitFor()

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
