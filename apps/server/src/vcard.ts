/**
 * Getting people in and out of Family Hub, with no dependencies:
 *
 * - vCard 3.0 export, readable by Google Contacts, Android and Apple
 *   Contacts: birthdays (year-less ones as --MM-DD), anniversaries and other
 *   dates, and related names (spouse, children, ...) in the X-AB* form those
 *   apps use.
 * - vCard import (2.1, 3.0 and 4.0, including the quoted-printable text old
 *   Android exports use), for a preview the parent confirms. Nothing read
 *   here is stored until then.
 * - An iCalendar (.ics) file of birthdays and anniversaries as yearly events.
 * - Postal addresses as CSV, for labels.
 */
import type { Contact, ImportantDate, Relation } from './routes/contacts.ts'
import { parseDate } from './schedule.ts'

// ---- writing ---------------------------------------------------------------------------

export const escapeText = (v: string) => v.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`)

/** Folds a line at 75 octets (RFC 6350 / RFC 5545) without splitting a character. */
export function fold(line: string): string {
  const out: string[] = []
  let current = ''
  let bytes = 0
  for (const ch of line) {
    const n = Buffer.byteLength(ch)
    if (bytes + n > (out.length ? 74 : 75)) {
      out.push(current)
      current = ''
      bytes = 0
    }
    current += ch
    bytes += n
  }
  out.push(current)
  return out.join('\r\n ')
}

const TEL_TYPES: Record<Contact['phones'][number]['label'], string> = { mobile: 'CELL', home: 'HOME', work: 'WORK', other: 'VOICE' }

/** Apple's (and Google's) labels for related names, from the other person's point of view. */
const RELATED_LABELS: Record<Relation['kind'], string> = {
  partner: '_$!<Partner>!$_',
  child: '_$!<Child>!$_',
  parent: '_$!<Parent>!$_',
  sibling: 'Sibling',
  grandparent: 'Grandparent',
  grandchild: 'Grandchild',
  friend: '_$!<Friend>!$_',
  colleague: 'Colleague',
  other: 'Other',
}

/** A date as vCard 3.0 writes it: YYYY-MM-DD, or --MM-DD without a year. */
const vcardDate = (date: string) => date

export interface Related {
  name: string
  /** What they are to this contact. */
  kind: Relation['kind']
  label: string
}

export function toVCard(c: Contact, withNotes: boolean, related: Related[] = []): string {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escapeText(c.name)}`, `N:${escapeText(c.name)};;;;`]
  if (c.organisation) lines.push(`ORG:${escapeText(c.organisation)}`)
  if (c.role) lines.push(`TITLE:${escapeText(c.role)}`)
  for (const p of c.phones) lines.push(`TEL;TYPE=${TEL_TYPES[p.label]}:${escapeText(p.number)}`)
  for (const e of c.emails) lines.push(`EMAIL;TYPE=INTERNET:${escapeText(e)}`)
  if (c.address) lines.push(`ADR;TYPE=HOME:;;${escapeText(c.address)};;;;`)
  let item = 0
  const birthday = c.dates.find((d) => d.kind === 'birthday')
  if (birthday) lines.push(`BDAY:${vcardDate(birthday.date)}`)
  for (const d of c.dates) {
    if (d === birthday) continue
    item++
    const label = d.kind === 'anniversary' ? '_$!<Anniversary>!$_' : escapeText(d.label || (d.kind === 'memorial' ? 'Memorial' : d.kind === 'birthday' ? 'Birthday' : 'Other'))
    lines.push(`item${item}.X-ABDATE:${vcardDate(d.date)}`, `item${item}.X-ABLabel:${label}`)
  }
  for (const r of related) {
    item++
    lines.push(`item${item}.X-ABRELATEDNAMES:${escapeText(r.name)}`, `item${item}.X-ABLabel:${r.kind === 'other' ? escapeText(r.label || 'Other') : RELATED_LABELS[r.kind]}`)
  }
  if (withNotes && c.note) lines.push(`NOTE:${escapeText(c.note)}`)
  lines.push('END:VCARD')
  return lines.map(fold).join('\r\n') + '\r\n'
}

export interface CalendarEntry {
  uid: string
  summary: string
  date: ImportantDate['date']
}

