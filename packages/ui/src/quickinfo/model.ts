/**
 * Quick Info records: what each kind holds, and how it is encrypted on the
 * device with the family key before the server sees it.
 *
 * A record's contents are JSON sealed with AES-256-GCM under the family key.
 * The associated data binds it to its kind and person, so the server cannot
 * move, say, one child's passport onto another child's card.
 */
import { open, seal } from '../vault/crypto.ts'

export type Kind = 'personal' | 'medical' | 'passport' | 'vehicle' | 'policy' | 'household'

export interface FieldDef {
  key: string
  label: string
  /** Masked until tapped; copied values clear from the clipboard. */
  sensitive?: boolean
  type?: 'text' | 'date' | 'idNumber' | 'multiline'
  placeholder?: string
  hint?: string
}

export interface SectionDef {
  kind: Kind
  title: string
  /** For kinds a person can have several of. */
  addLabel: string
  many?: boolean
  fields: FieldDef[]
  /** The field that names one of several (a vehicle, a policy) in lists. */
  titleField?: string
}

export const SECTIONS: Record<Kind, SectionDef> = {
  personal: {
    kind: 'personal',
    title: 'Personal details',
    addLabel: 'Add personal details',
    fields: [
      { key: 'fullName', label: 'Full legal name', placeholder: 'As on the ID document' },
      { key: 'idNumber', label: 'South African ID number', sensitive: true, type: 'idNumber', placeholder: '13 digits' },
      { key: 'dateOfBirth', label: 'Date of birth', type: 'date' },
      { key: 'taxNumber', label: 'SARS income tax number', sensitive: true, hint: 'Adults only.' },
    ],
  },
  medical: {
    kind: 'medical',
    title: 'Medical aid',
    addLabel: 'Add medical aid',
    fields: [
      { key: 'scheme', label: 'Scheme', placeholder: 'e.g. Discovery Health' },
      { key: 'plan', label: 'Plan' },
      { key: 'membershipNumber', label: 'Membership number', sensitive: true },
      { key: 'mainMember', label: 'Main member' },
      { key: 'dependantCode', label: 'Dependant code', placeholder: 'e.g. 00, 01, 02' },
    ],
  },
  passport: {
    kind: 'passport',
    title: 'Passport',
    addLabel: 'Add passport',
    fields: [
      { key: 'number', label: 'Passport number', sensitive: true },
      { key: 'country', label: 'Issued by', placeholder: 'e.g. South Africa' },
      { key: 'expiry', label: 'Expiry date', type: 'date' },
    ],
  },
  vehicle: {
    kind: 'vehicle',
    title: 'Vehicles',
    addLabel: 'Add vehicle',
    many: true,
    titleField: 'description',
    fields: [
      { key: 'description', label: 'Vehicle', placeholder: 'e.g. White Polo' },
      { key: 'registration', label: 'Registration number' },
      { key: 'vin', label: 'VIN', sensitive: true },
      { key: 'licenceExpiry', label: 'Licence disc expiry', type: 'date' },
    ],
  },
  policy: {
    kind: 'policy',
    title: 'Insurance policies',
    addLabel: 'Add policy',
    many: true,
    titleField: 'insurer',
    fields: [
      { key: 'insurer', label: 'Insurer', placeholder: 'e.g. Old Mutual' },
      { key: 'type', label: 'Type of cover', placeholder: 'e.g. Life, car, household' },
      { key: 'policyNumber', label: 'Policy number', sensitive: true },
    ],
  },
  household: {
    kind: 'household',
    title: 'Household',
    addLabel: 'Add household address',
    fields: [
      { key: 'street', label: 'Street address' },
      { key: 'suburb', label: 'Suburb' },
      { key: 'city', label: 'City or town' },
      { key: 'postalCode', label: 'Postal code' },
      { key: 'postalAddress', label: 'Postal address (if different)', type: 'multiline' },
    ],
  },
}

/** Sections shown on each person's card, in order. */
export const PERSON_KINDS: Kind[] = ['personal', 'medical', 'passport', 'vehicle', 'policy']

export interface LinkedDocument {
  id: string
  name: string
}

export interface RecordContent {
  fields: Record<string, string>
  documents: LinkedDocument[]
}

export interface StoredRecord {
  id: string
  profileId: string | null
  kind: Kind
  ciphertext: string
  version: number
  updatedAt: number
  updatedBy: string | null
}

const aad = (kind: Kind, profileId: string | null) => `family-hub/quick-info/${kind}/${profileId ?? 'household'}`

export async function encryptRecord(familyKey: Uint8Array, kind: Kind, profileId: string | null, content: RecordContent): Promise<string> {
  return seal(familyKey, new TextEncoder().encode(JSON.stringify({ v: 1, ...content })), aad(kind, profileId))
}

export async function decryptRecord(familyKey: Uint8Array, record: Pick<StoredRecord, 'kind' | 'profileId' | 'ciphertext'>): Promise<RecordContent> {
  const raw = JSON.parse(new TextDecoder().decode(await open(familyKey, record.ciphertext, aad(record.kind, record.profileId)))) as Partial<RecordContent>
  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw.fields ?? {})) if (typeof v === 'string') fields[k] = v
  const documents = Array.isArray(raw.documents)
    ? raw.documents.filter((d): d is LinkedDocument => !!d && typeof d.id === 'string' && typeof d.name === 'string')
    : []
  return { fields, documents }
}

// ---- South African ID numbers ------------------------------------------------------

/**
 * Checks a South African ID number: 13 digits, a real date of birth in the
 * first six, and the Luhn check digit last. Returns the date of birth
 * (YYYY-MM-DD) or a problem to show.
 */
export function checkSaId(raw: string, today = new Date()): { ok: true; dateOfBirth: string } | { ok: false; problem: string } {
  const id = raw.replace(/\s/g, '')
  if (!/^\d{13}$/.test(id)) return { ok: false, problem: 'An SA ID number has 13 digits.' }
  let sum = 0
  for (let i = 0; i < 13; i++) {
    let d = Number(id[12 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  if (sum % 10 !== 0) return { ok: false, problem: 'That ID number’s check digit is wrong. Check for a typo.' }
  const yy = Number(id.slice(0, 2))
  const mm = Number(id.slice(2, 4))
  const dd = Number(id.slice(4, 6))
  // A two-digit year is this century unless that would be in the future.
  const century = 2000 + yy > today.getFullYear() ? 1900 : 2000
  const date = new Date(Date.UTC(century + yy, mm - 1, dd))
  if (date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return { ok: false, problem: 'That ID number does not start with a real date of birth.' }
  return { ok: true, dateOfBirth: date.toISOString().slice(0, 10) }
}

/** How a sensitive value is shown before it is tapped. */
export const mask = (value: string) => (value ? '•'.repeat(Math.min(Math.max(value.length, 6), 13)) : '')
