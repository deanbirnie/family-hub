import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { openSecret, sealSecret, writePack, type PackInput } from '../src/emergency/pack.ts'
import { newFamilyKey } from '../src/vault/crypto.ts'

async function text(bytes: Uint8Array, password?: string): Promise<string> {
  const pdf = await getDocument({ data: bytes.slice(), password, useSystemFonts: false }).promise
  let out = ''
  for (let i = 1; i <= pdf.numPages; i++) out += (await (await pdf.getPage(i)).getTextContent()).items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n'
  return out.replace(/\s+/g, ' ')
}

const contacts = [
  { id: 'c1', name: 'Dr Naidoo', organisation: 'Sea Point Clinic', role: 'GP', category: 'health', emails: ['dr@example.com'], phones: [{ number: '021 555 0101' }] },
  { id: 'c2', name: 'Gran Tester', organisation: '', role: '', category: 'family', emails: [], phones: [{ number: '082 555 0102' }] },
  { id: 'c3', name: 'Ms Jacobs', organisation: 'Little Acorns', role: 'Teacher', category: 'school', emails: [], phones: [{ number: '021 555 0103' }] },
]

const input: PackInput = {
  family: 'The Testers',
  madeBy: 'Alex',
  date: '24 November 2026',
  now: Date.UTC(2026, 10, 24),
  instructions: { children: 'Sam needs his blue blanket to sleep.', wishes: 'Keep the children together.' },
  parties: [
    { name: 'Aunt Mary', role: 'guardian', relationship: 'Sister', email: 'mary@example.org', phone: '082 555 0100' },
    { name: 'Pastor John', role: 'inform', relationship: '', email: 'john@example.net', phone: '' },
  ],
  people: [
    {
      id: 'sam',
      displayName: 'Sam',
      quickInfo: { personal: [{ fullName: 'Samuel Tester', idNumber: '2101015800085', dateOfBirth: '2021-01-01' }], medical: [{ scheme: 'Discovery', membershipNumber: '123456789', schemeContact: 'c1' }] },
      emergency: { primary: 'c2', backup: null },
      health: [
        { id: 'h1', content: { kind: 'allergy', fields: { substance: 'Penicillin', severity: 'anaphylaxis' }, documents: [], changes: [] } },
        { id: 'h2', content: { kind: 'provider', fields: { contactId: 'c1', role: 'gp', main: 'yes' }, documents: [], changes: [] } },
      ] as PackInput['people'][number]['health'],
    },
  ],
  household: { household: [{ street: '1 Main Road', city: 'Cape Town' }] },
  contacts,
  school: [
    { kind: 'year', profileId: 'sam', year: 2027, school: 'Little Acorns', grade: 'Butterflies', terms: [{ name: 'Term 1', start: '2027-01-15', end: '2027-03-28' }] },
    { kind: 'contact', profileId: null, contactId: 'c3', role: 'teacher', note: '' },
    { kind: 'activity', profileId: 'sam', name: 'Swimming', who: 'Aqua Kids', location: 'Sea Point pool', sessions: [{ day: 'TU', start: '14:30', end: '15:15' }], from: '2027-01-15', to: '2027-03-28', cancelPhone: '082 555 0123', cancelContactId: null },
  ],
  accounts: [{ id: 'a1', bank: 'Capitec', nickname: 'Household', notes: 'Joint' }],
  bills: [
    { name: 'Netflix', type: 'subscription', amount: 19900, every: 1, unit: 'month', method: 'card', accountId: null, status: 'active', plan: 'Standard' },
    { name: 'Car insurance', type: 'bill', amount: 125000, every: 1, unit: 'month', method: 'debit', accountId: 'a1', status: 'active', plan: '' },
    { name: 'Old gym', type: 'bill', amount: 50000, every: 1, unit: 'month', method: 'debit', accountId: 'a1', status: 'cancelled', plan: '' },
  ],
  documents: ['Legal / Will.pdf', 'Insurance / Life policy.pdf'],
}

describe('the emergency pack', () => {
  it('holds the instructions, each person, school, money, contacts and documents, locked with the password', async () => {
    const bytes = await writePack(input).finishLocked('footer', 'k7mq-xy2p-a9bc-ddef-ghjk')
    await expect(text(bytes)).rejects.toMatchObject({ name: 'PasswordException' })
    const t = await text(bytes, 'k7mq-xy2p-a9bc-ddef-ghjk')
    for (const w of [
      'In case of emergency',
      'Aunt Mary',
      'Sam needs his blue blanket to sleep.',
      'Keep the children together.',
      'Samuel Tester',
      '2101015800085',
      'Discovery',
      'Gran Tester, 082 555 0102',
      'Penicillin',
      'Severe allergies',
      'Dr Naidoo',
      'Little Acorns, Butterflies (2027)',
      'Ms Jacobs',
      'Swimming',
      'to cancel: 082 555 0123',
      '1 Main Road',
      'Capitec',
      'Car insurance',
      'debit order',
      'Netflix (subscription), Standard',
      'Legal / Will.pdf',
    ])
      expect(t).toContain(w)
    expect(t).not.toContain('Old gym') // cancelled
  })

  it('keeps the instructions and password sealed with the family key, bound to what they are', async () => {
    const key = newFamilyKey()
    const sealed = await sealSecret(key, 'password', 'k7mq-xy2p')
    expect(sealed).not.toContain('k7mq')
    expect(await openSecret<string>(key, 'password', sealed)).toBe('k7mq-xy2p')
    // A password's ciphertext cannot be passed off as the instructions.
    await expect(openSecret(key, 'instructions', sealed)).rejects.toThrow()
    await expect(openSecret(newFamilyKey(), 'password', sealed)).rejects.toThrow()
  })
})
