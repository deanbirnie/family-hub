import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { parseStamp } from '../src/health/episodes.ts'
import type { HealthContent } from '../src/health/model.ts'
import { ageText, DEFAULT_VISIT, emergencyCard, episodeReport, visitSummary, type ReportInput } from '../src/health/reports.ts'
import { encodeText, PdfDocument, Report, textWidth, wrapText } from '../src/pdf/writer.ts'

/** Every page's text, as a PDF reader sees it. */
async function readPdf(bytes: Uint8Array): Promise<{ pages: number; text: string }> {
  const pdf = await getDocument({ data: bytes.slice(), useSystemFonts: false }).promise
  let text = ''
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    text += content.items.map((it) => ('str' in it ? it.str : '')).join(' ') + '\n'
  }
  return { pages: pdf.numPages, text: text.replace(/\s+/g, ' ') }
}

const rec = (id: string, kind: HealthContent['kind'], fields: Record<string, string>, documents: { id: string; name: string }[] = []) => ({
  id,
  content: { kind, fields, documents, changes: [] } as HealthContent,
})

const NOW = parseStamp('2026-11-24T10:00')

function family(): ReportInput {
  return {
    person: {
      displayName: 'Sam',
      fullName: 'Samuel Tester',
      birthDate: '2022-08-15',
      idNumber: '2208155000000',
      medical: { scheme: 'Discovery Health', plan: 'Classic', membershipNumber: '123456789', dependantCode: '02', schemeContact: 'c-scheme' },
      emergency: { primary: 'c-gran', backup: null },
    },
    contacts: [
      { id: 'c-gp', name: 'Dr Naidoo', phones: [{ number: '021 555 0100' }] },
      { id: 'c-gran', name: 'Gran', phones: [{ number: '082 555 0199' }] },
      { id: 'c-scheme', name: 'Discovery', phones: [{ number: '0860 99 88 77' }] },
    ],
    preparedBy: 'Alex',
    now: NOW,
    records: [
      rec('b', 'basics', { bloodType: 'O+', careNotes: 'Inhaler before sport. No ibuprofen.' }),
      rec('a1', 'allergy', { substance: 'Penicillin', severity: 'anaphylaxis', reaction: 'Swelling', epipen: 'yes' }),
      rec('a2', 'allergy', { substance: 'Cats', severity: 'mild' }),
      rec('c1', 'condition', { name: 'Asthma', since: '2024-03-01', status: 'ongoing' }),
      rec('c2', 'condition', { name: 'Chickenpox', status: 'resolved' }),
      rec('m1', 'medicine', { name: 'Ventolin', strength: '100 mcg', dose: '2 puffs when needed', prescriberId: 'c-gp' }),
      rec('m2', 'medicine', { name: 'Old antibiotic', end: '2025-01-01' }),
      rec('p1', 'provider', { contactId: 'c-gp', role: 'gp', main: 'yes' }),
      rec('h1', 'history', { date: '2026-03-02', type: 'visit', title: 'Tonsillitis', providerId: 'c-gp' }),
      rec('h2', 'history', { date: '2023-01-01', type: 'test', title: 'Old test' }),
      rec('v1', 'vaccine', { name: 'Measles (MR1)', status: 'given', date: '2023-02-15' }),
      rec('e1', 'episode', { title: 'Fever and cough', started: '2026-11-20T08:00', status: 'open', hospital: 'yes', hospitalName: 'Red Cross', ward: 'C1', admitted: '2026-11-21T15:00' }, [{ id: 'f1', name: 'discharge-letter.pdf' }]),
      rec('pl1', 'plan', { episodeId: 'e1', medicine: 'Paracetamol', amount: '5 ml', mode: 'interval', everyHours: '6', start: '2026-11-20T08:00' }),
      rec('x1', 'entry', { episodeId: 'e1', type: 'observation', at: '2026-11-20T08:00', temperature: '39.1', symptoms: 'Fever, Cough', by: 'Alex' }),
      rec('x2', 'entry', { episodeId: 'e1', type: 'dose', at: '2026-11-20T08:05', planId: 'pl1', medicine: 'Paracetamol', amount: '5 ml', by: 'Alex' }),
      rec('x3', 'entry', { episodeId: 'e1', type: 'dose', at: '2026-11-20T11:00', planId: 'pl1', medicine: 'Paracetamol', amount: '5 ml', by: 'Jo', override: 'Dr Naidoo said to' }),
      rec('x4', 'entry', { episodeId: 'e1', type: 'doctor', at: '2026-11-20T10:00', contactId: 'c-gp', diagnosis: 'Bronchiolitis', said: 'Watch the breathing' }),
      rec('x5', 'entry', { episodeId: 'e1', type: 'vitals', at: '2026-11-21T16:00', temperature: '38.4', heartRate: '130', oxygen: '94' }),
      rec('x6', 'entry', { episodeId: 'e1', type: 'vitals', at: '2026-11-22T08:00', temperature: '37.6', heartRate: '118', oxygen: '97' }, [{ id: 'f2', name: 'xray.jpg' }]),
      rec('x7', 'entry', { episodeId: 'e1', type: 'test', at: '2026-11-21T17:00', what: 'Chest X-ray', result: 'Mild changes' }),
    ],
  }
}

