/**
 * The emergency pack (phase 9b): everything the people taking over the
 * children would need, gathered on a parent's device while the family vault
 * is open, written as a PDF and locked there with the pack's password. The
 * server receives only the locked file.
 *
 * gatherPack reads and decrypts; writePack lays it out (no network, easy to
 * test); makePack does both and locks it.
 */
import type { Api } from '../api.ts'
import { decryptHealth, type HealthContent, type StoredHealthRecord } from '../health/model.ts'
import { writeHealthEssentials, type ReportContact } from '../health/reports.ts'
import { rand } from '../money/model.ts'
import { Report } from '../pdf/writer.ts'
import { decryptRecord, SECTIONS, type Kind, type StoredRecord } from '../quickinfo/model.ts'
import { open, seal } from '../vault/crypto.ts'

// ---- the parents' instructions and the pack's password (end-to-end encrypted) ---------------

export const INSTRUCTION_SECTIONS = [
  ['children', 'The children: routines and care', 'Bedtimes, food, comfort things, what calms them, who they love to see.'],
  ['school', 'School and activities', 'How school runs day to day, lifts, who to tell at school.'],
  ['call', 'Who to call first', 'Family, close friends, the lawyer or executor, the employer.'],
  ['papers', 'Our will, policies and documents', 'Where the will is and who the executor is; where the originals are kept.'],
  ['money', 'Money', 'Accounts, debit orders to cancel or keep, what the policies pay out and how to claim.'],
  ['passwords', 'Our password manager', 'How its emergency access works, and who has it.'],
  ['wishes', 'Our wishes', 'For the children, for us: what matters most.'],
  ['other', 'Anything else', ''],
] as const
export type InstructionKey = (typeof INSTRUCTION_SECTIONS)[number][0]
export type Instructions = Partial<Record<InstructionKey, string>>

const enc = new TextEncoder()
const dec = new TextDecoder()
const AAD = { instructions: 'family-hub/emergency/instructions', password: 'family-hub/emergency/password' }

export const sealSecret = (key: Uint8Array, kind: keyof typeof AAD, value: unknown) => seal(key, enc.encode(JSON.stringify({ v: 1, value })), AAD[kind])
export async function openSecret<T>(key: Uint8Array, kind: keyof typeof AAD, ciphertext: string): Promise<T> {
  return (JSON.parse(dec.decode(await open(key, ciphertext, AAD[kind]))) as { value: T }).value
}

// ---- what goes in ----------------------------------------------------------------------------

interface Contact extends ReportContact {
  organisation: string
  role: string
  category: string
  emails: string[]
  phones: { label?: string; number: string }[]
}

export interface PackInput {
  family: string
  madeBy: string
  /** "24 November 2026". */
  date: string
  now: number
  instructions: Instructions
  parties: { name: string; role: 'guardian' | 'inform'; relationship: string; email: string; phone: string }[]
  people: {
    id: string
    displayName: string
    quickInfo: Partial<Record<Kind, Record<string, string>[]>>
    emergency: { primary: string | null; backup: string | null }
    health: { id: string; content: HealthContent }[]
  }[]
  household: Partial<Record<Kind, Record<string, string>[]>>
  contacts: Contact[]
  school: SchoolItem[]
  accounts: { id: string; bank: string; nickname: string; notes: string }[]
  bills: { name: string; type: 'bill' | 'subscription'; amount: number; every: number; unit: string; method: string; accountId: string | null; status: string; plan: string }[]
  documents: string[]
}

type SchoolItem =
  | { kind: 'year'; profileId: string | null; year: number; school: string; grade: string; terms: { name: string; start: string; end: string }[] }
  | { kind: 'contact'; profileId: string | null; contactId: string; role: string; note: string }
  | { kind: 'activity'; profileId: string | null; name: string; who: string; location: string; sessions: { day: string; start: string; end: string }[]; from: string; to: string; cancelPhone: string; cancelContactId: string | null }
  | { kind: string; profileId: string | null }

