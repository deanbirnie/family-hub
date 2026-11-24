import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TLSSocket } from 'node:tls'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { buildMessage, mailConfigFromEnv, sendMail, type MailConfig } from '../src/mail.ts'

/** A tiny SMTP server that records what it is told; `refuse` makes it reject a command. */
function fakeSmtp(opts: { auth?: 'PLAIN' | 'LOGIN'; refuse?: string; tls?: { key: string; cert: string } } = {}) {
  const seen: { commands: string[]; data: string; secure: boolean } = { commands: [], data: '', secure: false }
  const server: Server = createServer((plain: Socket) => {
    let inData = false
    let buffer = ''
    let socket: Socket = plain
    seen.secure = false
    plain.write('220 test ESMTP\r\n')
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let i
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i)
        buffer = buffer.slice(i + 2)
        if (inData) {
          if (line === '.') {
            inData = false
            socket.write('250 queued\r\n')
          } else seen.data += `${line}\r\n`
          continue
        }
        seen.commands.push(line)
        const verb = line.split(' ')[0]!.toUpperCase()
        if (opts.refuse && line.startsWith(opts.refuse)) socket.write('535 5.7.8 Username and Password not accepted\r\n')
        else if (verb === 'EHLO') socket.write(`250-test\r\n${opts.tls && !seen.secure ? '250-STARTTLS\r\n' : ''}250-AUTH ${opts.auth ?? 'PLAIN'}\r\n250 SIZE 1000000\r\n`)
        else if (verb === 'STARTTLS' && opts.tls) {
          socket.write('220 go ahead\r\n')
          plain.removeListener('data', onData)
          const secure = new TLSSocket(plain, { isServer: true, key: opts.tls.key, cert: opts.tls.cert })
          secure.on('data', onData)
          socket = secure
          seen.secure = true
        }
        else if (verb === 'AUTH' && line.includes('LOGIN')) socket.write('334 VXNlcm5hbWU6\r\n')
        else if (verb === 'AUTH') socket.write('235 ok\r\n')
        else if (verb === 'DATA') {
          inData = true
          socket.write('354 go\r\n')
        } else if (verb === 'QUIT') {
          socket.write('221 bye\r\n')
          socket.end()
        } else if (/^[A-Za-z0-9+/=]+$/.test(line) && seen.commands.some((c) => c === 'AUTH LOGIN')) {
          // The username, then the password, of AUTH LOGIN.
          socket.write(seen.commands.filter((c) => /^[A-Za-z0-9+/=]+$/.test(c)).length === 1 ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n')
        } else socket.write('250 ok\r\n')
      }
    }
    plain.on('data', onData)
  })
  return {
    seen,
    server,
    start: () => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))),
  }
}

let running: Server | null = null
afterEach(() => {
  running?.close()
  running = null
})

const config = (port: number): MailConfig => ({ host: '127.0.0.1', port, security: 'none', user: 'hub@example.com', password: 'app password 123', from: 'hub@example.com', fromName: 'Family Hub' })