describe('the PDF writer', () => {
  it('encodes text as WinAnsi, replacing what it cannot show', () => {
    expect(encodeText('Café – “quoted” 38 °C')).toEqual([67, 97, 102, 233, 32, 0x96, 32, 0x93, 113, 117, 111, 116, 101, 100, 0x94, 32, 51, 56, 32, 0xb0, 67])
    expect(encodeText('SpO₂ ≤ 92 → 🙂 Łódź')).toEqual(encodeText('SpO2 <= 92 -> ? Lódz'))
  })

  it('measures and wraps text', () => {
    expect(textWidth('A', 10)).toBeCloseTo(6.67, 1)
    expect(textWidth('A', 10, true)).toBeCloseTo(7.22, 1)
    const lines = wrapText('The quick brown fox jumps over the lazy dog', 100, 10)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(textWidth(l, 10)).toBeLessThanOrEqual(100)
    expect(wrapText('first\n\nthird', 200, 10)).toEqual(['first', '', 'third'])
    // A word longer than a line is broken, not lost.
    expect(wrapText('x'.repeat(80), 100, 10).join('')).toBe('x'.repeat(80))
  })

  it('writes a valid file a reader can open, with a correct cross-reference table', async () => {
    const doc = new PdfDocument({ title: 'Test (one)' })
    doc.addPage()
    doc.text(0, 50, 50, 'Hello (world) \\ back – slash')
    const bytes = doc.toBytes()
    const raw = new TextDecoder('latin1').decode(bytes)
    expect(raw.startsWith('%PDF-1.4')).toBe(true)
    // Each object starts exactly where the table says.
    const xref = Number(raw.match(/startxref\n(\d+)/)![1])
    const offsets = raw.slice(xref).match(/(\d{10}) 00000 n/g)!.map((m) => Number(m.slice(0, 10)))
    offsets.forEach((o, i) => expect(raw.slice(o, o + 10)).toMatch(new RegExp(`^${i + 1} 0 obj`)))
    const read = await readPdf(bytes)
    expect(read.text).toContain('Hello (world) \\ back – slash')
  })

  it('breaks long tables across pages and numbers them', async () => {
    const r = new Report({ title: 'Long', header: 'Long report' })
    r.table(
      [
        { title: 'N', width: 1 },
        { title: 'Text', width: 4 },
      ],
      Array.from({ length: 120 }, (_, i) => [String(i), `Row ${i}`]),
    )
    const read = await readPdf(r.finish('footer'))
    expect(read.pages).toBeGreaterThan(2)
    expect(read.text).toContain('Row 119')
    expect(read.text).toContain(`Page ${read.pages} of ${read.pages}`)
  })
})

describe('health reports', () => {
  it('give ages as a doctor would', () => {
    expect(ageText('2022-08-15', NOW)).toBe('4 years 3 months')
    expect(ageText('2026-05-01', NOW)).toBe('6 months')
    expect(ageText('2026-11-03', NOW)).toBe('3 weeks')
    expect(ageText('1980-01-01', NOW)).toBe('46 years')
  })

  it('make a visit summary with the essentials, and only the extras chosen', async () => {
    const plain = await readPdf(visitSummary(family(), DEFAULT_VISIT))
    for (const s of ['Health summary: Samuel Tester', 'Severe allergies', 'Penicillin', 'carries an EpiPen', 'Ventolin', 'Asthma', 'O+', 'Inhaler before sport', 'Dr Naidoo', 'Discovery Health', '123456789', 'Paracetamol: 5 ml every 6 hours']) {
      expect(plain.text).toContain(s)
    }
    for (const s of ['Chickenpox', 'Old antibiotic', '2208155000000', 'Tonsillitis', 'Measles']) expect(plain.text).not.toContain(s)
    const all = await readPdf(visitSummary(family(), { ...DEFAULT_VISIT, idNumber: true, vaccinations: true, historyFrom: '2026-01-01', historyTo: '' }))
    for (const s of ['2208155000000', 'Tonsillitis', 'Measles (MR1)']) expect(all.text).toContain(s)
    expect(all.text).not.toContain('Old test')
    const noAid = await readPdf(visitSummary(family(), { ...DEFAULT_VISIT, medicalAid: false }))
    expect(noAid.text).not.toContain('123456789')
  })

  it('make a handover report: doses, overrides, vitals and doctors, from a chosen time', async () => {
    const whole = await readPdf(episodeReport(family(), 'e1', { from: null, full: false }))
    for (const s of ['Handover report', 'Fever and cough', 'Red Cross, C1', 'Bronchiolitis', 'Paracetamol', 'given against a warning: Dr Naidoo said to', 'Temperature (°C)', 'Heart rate', 'Chest X-ray', 'Watch the breathing', 'Penicillin']) {
      expect(whole.text).toContain(s)
    }
    const later = await readPdf(episodeReport(family(), 'e1', { from: parseStamp('2026-11-21T00:00'), full: false }))
    expect(later.text).toContain('This report covers')
    expect(later.text).not.toContain('Dr Naidoo said to')
    expect(later.text).toContain('Chest X-ray')
    // The full record lists every document.
    const full = await readPdf(episodeReport(family(), 'e1', { from: null, full: true }))
    for (const s of ['Episode record', 'Documents', 'discharge-letter.pdf', 'xray.jpg', 'Timeline (everything, oldest first)']) expect(full.text).toContain(s)
  })

  it('make the emergency card', () => {
    const card = emergencyCard(family())
    expect(card).toMatchObject({
      name: 'Samuel Tester',
      idNumber: '2208155000000',
      bloodType: 'O+',
      conditions: ['Asthma'],
      medicines: ['Ventolin 100 mcg · 2 puffs when needed'],
      careNotes: 'Inhaler before sport. No ibuprofen.',
      medicalAid: { scheme: 'Discovery Health', number: '123456789', dependantCode: '02', phone: '0860 99 88 77' },
    })
    expect(card.severeAllergies[0]).toContain('Penicillin')
    expect(card.otherAllergies[0]).toContain('Cats')
    expect(card.contacts).toEqual([
      { label: 'First call', name: 'Gran', phone: '082 555 0199' },
      { label: 'Doctor', name: 'Dr Naidoo', phone: '021 555 0100' },
    ])
  })
})