/** Birthdays and anniversaries as all-day yearly events (iCalendar, RFC 5545). */
export function toICS(entries: CalendarEntry[], nowMs: number, thisYear: number): string {
  const stamp = new Date(nowMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Family Hub//People and dates//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Family Hub birthdays']
  for (const e of entries) {
    const p = parseDate(e.date)
    if (!p) continue
    // Without a year, the series starts this year; with one, from the original date.
    const year = p.year ?? thisYear
    const leapDay = p.month === 2 && p.day === 29
    const start = `${year}${String(p.month).padStart(2, '0')}${String(p.day).padStart(2, '0')}`
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.uid}`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${start}`,
      // 29 February falls on the last day of February in other years.
      leapDay ? 'RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=-1' : 'RRULE:FREQ=YEARLY',
      `SUMMARY:${escapeText(e.summary)}`,
      'TRANSP:TRANSPARENT',
      'END:VEVENT',
    )
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

/** A CSV cell, safe to open in a spreadsheet (no formulas). */
const cell = (v: string) => {
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return `"${safe.replace(/"/g, '""')}"`
}

/** Name and postal address per line, for printing labels. */
export function toLabelsCsv(contacts: Pick<Contact, 'name' | 'address'>[]): string {
  const rows = [['Name', 'Address'], ...contacts.filter((c) => c.address.trim()).map((c) => [c.name, c.address.trim()])]
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

// ---- reading ---------------------------------------------------------------------------

export interface ImportedContact {
  name: string
  organisation: string
  role: string
  phones: { label: Contact['phones'][number]['label']; number: string }[]
  emails: string[]
  address: string
  note: string
  dates: { kind: ImportantDate['kind']; label: string; date: string }[]
  related: { name: string; kind: Relation['kind']; label: string }[]
}

interface Property {
  group: string
  name: string
  params: Record<string, string[]>
  value: string
}

function decodeQuotedPrintable(value: string, charset: string): string {
  const bytes: number[] = []
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(value.slice(i + 1, i + 3))) {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16))
      i += 2
    } else {
      bytes.push(...Buffer.from(ch, 'utf8'))
    }
  }
  return Buffer.from(bytes).toString(/^utf-?8$/i.test(charset) || !charset ? 'utf8' : 'latin1')
}

/** Splits a vCard file into its cards' properties, unfolding lines. */
function readCards(text: string): Property[][] {
  // Unfold: a line break followed by a space or tab continues the line. Old
  // quoted-printable lines end with "=" and continue on the next line.
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines: string[] = []
  for (const line of raw.split('\n')) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length) lines[lines.length - 1] += line.slice(1)
    else if (lines.length && /ENCODING=QUOTED-PRINTABLE/i.test(lines[lines.length - 1]!) && lines[lines.length - 1]!.endsWith('=')) {
      lines[lines.length - 1] = lines[lines.length - 1]!.slice(0, -1) + line
    } else lines.push(line)
  }
  const cards: Property[][] = []
  let current: Property[] | null = null
  for (const line of lines) {
    const colon = line.indexOf(':')
    if (colon < 0) continue
    const head = line.slice(0, colon)
    let value = line.slice(colon + 1)
    const [nameWithGroup, ...paramParts] = head.split(';')
    const dot = nameWithGroup!.indexOf('.')
    const group = dot >= 0 ? nameWithGroup!.slice(0, dot).toLowerCase() : ''
    const name = (dot >= 0 ? nameWithGroup!.slice(dot + 1) : nameWithGroup!).toUpperCase()
    const params: Record<string, string[]> = {}
    for (const part of paramParts) {
      const eq = part.indexOf('=')
      // vCard 2.1 allows bare types: TEL;CELL:...
      const key = (eq >= 0 ? part.slice(0, eq) : 'TYPE').toUpperCase()
      const vals = (eq >= 0 ? part.slice(eq + 1) : part).split(',').map((v) => v.replace(/^"|"$/g, '').toUpperCase())
      params[key] = [...(params[key] ?? []), ...vals]
    }
    if (params.ENCODING?.includes('QUOTED-PRINTABLE')) value = decodeQuotedPrintable(value, params.CHARSET?.[0] ?? 'UTF-8')
    if (name === 'BEGIN' && value.toUpperCase() === 'VCARD') current = []
    else if (name === 'END' && value.toUpperCase() === 'VCARD') {
      if (current) cards.push(current)
      current = null
    } else if (current) current.push({ group, name, params, value })
  }
  return cards
}

const unescapeText = (v: string) => v.replace(/\\([nN])/g, '\n').replace(/\\([,;:\\])/g, '$1')

/** Splits a structured value (N, ADR) on unescaped semicolons. */
const components = (v: string) => v.split(/(?<!\\);/).map(unescapeText)

/** Reads the date forms phones and apps write; null if it is not a date. */
export function readVCardDate(value: string, params: Record<string, string[]> = {}): string | null {
  const v = value.trim()
  let m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(v)
  if (m) {
    // Apple writes a birthday without a year as 1604-MM-DD with X-APPLE-OMIT-YEAR.
    const omit = params['X-APPLE-OMIT-YEAR']?.[0]
    const date = omit && omit === m[1] ? `--${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}`
    return parseDate(date) ? date : null
  }
  m = /^--(\d{2})-?(\d{2})$/.exec(v)
  if (m) {
    const date = `--${m[1]}-${m[2]}`
    return parseDate(date) ? date : null
  }
  return null
}

