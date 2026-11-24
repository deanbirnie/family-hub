/**
 * Health reports (phase 5d), made on the device from the decrypted record:
 * the visit summary for a doctor, an episode's handover report and its full
 * record, and what goes on the phone's offline emergency card. Nothing here
 * talks to the server.
 */
import { Report, type Column } from '../pdf/writer.ts'
import { ENTRY_TYPES, entrySummary, FEELINGS, HOUR, parseStamp, planStatus, planSummary, temperatures } from './episodes.ts'
import { HISTORY_TYPES, isCurrentMedicine, optionLabel, PROVIDER_ROLES, SEVERITIES, severityRank, VACCINE_STATUSES, type HealthContent, type LinkedDocument } from './model.ts'

export interface ReportContact {
  id: string
  name: string
  phones: { number: string }[]
}

export interface ReportPerson {
  displayName: string
  /** From Quick Info. */
  fullName?: string
  birthDate?: string
  idNumber?: string
  /** Medical aid fields from Quick Info. */
  medical?: Record<string, string>
  /** Emergency contacts from Quick Info (contact IDs). */
  emergency?: { primary: string | null; backup: string | null }
}

export interface ReportInput {
  person: ReportPerson
  records: { id: string; content: HealthContent; createdAt?: number }[]
  contacts: ReportContact[]
  /** The parent making the report. */
  preparedBy: string
  now: number
}

const pad = (n: number) => String(n).padStart(2, '0')
const isoDay = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const longDate = (iso: string) => {
  const t = parseStamp(iso)
  return Number.isNaN(t) ? iso : new Date(t).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })
}
/** "20 Nov 14:30". */
export const stampText = (ms: number) => (Number.isNaN(ms) ? '' : `${new Date(ms).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })} ${pad(new Date(ms).getHours())}:${pad(new Date(ms).getMinutes())}`)

/** "4 years 2 months", "7 months", "3 weeks". */
export function ageText(birth: string | undefined, on: number): string {
  const b = parseStamp(birth)
  if (Number.isNaN(b)) return ''
  const d = new Date(b)
  const n = new Date(on)
  let months = (n.getFullYear() - d.getFullYear()) * 12 + n.getMonth() - d.getMonth()
  if (n.getDate() < d.getDate()) months--
  if (months < 0) return ''
  if (months === 0) {
    const weeks = Math.floor((on - b) / (7 * 24 * HOUR))
    return `${weeks} week${weeks === 1 ? '' : 's'}`
  }
  if (months < 24) return `${months} month${months === 1 ? '' : 's'}`
  const years = Math.floor(months / 12)
  const rest = months % 12
  return `${years} years${years < 5 && rest ? ` ${rest} month${rest === 1 ? '' : 's'}` : ''}`
}

const contactName = (contacts: ReportContact[], id?: string) => (id ? (contacts.find((c) => c.id === id)?.name ?? '') : '')
const contactPhone = (contacts: ReportContact[], id?: string) => (id ? (contacts.find((c) => c.id === id)?.phones[0]?.number ?? '') : '')

/** The pieces every report starts from. */
function essentials(input: ReportInput) {
  const of = (kind: HealthContent['kind']) => input.records.filter((r) => r.content.kind === kind)
  const today = isoDay(input.now)
  const allergies = of('allergy').sort((a, b) => severityRank(a.content.fields.severity ?? '') - severityRank(b.content.fields.severity ?? ''))
  const basics = of('basics')[0]?.content.fields ?? {}
  return {
    of,
    today,
    allergies,
    severe: allergies.filter((a) => severityRank(a.content.fields.severity ?? '') <= 1),
    conditions: of('condition').filter((c) => c.content.fields.status !== 'resolved'),
    medicines: of('medicine').filter((m) => isCurrentMedicine(m.content.fields, today)),
    basics,
    birthDate: input.person.birthDate || basics.birthDate,
  }
}

const allergyLine = (f: Record<string, string>) =>
  [f.substance, f.severity && optionLabel(SEVERITIES, f.severity).toLowerCase(), f.reaction, f.epipen === 'yes' && 'carries an EpiPen'].filter(Boolean).join(' · ')
