/**
 * Health records (phase 5): what each kind holds, and how it is encrypted on
 * the device with the family key before the server sees it. The kind of
 * record is inside the encryption, so the server cannot tell an allergy from
 * a hospital stay. Each record is bound to its person.
 */
import { open, seal } from '../vault/crypto.ts'

export type HealthKind =
  | 'basics'
  | 'allergy'
  | 'condition'
  | 'provider'
  | 'medicine'
  | 'history'
  | 'vaccine'
  | 'growth'
  | 'checkup'
  | 'appointment'
  // Episodes (5c): the episode, each entry in its timeline, and its medicine plans.
  | 'episode'
  | 'entry'
  | 'plan'

export interface LinkedDocument {
  id: string
  name: string
}

/** A record's contents: its kind, its fields (all text), and any linked documents. */
export interface HealthContent {
  kind: HealthKind
  fields: Record<string, string>
  documents: LinkedDocument[]
  /** Medicines: dated changes ("dose raised to 10 mg"). */
  changes: { date: string; note: string }[]
}

export interface StoredHealthRecord {
  id: string
  profileId: string
  ciphertext: string
  version: number
  createdAt: number
  updatedAt: number
  updatedBy: string | null
}

const aad = (profileId: string) => `family-hub/health/${profileId}`

export async function encryptHealth(familyKey: Uint8Array, profileId: string, content: HealthContent): Promise<string> {
  return seal(familyKey, new TextEncoder().encode(JSON.stringify({ v: 1, ...content })), aad(profileId))
}

export async function decryptHealth(familyKey: Uint8Array, record: Pick<StoredHealthRecord, 'profileId' | 'ciphertext'>): Promise<HealthContent> {
  const raw = JSON.parse(new TextDecoder().decode(await open(familyKey, record.ciphertext, aad(record.profileId)))) as Partial<HealthContent>
  const fields: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw.fields ?? {})) if (typeof v === 'string') fields[k] = v
  return {
    kind: (raw.kind ?? 'history') as HealthKind,
    fields,
    documents: Array.isArray(raw.documents) ? raw.documents.filter((d): d is LinkedDocument => !!d && typeof d.id === 'string' && typeof d.name === 'string') : [],
    changes: Array.isArray(raw.changes) ? raw.changes.filter((c) => !!c && typeof c.date === 'string' && typeof c.note === 'string') : [],
  }
}

// ---- what each kind holds ------------------------------------------------------------------

export interface FieldDef {
  key: string
  label: string
  type?: 'text' | 'textarea' | 'date' | 'datetime' | 'time' | 'select' | 'checkbox' | 'number' | 'contact'
  options?: [string, string][]
  placeholder?: string
  hint?: string
  required?: boolean
}

export const SEVERITIES: [string, string][] = [
  ['mild', 'Mild'],
  ['moderate', 'Moderate'],
  ['severe', 'Severe'],
  ['anaphylaxis', 'Anaphylaxis (life-threatening)'],
]

export const MEASURE_EVERY: [string, string][] = [
  ['', 'No reminder'],
  ['1', 'Every month'],
  ['3', 'Every 3 months'],
  ['6', 'Every 6 months'],
  ['12', 'Every year'],
]