const RELATED_FROM_LABEL: [RegExp, Relation['kind']][] = [
  [/spouse|partner|wife|husband/i, 'partner'],
  [/child|son|daughter/i, 'child'],
  [/parent|mother|father|mom|mum|dad/i, 'parent'],
  [/brother|sister|sibling/i, 'sibling'],
  [/grandchild|grandson|granddaughter/i, 'grandchild'],
  [/grand(parent|mother|father)|gran|granny|grandpa/i, 'grandparent'],
  [/friend/i, 'friend'],
  [/colleague|manager|assistant/i, 'colleague'],
]

const appleLabel = (v: string) => unescapeText(v).replace(/^_\$!<(.*)>!\$_$/, '$1')

const PHONE = /^[0-9+()\-\s.]{3,40}$/

/** Reads every card in a vCard file. Fields the hub cannot hold are left out. */
export function parseVCards(text: string): ImportedContact[] {
  const out: ImportedContact[] = []
  for (const props of readCards(text)) {
    const labels = new Map(props.filter((p) => p.name === 'X-ABLABEL' && p.group).map((p) => [p.group, appleLabel(p.value)]))
    const one = (name: string) => props.find((p) => p.name === name)
    const fn = one('FN')?.value
    const n = one('N')?.value
    const nParts = n ? components(n) : []
    const name = (fn ? unescapeText(fn) : [nParts[3], nParts[1], nParts[2], nParts[0], nParts[4]].filter(Boolean).join(' ')).trim()
    const org = one('ORG') ? components(one('ORG')!.value).filter(Boolean).join(', ') : ''
    const c: ImportedContact = {
      name: (name || org || '').slice(0, 100),
      organisation: org.slice(0, 100),
      role: unescapeText(one('TITLE')?.value ?? one('ROLE')?.value ?? '').slice(0, 100),
      phones: [],
      emails: [],
      address: '',
      note: unescapeText(one('NOTE')?.value ?? '').slice(0, 2000),
      dates: [],
      related: [],
    }
    if (!c.name) continue
    for (const p of props.filter((x) => x.name === 'TEL')) {
      const types = [...(p.params.TYPE ?? []), labels.get(p.group)?.toUpperCase() ?? '']
      const number = unescapeText(p.value).replace(/^tel:/i, '').trim()
      if (!PHONE.test(number) || c.phones.length >= 5) continue
      const label = types.some((t) => t.includes('CELL') || t.includes('MOBILE')) ? 'mobile' : types.some((t) => t.includes('HOME')) ? 'home' : types.some((t) => t.includes('WORK')) ? 'work' : 'other'
      c.phones.push({ label, number })
    }
    for (const p of props.filter((x) => x.name === 'EMAIL')) {
      const e = unescapeText(p.value).replace(/^mailto:/i, '').trim()
      if (e.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && c.emails.length < 3) c.emails.push(e)
    }
    const adr = one('ADR')
    if (adr) c.address = components(adr.value).filter((x) => x.trim()).join('\n').slice(0, 400)
    const bday = one('BDAY')
    const bdayDate = bday ? readVCardDate(bday.value, bday.params) : null
    if (bdayDate) c.dates.push({ kind: 'birthday', label: '', date: bdayDate })
    for (const p of props.filter((x) => x.name === 'ANNIVERSARY' || x.name === 'X-ANNIVERSARY' || x.name === 'X-ABDATE')) {
      const date = readVCardDate(p.value, p.params)
      if (!date || c.dates.length >= 10) continue
      const label = p.name === 'X-ABDATE' ? (labels.get(p.group) ?? '') : 'Anniversary'
      if (/anniversary/i.test(label)) c.dates.push({ kind: 'anniversary', label: '', date })
      else c.dates.push({ kind: 'other', label: (label || 'Date').slice(0, 60), date })
    }
    for (const p of props.filter((x) => x.name === 'X-ABRELATEDNAMES' || x.name === 'RELATED')) {
      // RELATED (vCard 4) may be a URI; only names are useful here.
      const value = unescapeText(p.value).trim()
      if (!value || /^(urn|https?|mailto):/i.test(value)) continue
      const label = labels.get(p.group) ?? p.params.TYPE?.join(' ') ?? ''
      const kind = RELATED_FROM_LABEL.find(([re]) => re.test(label))?.[1] ?? 'other'
      c.related.push({ name: value.slice(0, 100), kind, label: kind === 'other' ? (label || 'Related').toLowerCase().slice(0, 40) : '' })
    }
    out.push(c)
  }
  return out
}