const medicineLine = (f: Record<string, string>, contacts: ReportContact[]) =>
  [[f.name, f.strength].filter(Boolean).join(' '), f.dose, f.reason && `for ${f.reason}`, f.prescriberId && `prescribed by ${contactName(contacts, f.prescriberId)}`].filter(Boolean).join(' · ')

/** Name, age, date of birth, and who made the report. */
function header(r: Report, input: ReportInput, kind: string, e: ReturnType<typeof essentials>, extra: [string, string][] = []) {
  r.title(`${kind}: ${input.person.fullName || input.person.displayName}`, `Prepared by ${input.preparedBy} on ${longDate(e.today)} from the family’s health record.`)
  r.facts([['Date of birth', e.birthDate ? `${longDate(e.birthDate)} (${ageText(e.birthDate, input.now)})` : ''], ['Blood type', e.basics.bloodType ?? ''], ...extra])
  r.space(4)
}

/** Allergies (severe ones in a box), conditions and medicines: what any doctor needs first. */
function essentialsSection(r: Report, input: ReportInput, e: ReturnType<typeof essentials>) {
  if (e.severe.length) r.alert('Severe allergies', e.severe.map((a) => allergyLine(a.content.fields)))
  r.heading('Allergies')
  if (e.allergies.length === 0) r.muted('No known allergies recorded.')
  else r.bullets(e.allergies.map((a) => allergyLine(a.content.fields)))
  r.heading('Current medicines')
  if (e.medicines.length === 0) r.muted('None recorded.')
  else r.bullets(e.medicines.map((m) => medicineLine(m.content.fields, input.contacts)))
  r.heading('Ongoing conditions')
  if (e.conditions.length === 0) r.muted('None recorded.')
  else r.bullets(e.conditions.map((c) => [c.content.fields.name, c.content.fields.since && `since ${c.content.fields.since}`, c.content.fields.notes].filter(Boolean).join(' · ')))
  if (e.basics.careNotes) {
    r.heading('Care notes')
    r.paragraph(e.basics.careNotes)
  }
}

/** A person's health essentials written into another report (the emergency pack): blood type, allergies, medicines, conditions, care notes and doctors. */
export function writeHealthEssentials(r: Report, input: ReportInput) {
  const e = essentials(input)
  r.facts([['Blood type', e.basics.bloodType ? e.basics.bloodType : '']])
  essentialsSection(r, input, e)
  const doctors = e.of('provider')
  if (doctors.length) {
    r.heading('Doctors')
    r.bullets(
      doctors.map((d) => {
        const f = d.content.fields
        return [contactName(input.contacts, f.contactId), [optionLabel(PROVIDER_ROLES, f.role ?? ''), f.speciality].filter(Boolean).join(', '), f.main === 'yes' && 'main GP', contactPhone(input.contacts, f.contactId)].filter(Boolean).join(' · ')
      }),
    )
  }
}

// ---- the visit summary ---------------------------------------------------------------------

export interface VisitOptions {
  medicalAid: boolean
  idNumber: boolean
  /** History entries from this date (inclusive) to `historyTo`; none if empty. */
  historyFrom: string
  historyTo: string
  vaccinations: boolean
  /** Medicine plans in open episodes. */
  plans: boolean
}

export const DEFAULT_VISIT: VisitOptions = { medicalAid: true, idNumber: false, historyFrom: '', historyTo: '', vaccinations: false, plans: true }