export const BLOOD_TYPES: [string, string][] = [['', 'Not known'], ...['O+', 'O-', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-'].map((t): [string, string] => [t, t])]

export const PROVIDER_ROLES: [string, string][] = [
  ['gp', 'GP'],
  ['paediatrician', 'Paediatrician'],
  ['dentist', 'Dentist'],
  ['optometrist', 'Optometrist'],
  ['specialist', 'Specialist'],
  ['pharmacy', 'Pharmacy'],
  ['physio', 'Physiotherapist'],
  ['psychologist', 'Psychologist'],
  ['hospital', 'Hospital'],
  ['other', 'Other'],
]

export const HISTORY_TYPES: [string, string][] = [
  ['visit', 'Doctor’s visit'],
  ['diagnosis', 'Diagnosis'],
  ['procedure', 'Procedure or operation'],
  ['hospital', 'Hospital stay'],
  ['vaccination', 'Vaccination'],
  ['test', 'Test or result'],
  ['illness', 'Illness or injury'],
  ['dental', 'Dental'],
  ['eyes', 'Eye test'],
  ['other', 'Other'],
]

export interface KindDef {
  kind: HealthKind
  title: string
  addLabel: string
  fields: FieldDef[]
  /** Kinds a person has one of. */
  single?: boolean
}

export const KINDS = {
  basics: {
    kind: 'basics',
    title: 'Blood type and care notes',
    addLabel: 'Add blood type and care notes',
    single: true,
    fields: [
      { key: 'bloodType', label: 'Blood type', type: 'select', options: BLOOD_TYPES },
      { key: 'careNotes', label: 'Care notes', type: 'textarea', placeholder: 'e.g. Inhaler before sport. No ibuprofen.', hint: 'Short instructions anyone looking after them needs.' },
      { key: 'birthDate', label: 'Date of birth', type: 'date', hint: 'Only if it is not in Quick Info: used for the vaccination schedule.' },
      { key: 'measureEvery', label: 'Remind me to measure height and weight', type: 'select', options: MEASURE_EVERY },
    ],
  },
  allergy: {
    kind: 'allergy',
    title: 'Allergies',
    addLabel: 'Add an allergy',
    fields: [
      { key: 'substance', label: 'Allergic to', required: true, placeholder: 'e.g. Penicillin, peanuts, bee stings' },
      { key: 'reaction', label: 'Reaction', placeholder: 'e.g. Hives, swelling, trouble breathing' },
      { key: 'severity', label: 'How severe', type: 'select', options: SEVERITIES },
      { key: 'epipen', label: 'Carries an adrenaline auto-injector (EpiPen)', type: 'checkbox' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  condition: {
    kind: 'condition',
    title: 'Conditions',
    addLabel: 'Add a condition',
    fields: [
      { key: 'name', label: 'Condition', required: true, placeholder: 'e.g. Asthma, eczema, ADHD' },
      { key: 'since', label: 'Since', type: 'date' },
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        options: [
          ['ongoing', 'Ongoing'],
          ['resolved', 'Resolved'],
        ],
      },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  provider: {
    kind: 'provider',
    title: 'Doctors and providers',
    addLabel: 'Add a doctor or provider',
    fields: [
      { key: 'contactId', label: 'Who (from Contacts)', type: 'contact', required: true },
      { key: 'role', label: 'Role', type: 'select', options: PROVIDER_ROLES },
      { key: 'speciality', label: 'Speciality', placeholder: 'For a specialist: e.g. ENT, cardiologist' },
      { key: 'main', label: 'Main GP', type: 'checkbox' },
    ],
  },
  medicine: {
    kind: 'medicine',
    title: 'Medicines',
    addLabel: 'Add a medicine',
    fields: [
      { key: 'name', label: 'Medicine', required: true, placeholder: 'e.g. Ventolin' },
      { key: 'strength', label: 'Strength and form', placeholder: 'e.g. 100 mcg inhaler, 5 mg/5 ml syrup' },
      { key: 'dose', label: 'Dose and how often', placeholder: 'e.g. 2 puffs when needed; 5 ml twice a day' },
      { key: 'reason', label: 'What it is for' },
      { key: 'prescriberId', label: 'Prescribed by', type: 'contact' },
      { key: 'pharmacyId', label: 'Pharmacy', type: 'contact' },
      { key: 'start', label: 'Started', type: 'date' },
      { key: 'end', label: 'Ends (or ended)', type: 'date', hint: 'Leave empty for an ongoing medicine. After this date it moves to Past.' },
      { key: 'chronic', label: 'Chronic medicine on a repeat script', type: 'checkbox' },
      { key: 'scriptDate', label: 'Script issued', type: 'date' },
      { key: 'repeatsLeft', label: 'Repeats left', type: 'number' },
      { key: 'nextRepeat', label: 'Next repeat due', type: 'date', hint: 'Reminded 3 days before and on the day.' },
      { key: 'scriptExpiry', label: 'Script expires', type: 'date', hint: 'Most chronic scripts in South Africa last 6 months. Reminded 2 weeks and 3 days before.' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
  },
  history: {
    kind: 'history',
    title: 'History',
    addLabel: 'Add to history',
    fields: [
      { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'type', label: 'What', type: 'select', options: HISTORY_TYPES },
      { key: 'title', label: 'Title', required: true, placeholder: 'e.g. Tonsillitis; MMR vaccine; Chest X-ray' },
      { key: 'providerId', label: 'Doctor or provider', type: 'contact' },
      { key: 'notes', label: 'Notes', type: 'textarea', placeholder: 'What was found, said or done' },
    ],
  },
} as Record<HealthKind, KindDef>

export const VACCINE_STATUSES: [string, string][] = [
  ['given', 'Given'],
  ['planned', 'Booked or catching up (on a date)'],
  ['missed', 'Missed (to catch up)'],
  ['held', 'Held back on the doctor’s advice'],
  ['na', 'Not applicable'],
]

Object.assign(KINDS, {
  vaccine: {
    kind: 'vaccine',
    title: 'Vaccinations',
    addLabel: 'Add a vaccination',
    fields: [
      { key: 'name', label: 'Vaccine', required: true, placeholder: 'e.g. Flu, chickenpox, hepatitis A' },
      { key: 'status', label: 'Status', type: 'select', options: VACCINE_STATUSES },
      { key: 'date', label: 'Date given', type: 'date' },
      { key: 'due', label: 'Catch-up or booked date', type: 'date', hint: 'For a missed or booked dose: reminded a week before and on the day.' },
      { key: 'clinic', label: 'Clinic or doctor' },
      { key: 'batch', label: 'Batch number' },
      { key: 'reason', label: 'Reason or notes', type: 'textarea', placeholder: 'e.g. Held back: had a fever; doctor said to wait 2 weeks' },
    ],
  },
  growth: {
    kind: 'growth',
    title: 'Growth',
    addLabel: 'Add a measurement',
    fields: [
      { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'height', label: 'Height (cm)', type: 'number' },
      { key: 'weight', label: 'Weight (kg)', type: 'number' },
      { key: 'head', label: 'Head circumference (cm, babies)', type: 'number' },
      { key: 'notes', label: 'Notes', placeholder: 'e.g. Clinic, with shoes off' },
    ],
  },
  checkup: {
    kind: 'checkup',
    title: 'Regular check-ups',
    addLabel: 'Add a regular check-up',
    fields: [
      { key: 'what', label: 'Check-up', required: true, placeholder: 'e.g. Dentist, eye test, mole check' },
      { key: 'providerId', label: 'With', type: 'contact' },
      { key: 'everyMonths', label: 'How often', type: 'select', options: [['6', 'Every 6 months'], ['12', 'Every year'], ['24', 'Every 2 years'], ['3', 'Every 3 months']] },
      { key: 'last', label: 'Last done', type: 'date', hint: 'The next one is reminded 2 weeks before and on the day.' },
    ],
  },
  appointment: {
    kind: 'appointment',
    title: 'Appointments',
    addLabel: 'Add an appointment',
    fields: [
      { key: 'date', label: 'Date', type: 'date', required: true },
      { key: 'time', label: 'Time', placeholder: 'e.g. 09:30' },
      { key: 'providerId', label: 'With', type: 'contact' },
      { key: 'reason', label: 'What for', placeholder: 'e.g. Follow-up on the rash' },
      { key: 'questions', label: 'Things to ask', type: 'textarea' },
      {
        key: 'calendar',
        label: 'On the family calendar',
        type: 'select',
        options: [
          ['generic', 'As “Appointment – name” (nothing medical)'],
          ['named', 'With the doctor’s name'],
          ['none', 'Not on the calendar (a health reminder instead)'],
        ],
        hint: 'The calendar is seen by the whole family, children included.',
      },
    ],
  },
} satisfies Partial<Record<HealthKind, KindDef>>)

export const optionLabel = (options: [string, string][] | undefined, value: string) => options?.find(([v]) => v === value)?.[1] ?? value

const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A medicine is current until the day after its end date. */
export const isCurrentMedicine = (fields: Record<string, string>, on = today()) => !fields.end || fields.end >= on

/** Severe allergies first, then by name. */
export const severityRank = (s: string) => ({ anaphylaxis: 0, severe: 1, moderate: 2, mild: 3 })[s as 'mild'] ?? 4
