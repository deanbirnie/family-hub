import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { Report } from '../src/pdf/writer.ts'

async function open(bytes: Uint8Array, password?: string): Promise<string> {
  const pdf = await getDocument({ data: bytes.slice(), password, useSystemFonts: false }).promise
  let text = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent()
    text += content.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n'
  }
  const meta = await pdf.getMetadata()
  return `${(meta.info as { Title?: string }).Title ?? ''}\n${text.replace(/\s+/g, ' ')}`
}

function pack(): Report {
  const r = new Report({ title: 'Emergency pack – The Testers', author: 'Alex', header: 'The Testers · private' })
  r.title('In case of emergency', 'For the guardians')
  r.paragraph('Sam is allergic to penicillin. School: Little Acorns.')
  for (let i = 0; i < 80; i++) r.paragraph(`Line ${i} of the instructions, long enough to fill pages.`)
  return r
}

describe('locking a PDF with a password (AES-256)', () => {
  it('opens with the password, and only with it; nothing is readable without it', async () => {
    const bytes = await pack().finishLocked('The Testers · emergency pack', 'k7mq-xy2p-a9bc-ddef-ghjk')
    const raw = new TextDecoder('latin1').decode(bytes)
    expect(raw.startsWith('%PDF-1.7')).toBe(true)
    expect(raw).toContain('/V 5 /R 6')
    for (const w of ['penicillin', 'Acorns', 'Emergency pack', 'Alex', 'In case of']) expect(raw).not.toContain(w)

    const text = await open(bytes, 'k7mq-xy2p-a9bc-ddef-ghjk')
    expect(text).toContain('Emergency pack – The Testers')
    expect(text).toContain('Sam is allergic to penicillin.')
    expect(text).toContain('Line 79 of the instructions')
    expect(text).toContain('Page 2 of')

    await expect(open(bytes)).rejects.toMatchObject({ name: 'PasswordException' })
    await expect(open(bytes, 'k7mq-xy2p-a9bc-ddef-ghjX')).rejects.toMatchObject({ name: 'PasswordException' })
  })

  it('locks each file differently, even with the same password', async () => {
    const a = await pack().finishLocked('x', 'same password here')
    const b = await pack().finishLocked('x', 'same password here')
    expect(a.length === b.length && a.every((x, i) => x === b[i])).toBe(false)
  })
})