/** A summary to hand a doctor at a visit. */
export function visitSummary(input: ReportInput, opts: VisitOptions): Uint8Array {
  const e = essentials(input)
  const r = new Report({ title: `Health summary – ${input.person.displayName}`, author: input.preparedBy, header: `Health summary · ${input.person.fullName || input.person.displayName} · confidential` })
  const medical = input.person.medical ?? {}
  header(r, input, 'Health summary', e, [
    ['ID number', opts.idNumber ? (input.person.idNumber ?? '') : ''],
    ['Medical aid', opts.medicalAid ? [medical.scheme, medical.plan].filter(Boolean).join(' · ') : ''],
    ['Membership number', opts.medicalAid ? [medical.membershipNumber, medical.dependantCode && `dependant ${medical.dependantCode}`].filter(Boolean).join(', ') : ''],
    ['Main member', opts.medicalAid ? (medical.mainMember ?? '') : ''],
  ])
  essentialsSection(r, input, e)

  const providers = e.of('provider')
  if (providers.length) {
    r.heading('Doctors and providers')
    r.table(
      [
        { title: 'Who', width: 3, bold: true },
        { title: 'Role', width: 3 },
        { title: 'Phone', width: 2 },
      ],
      providers
        .sort((a, b) => Number(b.content.fields.main === 'yes') - Number(a.content.fields.main === 'yes'))
        .map((p) => {
          const f = p.content.fields
          return [contactName(input.contacts, f.contactId), [optionLabel(PROVIDER_ROLES, f.role ?? ''), f.speciality, f.main === 'yes' && 'main GP'].filter(Boolean).join(' · '), contactPhone(input.contacts, f.contactId)]
        }),
    )
  }

  if (opts.plans) {
    const open = new Set(e.of('episode').filter((x) => x.content.fields.status !== 'closed').map((x) => x.id))
    const plans = e.of('plan').filter((p) => open.has(p.content.fields.episodeId ?? '') && planStatus({ id: p.id, fields: p.content.fields }, [], input.now).phase !== 'ended')
    if (plans.length) {
      r.heading('Treatment now (current illness)')
      for (const ep of e.of('episode').filter((x) => open.has(x.id))) {
        const mine = plans.filter((p) => p.content.fields.episodeId === ep.id)
        if (!mine.length) continue
        r.subheading(`${ep.content.fields.title} (since ${stampText(parseStamp(ep.content.fields.started))})`)
        r.bullets(mine.map((p) => `${p.content.fields.medicine}: ${planSummary(p.content.fields)}${p.content.fields.until ? `, until ${p.content.fields.until}` : ''}`))
      }
    }
  }

  if (opts.historyFrom || opts.historyTo) {
    const from = opts.historyFrom || '0000-01-01'
    const to = opts.historyTo || '9999-12-31'
    const history = e
      .of('history')
      .filter((h) => (h.content.fields.date ?? '') >= from && (h.content.fields.date ?? '') <= to)
      .sort((a, b) => (b.content.fields.date ?? '').localeCompare(a.content.fields.date ?? ''))
    r.heading(`History${opts.historyFrom ? ` from ${longDate(opts.historyFrom)}` : ''}${opts.historyTo ? ` to ${longDate(opts.historyTo)}` : ''}`)
    if (history.length === 0) r.muted('Nothing recorded in this period.')
    else
      r.table(
        [
          { title: 'Date', width: 2 },
          { title: 'What', width: 2 },
          { title: 'Details', width: 6 },
        ],
        history.map((h) => {
          const f = h.content.fields
          return [f.date ?? '', optionLabel(HISTORY_TYPES, f.type ?? 'other'), [f.title, f.providerId && contactName(input.contacts, f.providerId), f.notes].filter(Boolean).join(' · ')]
        }),
      )
  }

  if (opts.vaccinations) {
    const vaccines = e.of('vaccine').sort((a, b) => (a.content.fields.date || a.content.fields.due || '').localeCompare(b.content.fields.date || b.content.fields.due || ''))
    r.heading('Vaccinations')
    if (vaccines.length === 0) r.muted('None recorded.')
    else
      r.table(
        [
          { title: 'Vaccine', width: 4, bold: true },
          { title: 'Status', width: 3 },
          { title: 'Date', width: 2 },
          { title: 'Notes', width: 4 },
        ],
        vaccines.map((v) => {
          const f = v.content.fields
          return [f.name ?? '', optionLabel(VACCINE_STATUSES, f.status ?? ''), f.date || f.due || '', [f.clinic, f.batch && `batch ${f.batch}`, f.reason].filter(Boolean).join(' · ')]
        }),
      )
  }
  return r.finish(`Family Hub · ${input.person.displayName} · ${longDate(e.today)}`)
}

