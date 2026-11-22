/** Important dates and relationships in Contacts (phase 3): labels, formatting and "how long until". */

export type DateKind = 'birthday' | 'anniversary' | 'memorial' | 'other'
export type Remind = 'off' | 'day' | 'week' | 'month'

export interface ImportantDate {
  id?: string
  kind: DateKind
  label: string
  /** YYYY-MM-DD, or --MM-DD when the year is not known. */
  date: string
  remind: Remind
  /** 'all' parents, or one parent's user ID. */
  remindFor: string
}

export const DATE_KINDS: Record<DateKind, string> = { birthday: 'Birthday', anniversary: 'Anniversary', memorial: 'Memorial', other: 'Other date' }
export const REMIND_LABELS: Record<Remind, string> = { off: 'No reminder', day: 'On the day', week: 'A week before, and on the day', month: 'A month before, a week before, and on the day' }
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export type RelationKind = 'partner' | 'child' | 'parent' | 'sibling' | 'grandparent' | 'grandchild' | 'friend' | 'colleague' | 'other'
export interface Relation {
  id: string
  /** a is b's <kind>. */
  a: string
  b: string
  kind: RelationKind
  label: string
}
export const RELATION_LABELS: Record<RelationKind, string> = {
  partner: 'Partner',
  child: 'Child',
  parent: 'Parent',
  sibling: 'Brother or sister',
  grandparent: 'Grandparent',
  grandchild: 'Grandchild',
  friend: 'Friend',
  colleague: 'Colleague',
  other: 'Other',
}
const INVERSE: Record<RelationKind, RelationKind> = {
  partner: 'partner',
  child: 'parent',
  parent: 'child',
  sibling: 'sibling',
  grandparent: 'grandchild',
  grandchild: 'grandparent',
  friend: 'friend',
  colleague: 'colleague',
  other: 'other',
}

/** The people linked to `id`, each with what they are to `id` ("Child", "Partner"). */
export function relativesOf(id: string, relations: Relation[]): { relation: Relation; other: string; label: string }[] {
  const out: { relation: Relation; other: string; label: string }[] = []
  for (const r of relations) {
    if (r.a === id) out.push({ relation: r, other: r.b, label: r.kind === 'other' ? r.label : RELATION_LABELS[INVERSE[r.kind]] })
    else if (r.b === id) out.push({ relation: r, other: r.a, label: r.kind === 'other' ? r.label : RELATION_LABELS[r.kind] })
  }
  return out
}

export const splitDate = (date: string) => {
  const m = /^(\d{4}|--)-?(\d{2})-(\d{2})$/.exec(date)
  return m ? { year: m[1] === '--' ? '' : m[1]!, month: Number(m[2]), day: Number(m[3]) } : { year: '', month: 0, day: 0 }
}

export const joinDate = (year: string, month: number, day: number) =>
  `${/^\d{4}$/.test(year) ? year : '--'}${/^\d{4}$/.test(year) ? '-' : ''}${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

/** "27 November 1946" or "24 June". */
export function formatImportantDate(date: string): string {
  const { year, month, day } = splitDate(date)
  if (!month) return date
  return `${day} ${MONTHS[month - 1]}${year ? ` ${year}` : ''}`
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/** Days until the date next comes round (0 = today), and the age or years then if the year is known. */
export function nextComing(date: string, today = new Date()): { days: number; years: number | null } | null {
  const { year, month, day } = splitDate(date)
  if (!month) return null
  const base = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  const at = (y: number) => Date.UTC(y, month - 1, month === 2 && day === 29 && !isLeap(y) ? 28 : day)
  let y = today.getFullYear()
  if (at(y) < base) y++
  return { days: Math.round((at(y) - base) / 86_400_000), years: year ? y - Number(year) : null }
}

export function whenWords(days: number): string {
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days < 14) return `in ${days} days`
  return `in ${Math.round(days / 7)} weeks`
}
