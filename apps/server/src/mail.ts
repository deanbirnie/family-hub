/**
 * Email from the hub (phase 9a), with no dependencies: a small SMTP client
 * on node:net and node:tls. It sends through an account the owner gives it
 * (for example Gmail with an app password), over TLS from the start (port
 * 465) or upgraded with STARTTLS (port 587), and signs in with AUTH PLAIN
 * or LOGIN. Plain, unencrypted SMTP is allowed only to this machine (a
 * local relay, and the tests).
 *
 * Messages are plain text in UTF-8, with attachments (the pack, in 9b).
 */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

export interface MailConfig {
  host: string
  port: number
  /** 'tls': TLS from the start (465); 'starttls': upgraded (587); 'none': only to this machine. */
  security: 'tls' | 'starttls' | 'none'
  user: string
  password: string
  /** The address mail comes from; usually the account itself. */
  from: string
  /** A name shown with it, e.g. "Family Hub". */
  fromName: string
  /** Extra certificate authority to trust (tests only; never from the environment). */
  ca?: string
}

export interface Attachment {
  filename: string
  contentType: string
  content: Uint8Array
}

export interface Message {
  to: string[]
  subject: string
  text: string
  attachments?: Attachment[]
}

export interface Mailer {
  /** Whether the owner has set up an account to send from. */
  readonly configured: boolean
  /** The address mail comes from, to show the parents. */
  readonly from: string
  send(message: Message): Promise<void>
}

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]+$/
export const isEmail = (v: string) => v.length <= 254 && EMAIL.test(v)
const LOCAL = new Set(['127.0.0.1', '::1', 'localhost'])

/** Reads the mail settings from the environment; null when none are given. Throws on half-done or unsafe settings. */
export function mailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const host = env.FAMILY_HUB_SMTP_HOST?.trim()
  if (!host) return null
  const port = env.FAMILY_HUB_SMTP_PORT ? Number(env.FAMILY_HUB_SMTP_PORT) : 465
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`FAMILY_HUB_SMTP_PORT must be a port number, got "${env.FAMILY_HUB_SMTP_PORT}"`)
  const security = (env.FAMILY_HUB_SMTP_SECURITY?.trim().toLowerCase() || (port === 465 ? 'tls' : 'starttls')) as MailConfig['security']
  if (!['tls', 'starttls', 'none'].includes(security)) throw new Error(`FAMILY_HUB_SMTP_SECURITY must be tls, starttls or none, got "${security}"`)
  if (security === 'none' && !LOCAL.has(host)) throw new Error('FAMILY_HUB_SMTP_SECURITY=none is only allowed to this machine (127.0.0.1): mail must travel encrypted.')
  const user = env.FAMILY_HUB_SMTP_USER?.trim() ?? ''
  let password = env.FAMILY_HUB_SMTP_PASSWORD ?? ''
  if (env.FAMILY_HUB_SMTP_PASSWORD_FILE) password = readFileSync(env.FAMILY_HUB_SMTP_PASSWORD_FILE, 'utf8').trim()
  if (user && !password) throw new Error('FAMILY_HUB_SMTP_USER is set but there is no FAMILY_HUB_SMTP_PASSWORD (or FAMILY_HUB_SMTP_PASSWORD_FILE).')
  const from = env.FAMILY_HUB_SMTP_FROM?.trim() || user
  if (!isEmail(from)) throw new Error('FAMILY_HUB_SMTP_FROM (or FAMILY_HUB_SMTP_USER) must be the email address mail comes from.')
  const fromName = (env.FAMILY_HUB_SMTP_FROM_NAME?.trim() || 'Family Hub').replace(/[\r\n"]/g, '')
  return { host, port, security, user, password, from, fromName }
}

/** A mailer for the settings, or one that says it is not set up. */
export function createMailer(config: MailConfig | null): Mailer {
  if (!config) {
    return {
      configured: false,
      from: '',
      send: () => Promise.reject(new Error('Email is not set up: see "Email from the hub" in the owner steps.')),
    }
  }
  return { configured: true, from: config.from, send: (m) => sendMail(config, m) }
}

// ---- the message ---------------------------------------------------------------------------

const noBreaks = (v: string) => v.replace(/[\r\n]+/g, ' ')
/** A header value, as RFC 2047 UTF-8 words when it is not plain ASCII. */
const headerText = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? noBreaks(v) : `=?UTF-8?B?${Buffer.from(noBreaks(v), 'utf8').toString('base64')}?=`)
const base64Lines = (bytes: Uint8Array) => (Buffer.from(bytes).toString('base64').match(/.{1,76}/g) ?? []).join('\r\n')
const safeName = (name: string) => noBreaks(name).replace(/["\\]/g, '_')

/** The message as sent (RFC 5322 with MIME): headers, then a text part and any attachments, all base64. */
export function buildMessage(config: Pick<MailConfig, 'from' | 'fromName'>, m: Message, now = new Date()): string {
  for (const to of m.to) if (!isEmail(to)) throw new Error(`Not an email address: ${to}`)
  const domain = config.from.split('@')[1] ?? 'family-hub.local'
  const headers = [
    `From: ${headerText(config.fromName)} <${config.from}>`,
    `To: ${m.to.join(', ')}`,
    `Subject: ${headerText(m.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
  ]
  const text = base64Lines(Buffer.from(m.text.replace(/\r?\n/g, '\r\n'), 'utf8'))
  if (!m.attachments?.length) {
    return [...headers, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', text, ''].join('\r\n')
  }
  const boundary = `=_hub_${randomBytes(12).toString('hex')}`
  const parts = [
    [`--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', text].join('\r\n'),
    ...m.attachments.map((a) =>
      [`--${boundary}`, `Content-Type: ${noBreaks(a.contentType)}; name="${safeName(a.filename)}"`, 'Content-Transfer-Encoding: base64', `Content-Disposition: attachment; filename="${safeName(a.filename)}"`, '', base64Lines(a.content)].join('\r\n'),
    ),
  ]
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...parts, `--${boundary}--`, ''].join('\r\n')
}

// ---- the conversation ---------------------------------------------------------------------

const TIMEOUT = 30_000

/** One SMTP connection: send a line, read the (possibly multi-line) reply. */
class Conversation {
  private buffer = ''
  private waiting: ((reply: { code: number; text: string }) => void) | null = null
  private failed: Error | null = null
  private onFail: ((e: Error) => void) | null = null

  socket: Socket | TLSSocket

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket
    this.listen(socket)
  }

  listen(socket: Socket | TLSSocket) {
    this.socket = socket
    socket.setEncoding('utf8')
    socket.setTimeout(TIMEOUT, () => this.fail(new Error('The mail server stopped answering.')))
    socket.on('data', (chunk: string) => {
      this.buffer += chunk
      this.take()
    })
    socket.on('error', (e) => this.fail(e))
    socket.on('close', () => this.fail(new Error('The mail server closed the connection.')))
  }

  private fail(e: Error) {
    if (this.failed) return
    this.failed = e
    this.onFail?.(e)
  }

  private take() {
    // A reply ends with a line "250 text" (a space after the code); "250-text" lines continue it.
    const lines = this.buffer.split('\r\n')
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) {
        const reply = lines.slice(0, i + 1)
        this.buffer = lines.slice(i + 1).join('\r\n')
        const waiting = this.waiting
        this.waiting = null
        waiting?.({ code: Number(reply[i]!.slice(0, 3)), text: reply.map((l) => l.slice(4)).join('\n') })
        return
      }
    }
  }

  read(): Promise<{ code: number; text: string }> {
    if (this.failed) return Promise.reject(this.failed)
    return new Promise((resolve, reject) => {
      this.waiting = resolve
      this.onFail = reject
      this.take()
    })
  }

  /** Sends a command and checks the reply's code. The secret flag keeps passwords out of error messages. */
  async command(line: string, expect: number[], secret = false): Promise<{ code: number; text: string }> {
    this.socket.write(`${line}\r\n`)
    const reply = await this.read()
    if (!expect.includes(reply.code)) {
      const what = secret ? 'Signing in' : line.split(' ')[0]
      throw new Error(`${what} was refused by the mail server: ${reply.code} ${reply.text.split('\n')[0]}`)
    }
    return reply
  }
}