// ---- episode reports -------------------------------------------------------------------------

export interface EpisodeOptions {
  /** Handover: from this time on (ms), or the whole episode. Ignored for the full record. */
  from: number | null
  /** The full record: every entry in full, and the list of documents. */
  full: boolean
}

/** A handover report for the doctors taking over care, or the episode's full record. */
export function episodeReport(input: ReportInput, episodeId: string, opts: EpisodeOptions): Uint8Array {
  const e = essentials(input)
  const episode = input.records.find((x) => x.id === episodeId && x.content.kind === 'episode')
  if (!episode) throw new Error('That episode is no longer there.')
  const f = episode.content.fields
  const from = opts.full ? null : opts.from
  const inRange = (stamp: string | undefined) => from === null || parseStamp(stamp) >= from
  const entries = input.records
    .filter((x) => x.content.kind === 'entry' && x.content.fields.episodeId === episodeId)
    .sort((a, b) => (a.content.fields.at ?? '').localeCompare(b.content.fields.at ?? '') || (a.createdAt ?? 0) - (b.createdAt ?? 0))
  const plans = input.records.filter((x) => x.content.kind === 'plan' && x.content.fields.episodeId === episodeId)
  const shown = entries.filter((x) => inRange(x.content.fields.at))
  const of = (type: string) => shown.filter((x) => x.content.fields.type === type)
  const kind = opts.full ? 'Episode record' : 'Handover report'
  const r = new Report({ title: `${kind} – ${input.person.displayName} – ${f.title}`, author: input.preparedBy, header: `${kind} · ${input.person.fullName || input.person.displayName} · ${f.title} · confidential` })
  header(r, input, kind, e)

  r.heading('The illness')
  r.facts([
    ['What', f.title ?? ''],
    ['Started', stampText(parseStamp(f.started))],
    ['First symptoms', f.symptoms ?? ''],
    ['Hospital', f.hospital === 'yes' ? [f.hospitalName, f.ward].filter(Boolean).join(', ') : ''],
    ['Admitted', f.hospital === 'yes' ? stampText(parseStamp(f.admitted)) : ''],
    ['Discharged', f.discharged ? stampText(parseStamp(f.discharged)) : ''],
    ['Status', f.status === 'closed' ? `Closed ${f.closed ?? ''}` : 'Ongoing'],
    ['Outcome', f.status === 'closed' ? [f.outcome, f.outcomeNotes].filter(Boolean).join(' · ') : ''],
    ['Diagnosis', f.diagnosis || of('doctor').map((d) => d.content.fields.diagnosis).filter(Boolean).pop() || ''],
  ])
  if (from !== null) r.muted(`This report covers ${stampText(from)} onwards. Earlier entries are left out.`)

  essentialsSection(r, input, e)

  if (plans.length) {
    r.heading('Medicine plans (as prescribed)')
    r.table(
      [
        { title: 'Medicine', width: 3, bold: true },
        { title: 'Dose and how often', width: 4 },
        { title: 'From', width: 2 },
        { title: 'Until', width: 2 },
      ],
      plans.map((p) => {
        const pf = p.content.fields
        return [pf.medicine ?? '', planSummary(pf), stampText(parseStamp(pf.start)), pf.stoppedAt ? `stopped ${stampText(parseStamp(pf.stoppedAt))}` : (pf.until ?? '')]
      }),
    )
  }

  const doses = of('dose')
  r.heading('Doses given')
  if (doses.length === 0) r.muted('None logged.')
  else
    r.table(
      [
        { title: 'Time', width: 2 },
        { title: 'Medicine', width: 3, bold: true },
        { title: 'Amount', width: 2 },
        { title: 'By', width: 2 },
        { title: 'Notes', width: 4 },
      ],
      doses.map((d) => {
        const df = d.content.fields
        return [
          stampText(parseStamp(df.at)),
          df.medicine ?? '',
          df.skipped === 'yes' ? 'not given' : (df.amount ?? ''),
          df.by ?? '',
          [df.skipped === 'yes' && df.skipReason, df.override && `given against a warning: ${df.override}`].filter(Boolean).join(' · '),
        ]
      }),
      { highlight: (i) => !!doses[i]!.content.fields.override },
    )

  // Charts: temperature, and the vitals logged in hospital.
  const label = (t: number) => stampText(t)
  const temps = temperatures(shown.map((x) => x.content)).map((t) => ({ at: parseStamp(t.at), value: t.value }))
  const series = (key: string) =>
    of('vitals')
      .map((v) => ({ at: parseStamp(v.content.fields.at), value: Number(String(v.content.fields[key] ?? '').replace(',', '.')) }))
      .filter((p) => !Number.isNaN(p.at) && Number.isFinite(p.value) && p.value > 0)
  if (temps.length || of('vitals').length) {
    r.heading('Temperature and vitals', 200)
    r.chart('Temperature', '°C', temps, { reference: 38, label })
    r.chart('Heart rate', 'per minute', series('heartRate'), { label })
    r.chart('Breathing rate', 'per minute', series('breathing'), { label })
    r.chart('Oxygen saturation', '%', series('oxygen'), { label })
    if (of('vitals').length)
      r.table(
        [
          { title: 'Time', width: 2 },
          { title: 'Temp °C', width: 1 },
          { title: 'Heart', width: 1 },
          { title: 'Breaths', width: 1 },
          { title: 'SpO2 %', width: 1 },
          { title: 'BP', width: 1 },
          { title: 'Weight', width: 1 },
          { title: 'Notes', width: 3 },
        ],
        of('vitals').map((v) => {
          const vf = v.content.fields
          return [stampText(parseStamp(vf.at)), vf.temperature ?? '', vf.heartRate ?? '', vf.breathing ?? '', vf.oxygen ?? '', vf.bp ?? '', vf.weight ?? '', vf.note ?? '']
        }),
      )
  }

  const doctors = shown.filter((x) => x.content.fields.type === 'doctor' || x.content.fields.type === 'round')
  if (doctors.length) {
    r.heading('Doctors’ notes')
    for (const d of doctors) {
      const df = d.content.fields
      r.subheading(`${stampText(parseStamp(df.at))} · ${contactName(input.contacts, df.contactId) || df.who || (df.type === 'round' ? 'Ward round' : 'Doctor')}`)
      r.facts([
        ['Diagnosis', df.diagnosis ?? ''],
        ['Said', df.said ?? ''],
        ['Instructions', df.instructions ?? ''],
        ['Decided', df.decisions ?? ''],
        ['Questions', df.questions ?? ''],
        ['Notes', df.note ?? ''],
      ])
      r.space(4)
    }
  }

  const tests = of('test')
  if (tests.length) {
    r.heading('Tests and results')
    r.table(
      [
        { title: 'Time', width: 2 },
        { title: 'Test', width: 3, bold: true },
        { title: 'Result', width: 6 },
      ],
      tests.map((t) => [stampText(parseStamp(t.content.fields.at)), t.content.fields.what ?? '', t.content.fields.result ?? '']),
    )
  }

  if (f.discharged && (from === null || parseStamp(f.discharged) >= from)) {
    r.heading('Discharge')
    r.facts([
      ['Discharged', stampText(parseStamp(f.discharged))],
      ['Summary', f.dischargeSummary ?? ''],
      ['Medicines home', f.medicinesHome ?? ''],
    ])
  }

  // Everything else, in order: observations, feelings, notes (and, in the full record, every entry).
  const rest = opts.full ? shown : shown.filter((x) => ['observation', 'feeling', 'note'].includes(x.content.fields.type ?? ''))
  if (rest.length) {
    r.heading(opts.full ? 'Timeline (everything, oldest first)' : 'Observations and notes')
    r.table(
      [
        { title: 'Time', width: 2 },
        { title: 'What', width: 2 },
        { title: 'Details', width: 7 },
        { title: 'By', width: 2 },
      ],
      rest.map((x) => {
        const xf = x.content.fields
        const details = [
          xf.type === 'feeling' ? optionLabel(FEELINGS, xf.feeling ?? '') : entrySummary(xf),
          xf.override && `given against a warning: ${xf.override}`,
          xf.skipReason && `not given: ${xf.skipReason}`,
          xf.said,
          xf.instructions,
          xf.decisions,
          xf.questions && `questions: ${xf.questions}`,
          xf.result,
          xf.note,
          x.content.documents.length > 0 && `documents: ${x.content.documents.map((d) => d.name).join(', ')}`,
        ]
          .filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i)
          .join(' · ')
        return [stampText(parseStamp(xf.at)), optionLabel(ENTRY_TYPES, xf.type ?? 'note'), details, xf.by ?? '']
      }),
    )
  }

  if (opts.full) {
    const docs: { doc: LinkedDocument; where: string }[] = []
    for (const d of episode.content.documents) docs.push({ doc: d, where: 'Hospital stay' })
    for (const x of entries) for (const d of x.content.documents) docs.push({ doc: d, where: `${optionLabel(ENTRY_TYPES, x.content.fields.type ?? 'note')}, ${stampText(parseStamp(x.content.fields.at))}` })
    r.heading('Documents')
    if (docs.length === 0) r.muted('No documents linked.')
    else {
      r.muted('Kept in Family Hub, in the parents-only Health folder in Files.')
      const cols: Column[] = [
        { title: 'Document', width: 3, bold: true },
        { title: 'Linked to', width: 3 },
      ]
      r.table(
        cols,
        docs.map((d) => [d.doc.name, d.where]),
      )
    }
  }
  return r.finish(`Family Hub · ${input.person.displayName} · ${f.title} · ${longDate(e.today)}`)
}

