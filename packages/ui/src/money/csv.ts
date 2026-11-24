/**
 * Reading a bank's CSV export on the parent's device (phase 6c, part 2).
 * Only the transactions it finds are sent to the hub, never the file. How to
 * read a bank's layout is a saved mapping (which column is which), so a bank
 * that changes its export needs a new mapping, not new code.
 */

export interface ImportMapping {
  headerRow: number
  date: number
  dateStyle: 'ymd' | 'dmy' | 'mdy'
  description: number[]
  amount: number | null
  moneyIn: number | null
  moneyOut: number | null
  outIs: 'negative' | 'positive'
  decimal: '.' | ','
}

export interface SavedFormat {
  id: string
  name: string
  signature: string
  mapping: ImportMapping
}

/** Built-in formats for the family's banks, added once their exports' headings are known. */
export const BUILT_IN_FORMATS: Omit<SavedFormat, 'id'>[] = []

/** Rows of cells: commas, semicolons or tabs; quoted cells may hold separators, quotes ("") and line breaks. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '')
  const firstLine = src.split(/\r?\n/, 1)[0] ?? ''
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const)
  const sep = counts.sort((a, b) => b[1] - a[1])[0]![0]
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"' && cell.trim() === '') {
      quoted = true
      cell = ''
    } else if (ch === sep) {
      row.push(cell.trim())
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cell.trim())
      if (row.some((c) => c !== '')) rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  row.push(cell.trim())
  if (row.some((c) => c !== '')) rows.push(row)
  return rows
}

const looksNumeric = (c: string) => /^[-+R\s\d.,()]+$/.test(c) && /\d/.test(c)

/** The header row: the first of the first 20 with at least three cells that are mostly words. */
export function findHeaderRow(rows: string[][]): number {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const filled = rows[i]!.filter((c) => c !== '')
    if (filled.length >= 3 && filled.filter((c) => !looksNumeric(c)).length >= filled.length * 0.75) return i
  }
  return 0
}

/** What identifies a layout: its column names, lower-cased. */
export const signatureOf = (header: string[]) =>
  header
    .map((c) => c.trim().toLowerCase().replace(/\s+/g, ' '))
    .join('|')

/** A date in the given style as "YYYY-MM-DD", or null. Accepts -, / and . between parts, and "2 Nov 2026". */
export function readDate(value: string, style: ImportMapping['dateStyle']): string | null {
  const v = value.trim()
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  const named = /^(\d{1,2})[\s-]([A-Za-z]{3})[A-Za-z]*[\s-](\d{4})/.exec(v)
  let y: number, m: number, d: number
  if (named) {
    ;[d, m, y] = [Number(named[1]), months.indexOf(named[2]!.toLowerCase()) + 1, Number(named[3])]
  } else {
    const parts = v.split(/[\sT]/)[0]!.split(/[-/.]/).map(Number)
    if (parts.length !== 3 || parts.some((p) => !Number.isInteger(p))) return null
    if (style === 'ymd' || String(v.split(/[-/.]/)[0]).length === 4) [y, m, d] = parts as [number, number, number]
    else if (style === 'dmy') [d, m, y] = parts as [number, number, number]
    else [m, d, y] = parts as [number, number, number]
    if (y < 100) y += 2000
  }
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null
}

/** An amount in cents: "-1 234.50", "1234,50", "(45.00)" (negative), "R 12.00". Null if it is not one. */
export function readAmount(value: string, decimal: ImportMapping['decimal']): number | null {
  let v = value.trim().replace(/[R\s ]/gi, '')
  if (!v) return null
  let sign = 1
  if (/^\(.*\)$/.test(v)) {
    sign = -1
    v = v.slice(1, -1)
  }
  if (v.startsWith('-')) {
    sign = -sign
    v = v.slice(1)
  } else if (v.endsWith('-')) {
    sign = -sign
    v = v.slice(0, -1)
  } else if (v.startsWith('+')) v = v.slice(1)
  v = decimal === ',' ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return null
  return sign * Math.round(Number(v) * 100)
}

export interface ReadRow {
  date: string
  description: string
  amount: number
}

/** The transactions in an export, by a mapping; rows that do not read (totals, blanks) are counted, not guessed at. */
export function readRows(rows: string[][], m: ImportMapping): { rows: ReadRow[]; unread: number } {
  const out: ReadRow[] = []
  let unread = 0
  for (const r of rows.slice(m.headerRow + 1)) {
    const date = readDate(r[m.date] ?? '', m.dateStyle)
    const description = m.description
      .map((i) => r[i] ?? '')
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    let amount: number | null
    if (m.amount !== null) {
      const a = readAmount(r[m.amount] ?? '', m.decimal)
      amount = a === null ? null : m.outIs === 'negative' ? a : -a
    } else {
      const inn = readAmount(r[m.moneyIn!] ?? '', m.decimal) ?? 0
      const out = readAmount(r[m.moneyOut!] ?? '', m.decimal) ?? 0
      amount = inn === 0 && out === 0 && !(r[m.moneyIn!] || r[m.moneyOut!]) ? null : Math.abs(inn) - Math.abs(out)
    }
    if (!date || !description || amount === null) {
      unread++
      continue
    }
    out.push({ date, description: description.slice(0, 200), amount })
  }
  return { rows: out, unread }
}

/** A first guess at the mapping from the header names, for the parent to check. */
export function guessMapping(header: string[], headerRow: number, sample: string[][]): ImportMapping {
  const find = (...words: string[]) => header.findIndex((h) => words.some((w) => h.toLowerCase().includes(w)))
  const date = Math.max(0, find('transaction date', 'date'))
  const description = find('description', 'narrative', 'details', 'reference')
  const moneyIn = find('money in', 'credit', 'deposit')
  const moneyOut = find('money out', 'debit', 'withdrawal')
  const amount = find('amount')
  const dateSample = sample.map((r) => r[date] ?? '').find(Boolean) ?? ''
  const dateStyle: ImportMapping['dateStyle'] = /^\d{4}/.test(dateSample) ? 'ymd' : 'dmy'
  const amountSample = sample.map((r) => r[amount >= 0 ? amount : moneyOut] ?? '').find(Boolean) ?? ''
  const decimal: ImportMapping['decimal'] = /,\d{2}$/.test(amountSample) ? ',' : '.'
  return {
    headerRow,
    date,
    dateStyle,
    description: [description >= 0 ? description : Math.min(1, header.length - 1)],
    amount: moneyIn >= 0 && moneyOut >= 0 ? null : amount >= 0 ? amount : null,
    moneyIn: moneyIn >= 0 && moneyOut >= 0 ? moneyIn : null,
    moneyOut: moneyIn >= 0 && moneyOut >= 0 ? moneyOut : null,
    outIs: 'negative',
    decimal,
  }
}

/** The text a rule should match for a description: its first words, without card numbers and dates. */
export function ruleMatchFor(description: string): string {
  const words = description
    .replace(/\d[\d/.:-]*/g, ' ')
    .replace(/[^A-Za-z&' ]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !['pos', 'purchase', 'card', 'debit', 'order', 'payment', 'to', 'from', 'the'].includes(w.toLowerCase()))
  return words.slice(0, 2).join(' ').toLowerCase()
}