function open(config: MailConfig): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const s =
      config.security === 'tls'
        ? tlsConnect({ host: config.host, port: config.port, servername: config.host, ca: config.ca }, () => resolve(s))
        : netConnect({ host: config.host, port: config.port }, () => resolve(s))
    s.once('error', reject)
    s.setTimeout(TIMEOUT, () => {
      s.destroy()
      reject(new Error('Could not reach the mail server.'))
    })
  })
}

/** Sends one message. Rejects with a readable reason; never puts the password in it. */
export async function sendMail(config: MailConfig, m: Message): Promise<void> {
  const body = buildMessage(config, m)
  const socket = await open(config)
  const c = new Conversation(socket)
  try {
    const hello = `EHLO ${config.from.split('@')[1] ?? 'family-hub'}`
    const greeting = await c.read()
    if (greeting.code !== 220) throw new Error(`The mail server said: ${greeting.code} ${greeting.text}`)
    let ehlo = await c.command(hello, [250])
    if (config.security === 'starttls') {
      if (!/^STARTTLS$/im.test(ehlo.text)) throw new Error('The mail server does not offer STARTTLS, so mail would travel unencrypted.')
      await c.command('STARTTLS', [220])
      const secure = await new Promise<TLSSocket>((resolve, reject) => {
        socket.removeAllListeners('data')
        socket.removeAllListeners('close')
        socket.removeAllListeners('error')
        socket.removeAllListeners('timeout')
        const t = tlsConnect({ socket, servername: config.host, ca: config.ca }, () => resolve(t))
        t.once('error', reject)
      })
      c.listen(secure)
      ehlo = await c.command(hello, [250])
    }
    if (config.user) {
      if (/AUTH[ =][^\n]*\bPLAIN\b/i.test(ehlo.text)) {
        await c.command(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.password}`, 'utf8').toString('base64')}`, [235], true)
      } else {
        await c.command('AUTH LOGIN', [334])
        await c.command(Buffer.from(config.user, 'utf8').toString('base64'), [334], true)
        await c.command(Buffer.from(config.password, 'utf8').toString('base64'), [235], true)
      }
    }
    await c.command(`MAIL FROM:<${config.from}>`, [250])
    for (const to of m.to) await c.command(`RCPT TO:<${to}>`, [250, 251])
    await c.command('DATA', [354])
    // Dot-stuffing: a line starting with "." gets another (base64 never does, but headers might).
    await c.command(`${body.replace(/\r\n\./g, '\r\n..')}\r\n.`, [250])
    await c.command('QUIT', [221]).catch(() => undefined)
  } finally {
    c.socket.destroy()
  }
}