// ---- the emergency card ----------------------------------------------------------------------

/** What one person's offline emergency card shows. Kept on the phone, encrypted. */
export interface EmergencyCard {
  name: string
  birthDate: string
  idNumber: string
  bloodType: string
  severeAllergies: string[]
  otherAllergies: string[]
  conditions: string[]
  medicines: string[]
  careNotes: string
  contacts: { label: string; name: string; phone: string }[]
  medicalAid: { scheme: string; plan: string; number: string; dependantCode: string; phone: string } | null
  /** When it was made (ms). */
  updatedAt: number
}

export function emergencyCard(input: ReportInput): EmergencyCard {
  const e = essentials(input)
  const contact = (label: string, id: string | null | undefined) => {
    const c = id ? input.contacts.find((x) => x.id === id) : undefined
    return c ? [{ label, name: c.name, phone: c.phones[0]?.number ?? '' }] : []
  }
  const doctors = e
    .of('provider')
    .filter((p) => p.content.fields.main === 'yes')
    .flatMap((p) => contact('Doctor', p.content.fields.contactId))
  const medical = input.person.medical ?? {}
  return {
    name: input.person.fullName || input.person.displayName,
    birthDate: e.birthDate ?? '',
    idNumber: input.person.idNumber ?? '',
    bloodType: e.basics.bloodType ?? '',
    severeAllergies: e.severe.map((a) => allergyLine(a.content.fields)),
    otherAllergies: e.allergies.filter((a) => !e.severe.includes(a)).map((a) => allergyLine(a.content.fields)),
    conditions: e.conditions.map((c) => c.content.fields.name ?? '').filter(Boolean),
    medicines: e.medicines.map((m) => [[m.content.fields.name, m.content.fields.strength].filter(Boolean).join(' '), m.content.fields.dose].filter(Boolean).join(' · ')),
    careNotes: e.basics.careNotes ?? '',
    contacts: [...contact('First call', input.person.emergency?.primary), ...contact('If no answer', input.person.emergency?.backup), ...doctors],
    medicalAid: medical.scheme
      ? { scheme: medical.scheme, plan: medical.plan ?? '', number: medical.membershipNumber ?? '', dependantCode: medical.dependantCode ?? '', phone: contactPhone(input.contacts, medical.schemeContact) }
      : null,
    updatedAt: input.now,
  }
}
