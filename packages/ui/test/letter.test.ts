import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { makeLetter, passwordProblem, suggestPassword } from '../src/emergency/letter.ts'

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false }).promise
  let text = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent()
    text += content.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n'
  }
  return text.replace(/\s+/g, ' ')
}

const base = { family: 'The Testers', from: 'Alex and Jo', link: 'https://hub.example.com/emergency/abcDEF123_-xyz', date: '24 November 2026' }

describe('the letter for a trusted party', () => {
  it('suggests passwords that are long, varied and easy to type from paper', () => {
    const a = suggestPassword()
    expect(a).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){4}$/)
    expect(a).not.toMatch(/[01ilo]/)
    expect(suggestPassword()).not.toBe(a)
    expect(passwordProblem(a)).toBeNull()
    expect(passwordProblem('short')).not.toBeNull()
  })

  it('gives a guardian the link and the password; someone to inform gets no password', async () => {
    const guardian = await pdfText(makeLetter({ ...base, party: { name: 'Aunt Mary', role: 'guardian', relationship: 'Sister' }, password: 'k7mq-xy2p-a9bc-ddef-ghjk' }))
    expect(guardian).toContain('If something happens to us')
    expect(guardian).toContain('Dear Aunt Mary')
    expect(guardian).toContain(base.link)
    expect(guardian).toContain('k7mq-xy2p-a9bc-ddef-ghjk')
    expect(guardian).toContain('Alex and Jo')
    const inform = await pdfText(makeLetter({ ...base, party: { name: 'Pastor John', role: 'inform', relationship: '' }, password: 'should-not-appear' }))
    expect(inform).toContain(base.link)
    expect(inform).not.toContain('should-not-appear')
    expect(inform).not.toContain('password for the PDF')
  })
})