describe('email from the hub', () => {
  it('signs in and sends a message with an attachment', async () => {
    const smtp = fakeSmtp()
    running = smtp.server
    const port = await smtp.start()
    await sendMail(config(port), {
      to: ['gran@example.org', 'uncle@example.net'],
      subject: 'Für die Familie – test',
      text: 'Hello\n.\nA line with a dot',
      attachments: [{ filename: 'pack.pdf', contentType: 'application/pdf', content: new Uint8Array([37, 80, 68, 70]) }],
    })
    expect(smtp.seen.commands[0]).toBe('EHLO example.com')
    expect(smtp.seen.commands[1]).toBe(`AUTH PLAIN ${Buffer.from('\0hub@example.com\0app password 123').toString('base64')}`)
    expect(smtp.seen.commands.slice(2, 6)).toEqual(['MAIL FROM:<hub@example.com>', 'RCPT TO:<gran@example.org>', 'RCPT TO:<uncle@example.net>', 'DATA'])
    expect(smtp.seen.data).toContain('Subject: =?UTF-8?B?')
    expect(smtp.seen.data).toContain('Content-Disposition: attachment; filename="pack.pdf"')
    expect(smtp.seen.data).toContain(Buffer.from([37, 80, 68, 70]).toString('base64'))
    const text = /charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([A-Za-z0-9+/=\r\n]+?)\r\n--/.exec(smtp.seen.data)![1]!
    expect(Buffer.from(text.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Hello\r\n.\r\nA line with a dot')
  })

  it('signs in with LOGIN when PLAIN is not offered, and never repeats the password in an error', async () => {
    const smtp = fakeSmtp({ auth: 'LOGIN' })
    running = smtp.server
    await sendMail(config(await smtp.start()), { to: ['gran@example.org'], subject: 'Hi', text: 'Hi' })
    expect(smtp.seen.commands.slice(1, 4)).toEqual(['AUTH LOGIN', Buffer.from('hub@example.com').toString('base64'), Buffer.from('app password 123').toString('base64')])

    const refusing = fakeSmtp({ refuse: 'AUTH' })
    running.close()
    running = refusing.server
    const error = await sendMail(config(await refusing.start()), { to: ['gran@example.org'], subject: 'Hi', text: 'Hi' }).catch((e: Error) => e)
    expect(String(error)).toContain('Signing in was refused by the mail server: 535')
    expect(String(error)).not.toContain(Buffer.from('app password 123').toString('base64').slice(0, 10))
  })

  it('upgrades to TLS with STARTTLS before signing in, checking the certificate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smtp-tls-'))
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 'key.pem'), '-out', join(dir, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' })
      const tls = { key: readFileSync(join(dir, 'key.pem'), 'utf8'), cert: readFileSync(join(dir, 'cert.pem'), 'utf8') }
      const smtp = fakeSmtp({ tls })
      running = smtp.server
      const port = await smtp.start()
      await sendMail({ ...config(port), host: 'localhost', security: 'starttls', ca: tls.cert }, { to: ['gran@example.org'], subject: 'Hi', text: 'Hi' })
      expect(smtp.seen.commands.slice(0, 3)).toEqual(['EHLO example.com', 'STARTTLS', 'EHLO example.com'])
      expect(smtp.seen.commands[3]).toMatch(/^AUTH PLAIN /)
      expect(smtp.seen.secure).toBe(true)
      // A certificate it cannot trust: nothing is sent, not even the password.
      const before = smtp.seen.commands.length
      await expect(sendMail({ ...config(port), host: 'localhost', security: 'starttls' }, { to: ['gran@example.org'], subject: 'Hi', text: 'Hi' })).rejects.toThrow()
      expect(smtp.seen.commands.slice(before)).toEqual(['EHLO example.com', 'STARTTLS'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps headers from being broken into', () => {
    const msg = buildMessage({ from: 'hub@example.com', fromName: 'Hub' }, { to: ['a@example.com'], subject: 'Hi\r\nBcc: evil@example.com', text: 'x' })
    expect(msg).not.toMatch(/\r\nBcc:/)
    expect(() => buildMessage({ from: 'hub@example.com', fromName: 'Hub' }, { to: ['a@example.com>\r\nRCPT TO:<b@example.com'], subject: 'x', text: 'x' })).toThrow()
  })

  it('reads its settings, and refuses unencrypted mail to another machine', () => {
    expect(mailConfigFromEnv({})).toBeNull()
    expect(mailConfigFromEnv({ FAMILY_HUB_SMTP_HOST: 'smtp.gmail.com', FAMILY_HUB_SMTP_USER: 'us@gmail.com', FAMILY_HUB_SMTP_PASSWORD: 'abcd efgh' })).toMatchObject({ port: 465, security: 'tls', from: 'us@gmail.com', fromName: 'Family Hub' })
    expect(mailConfigFromEnv({ FAMILY_HUB_SMTP_HOST: 'smtp.gmail.com', FAMILY_HUB_SMTP_PORT: '587', FAMILY_HUB_SMTP_USER: 'us@gmail.com', FAMILY_HUB_SMTP_PASSWORD: 'x' })!.security).toBe('starttls')
    expect(() => mailConfigFromEnv({ FAMILY_HUB_SMTP_HOST: 'smtp.gmail.com', FAMILY_HUB_SMTP_USER: 'us@gmail.com' })).toThrow(/PASSWORD/)
    expect(() => mailConfigFromEnv({ FAMILY_HUB_SMTP_HOST: 'mail.example.com', FAMILY_HUB_SMTP_SECURITY: 'none', FAMILY_HUB_SMTP_FROM: 'a@example.com' })).toThrow(/only allowed to this machine/)
  })
})