/** Reads and opens everything the pack holds. Needs the family key (the vault open). */
export async function gatherPack(api: Api, key: Uint8Array, madeBy: string, now = Date.now()): Promise<PackInput> {
  const [em, qi, health, book, school, money, docs] = await Promise.all([
    api.get<{ family: string; instructions: { ciphertext: string } | null; parties: PackInput['parties'] }>('/api/emergency'),
    api.get<{ profiles: { id: string; displayName: string; emergency: { primary: string | null; backup: string | null } }[]; records: StoredRecord[] }>('/api/quick-info'),
    api.get<{ profiles: { id: string; displayName: string }[]; records: StoredHealthRecord[] }>('/api/health/records'),
    api.get<{ contacts: Contact[] }>('/api/contacts'),
    api.get<{ items: SchoolItem[] }>('/api/school'),
    api.get<{ accounts: PackInput['accounts']; bills: PackInput['bills'] }>('/api/money'),
    api.get<{ documents: string[] }>('/api/emergency/documents'),
  ])
  const instructions = em.instructions ? await openSecret<Instructions>(key, 'instructions', em.instructions.ciphertext) : {}
  const quick = new Map<string | null, Partial<Record<Kind, Record<string, string>[]>>>()
  for (const r of qi.records) {
    try {
      const fields = (await decryptRecord(key, r)).fields
      const of = quick.get(r.profileId) ?? {}
      ;(of[r.kind] ??= []).push(fields)
      quick.set(r.profileId, of)
    } catch {
      // A record this key cannot open is left out.
    }
  }
  const records: (StoredHealthRecord & { content: HealthContent })[] = []
  for (const r of health.records) {
    try {
      records.push({ ...r, content: await decryptHealth(key, r) })
    } catch {
      // As above.
    }
  }
  return {
    family: em.family,
    madeBy,
    date: new Date(now).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' }),
    now,
    instructions,
    parties: em.parties,
    people: qi.profiles.map((p) => ({
      id: p.id,
      displayName: p.displayName,
      quickInfo: quick.get(p.id) ?? {},
      emergency: p.emergency,
      health: records.filter((r) => r.profileId === p.id && !['episode', 'entry', 'plan'].includes(r.content.kind)),
    })),
    household: quick.get(null) ?? {},
    contacts: book.contacts,
    school: school.items,
    accounts: money.accounts,
    bills: money.bills,
    documents: docs.documents,
  }
}

// ---- how it reads ----------------------------------------------------------------------------

const UNIT: Record<string, string> = { week: 'week', month: 'month', year: 'year' }
const METHOD: Record<string, string> = { debit: 'debit order', eft: 'EFT', card: 'card', cash: 'cash', other: 'other' }
const DAY: Record<string, string> = { MO: 'Mon', TU: 'Tue', WE: 'Wed', TH: 'Thu', FR: 'Fri', SA: 'Sat', SU: 'Sun' }
const ROLE: Record<string, string> = { teacher: 'Teacher', assistant: 'Assistant teacher', principal: 'Principal', office: 'School office', aftercare: 'Aftercare', coach: 'Coach', 'lift club': 'Lift club', other: 'Other' }

const fieldsOf = (kind: Kind, f: Record<string, string>, contacts: Contact[]): [string, string][] =>
  SECTIONS[kind].fields.map((d) => [d.label, d.type === 'contact' ? contactLine(contacts, f[d.key]) : (f[d.key] ?? '')] as [string, string]).filter(([, v]) => v)

function contactLine(contacts: Contact[], id: string | null | undefined): string {
  const c = id ? contacts.find((x) => x.id === id) : undefined
  if (!c) return ''
  return [c.name, c.phones[0]?.number].filter(Boolean).join(', ')
}

