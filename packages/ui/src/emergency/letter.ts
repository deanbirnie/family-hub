/**
 * The letter for a trusted party (phase 9a), made on the parent's device as
 * a PDF to print and hand over: what this is, the link to use if something
 * has happened, and (for a guardian) the password of the pack. The password
 * is typed here and goes into the PDF only: it never reaches the server.
 */
import { Report } from '../pdf/writer.ts'

/** Letters without look-alikes (no 0/o, 1/l/i). */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'

/** A password to suggest: five groups of four, about 99 bits, easy to type from paper. */
export function suggestPassword(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  const out: string[] = []
  // Rejection sampling keeps every letter equally likely.
  const limit = 256 - (256 % ALPHABET.length)
  while (out.length < 20) {
    for (const b of random(32)) {
      if (b < limit && out.length < 20) out.push(ALPHABET[b % ALPHABET.length]!)
    }
  }
  return [0, 4, 8, 12, 16].map((i) => out.slice(i, i + 4).join('')).join('-')
}

/** Why a password will not do, or null. */
export function passwordProblem(password: string): string | null {
  if (password.trim().length < 12) return 'Use at least 12 characters (the suggested one is easy to type from paper).'
  return null
}

export interface LetterInput {
  family: string
  /** The parents, as they sign it: "Alex and Jo". */
  from: string
  party: { name: string; role: 'guardian' | 'inform'; relationship: string }
  link: string
  /** Guardians only. */
  password: string | null
  /** "24 November 2026". */
  date: string
}

export function makeLetter(input: LetterInput): Uint8Array {
  const guardian = input.party.role === 'guardian'
  const r = new Report({ title: `If something happens to us – ${input.party.name}`, author: input.from, header: `${input.family} · for ${input.party.name} · private` })
  r.title('If something happens to us', `For ${input.party.name}, from ${input.from} · ${input.date}`)
  r.paragraph(`Dear ${input.party.name},`)
  r.space(4)
  if (guardian) {
    r.paragraph(
      'We have named you as someone who could look after our children if something happens to both of us. We hope you never need this letter, but if you do, everything you would need should reach you quickly.',
    )
    r.space(4)
    r.paragraph(
      'Our Family Hub (our family’s own app, on a computer at home) keeps what you would need: our instructions, the children’s routines and care, their health, allergies and medicines, school details, who to call, where our will, policies and documents are, and accounts to deal with.',
    )
    r.space(4)
    r.paragraph('If something has happened to both of us, open the link below. We are asked first and have time to answer; if neither of us does, the hub emails you a PDF with all of it, locked with the password below.')
  } else {
    r.paragraph(
      'We have named you as someone to be told if something happens to both of us. Our Family Hub (our family’s own app, on a computer at home) would then send what the children’s guardians need to them, and let you know it has.',
    )
    r.space(4)
    r.paragraph('If you hear that something has happened to both of us and have not heard from the hub, open the link below. We are asked first and have time to answer.')
  }
  r.space(10)
  r.heading('The link', 60)
  r.paragraph(input.link, { bold: true })
  r.muted('Type it into a browser exactly as it is, or keep a photo of this page. It works only for you; if we give you a new letter, this link stops working.')
  if (guardian && input.password) {
    r.space(10)
    r.heading('The password for the PDF', 60)
    r.paragraph(input.password, { size: 16, bold: true })
    r.muted('The PDF you would receive opens with this password. The email it comes with never contains it: it only says the password is in the letter we gave you.')
  }
  r.space(10)
  r.alert('Keep this letter safe and private', [
    'Keep it with your important papers, not where others can read it.',
    'Nobody from us or the hub will ever ask you for the link or the password.',
    'If the link no longer works, the hub may have been switched off: our will says what to do.',
  ])
  r.space(10)
  r.paragraph('With love and thanks,')
  r.paragraph(input.from, { bold: true })
  return r.finish(`${input.family} · in case of emergency · ${input.date}`)
}