/** Writes the pack. Pure: no network, no keys. */
export function writePack(input: PackInput): Report {
  const r = new Report({ title: `In case of emergency – ${input.family}`, author: input.madeBy, header: `${input.family} · in case of emergency · private` })
  r.title('In case of emergency', `${input.family} · made by ${input.madeBy} on ${input.date}`)
  r.paragraph(
    'If you are reading this, something has happened to both of us. This pack holds what we wanted you to know and what our Family Hub kept: our instructions, each of us and the children (health, ID numbers, medical aid), school, the household, money, important contacts and where our documents are.',
  )
  r.space(4)
  r.paragraph('Thank you for being there for our children.', { bold: true })

  const guardians = input.parties.filter((p) => p.role === 'guardian')
  const inform = input.parties.filter((p) => p.role === 'inform')
  if (input.parties.length) {
    r.heading('Who this pack went to')
    const line = (p: PackInput['parties'][number]) => [p.name, p.relationship, p.phone, p.email].filter(Boolean).join(' · ')
    if (guardians.length) r.facts([['Guardians', guardians.map(line).join('\n')]])
    if (inform.length) r.facts([['Also told', inform.map(line).join('\n')]])
  }

  // Our instructions.
  r.heading('Our instructions', 80)
  const written = INSTRUCTION_SECTIONS.filter(([k]) => input.instructions[k]?.trim())
  if (written.length === 0) r.muted('No instructions were written in the hub.')
  for (const [k, title] of written) {
    r.subheading(title)
    r.paragraph(input.instructions[k]!.trim())
    r.space(4)
  }

  // Each of us.
  for (const p of input.people) {
    r.newPage()
    r.title(p.quickInfo.personal?.[0]?.fullName || p.displayName)
    for (const kind of ['personal', 'passport', 'medical'] as Kind[]) {
      for (const f of p.quickInfo[kind] ?? []) {
        const rows = fieldsOf(kind, f, input.contacts)
        if (!rows.length) continue
        r.subheading(SECTIONS[kind].title)
        r.facts(rows)
      }
    }
    const emergency = [contactLine(input.contacts, p.emergency.primary), contactLine(input.contacts, p.emergency.backup)].filter(Boolean)
    if (emergency.length) {
      r.subheading('Emergency contacts')
      r.facts([['First call', emergency[0]!], ['If no answer', emergency[1] ?? '']])
    }
    if (p.health.length) {
      r.heading('Health')
      writeHealthEssentials(r, {
        person: { displayName: p.displayName, birthDate: p.quickInfo.personal?.[0]?.dateOfBirth },
        records: p.health,
        contacts: input.contacts,
        preparedBy: input.madeBy,
        now: input.now,
      })
    }
    // School: the latest year, its contacts and extra-murals.
    const mine = input.school.filter((i) => i.profileId === p.id || (i.profileId === null && i.kind === 'contact'))
    const year = mine.filter((i): i is Extract<SchoolItem, { kind: 'year' }> => i.kind === 'year').sort((a, b) => b.year - a.year)[0]
    if (year) {
      r.heading('School')
      r.facts([
        ['School', `${year.school}${year.grade ? `, ${year.grade}` : ''} (${year.year})`],
        ['Terms', year.terms.map((t) => `${t.name}: ${t.start} to ${t.end}`).join('\n')],
      ])
      const contacts = mine.filter((i): i is Extract<SchoolItem, { kind: 'contact' }> => i.kind === 'contact')
      if (contacts.length) r.facts(contacts.map((c) => [ROLE[c.role] ?? c.role, [contactLine(input.contacts, c.contactId), c.note].filter(Boolean).join(' · ')]))
      const activities = mine.filter((i): i is Extract<SchoolItem, { kind: 'activity' }> => i.kind === 'activity')
      if (activities.length) {
        r.subheading('Extra-murals')
        r.bullets(
          activities.map((a) =>
            [a.name, a.sessions.map((x) => `${DAY[x.day] ?? x.day} ${x.start}–${x.end}`).join(', '), a.location, a.who, (a.cancelPhone || contactLine(input.contacts, a.cancelContactId)) && `to cancel: ${a.cancelPhone || contactLine(input.contacts, a.cancelContactId)}`]
              .filter(Boolean)
              .join(' · '),
          ),
        )
      }
    }
    const cars = p.quickInfo.vehicle ?? []
    const policies = p.quickInfo.policy ?? []
    if (cars.length || policies.length) r.heading('Vehicles and policies')
    for (const f of cars) r.facts(fieldsOf('vehicle', f, input.contacts))
    for (const f of policies) {
      r.facts(fieldsOf('policy', f, input.contacts))
      r.space(4)
    }
  }

  // The household and money.
  r.newPage()
  r.title('The household and money')
  for (const f of input.household.household ?? []) {
    r.subheading('Address')
    r.facts(fieldsOf('household', f, input.contacts))
  }
  if (input.accounts.length) {
    r.heading('Bank accounts')
    r.table(
      [
        { title: 'Bank', width: 2, bold: true },
        { title: 'Account', width: 2 },
        { title: 'Notes', width: 4 },
      ],
      input.accounts.map((a) => [a.bank, a.nickname, a.notes]),
    )
  }
  const active = input.bills.filter((b) => b.status === 'active')
  if (active.length) {
    r.heading('Bills, debit orders and subscriptions')
    r.muted('What goes off each month and how: debit orders to cancel or move, subscriptions to stop.')
    const account = (id: string | null) => {
      const a = input.accounts.find((x) => x.id === id)
      return a ? `${a.bank} ${a.nickname}` : ''
    }
    r.table(
      [
        { title: 'What', width: 3, bold: true },
        { title: 'Amount', width: 2 },
        { title: 'How', width: 2 },
        { title: 'From', width: 2 },
      ],
      active.map((b) => [
        `${b.name}${b.type === 'subscription' ? ' (subscription)' : ''}${b.plan ? `, ${b.plan}` : ''}`,
        `${rand(b.amount)}${b.unit === 'once' ? ' once' : ` every ${b.every > 1 ? `${b.every} ` : ''}${UNIT[b.unit] ?? b.unit}${b.every > 1 ? 's' : ''}`}`,
        METHOD[b.method] ?? b.method,
        account(b.accountId),
      ]),
    )
  }
  for (const f of input.household.policy ?? []) {
    r.subheading('Household policy')
    r.facts(fieldsOf('policy', f, input.contacts))
  }

  // Important contacts.
  const important = input.contacts.filter((c) => ['family', 'health', 'school', 'insurance'].includes(c.category)).sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
  if (important.length) {
    r.newPage()
    r.title('Important contacts')
    r.table(
      [
        { title: 'Name', width: 3, bold: true },
        { title: 'Who', width: 3 },
        { title: 'Phone', width: 2 },
        { title: 'Email', width: 3 },
      ],
      important.map((c) => [c.name, [c.role, c.organisation].filter(Boolean).join(', '), c.phones.map((x) => x.number).join(', '), c.emails.join(', ')]),
    )
  }

  // Documents.
  r.heading('Documents kept in the hub', 80)
  r.muted('Their names and folders in the hub’s Files. The files themselves stay on the hub: ask the family member who can reach it, or look for the originals.')
  if (input.documents.length === 0) r.muted('None.')
  else r.bullets(input.documents)
  return r
}

/** Gathers, writes and locks the pack: the bytes to upload. */
export async function makePack(api: Api, key: Uint8Array, madeBy: string, password: string): Promise<Uint8Array> {
  const input = await gatherPack(api, key, madeBy)
  return writePack(input).finishLocked(`${input.family} · in case of emergency · ${input.date}`, password)
}
