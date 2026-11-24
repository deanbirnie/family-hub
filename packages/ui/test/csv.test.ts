import { describe, expect, it } from 'vitest'
import { findHeaderRow, guessMapping, parseCsv, readAmount, readDate, readRows, ruleMatchFor, signatureOf } from '../src/money/csv.ts'

describe('reading a bank export', () => {
  it('splits CSV with quotes, separators inside quotes, and other separators', () => {
    expect(parseCsv('﻿a,b,c\r\n"1,5","say ""hi""",x\n\n')).toEqual([
      ['a', 'b', 'c'],
      ['1,5', 'say "hi"', 'x'],
    ])
    expect(parseCsv('Date;Description;Amount\n2026-11-02;Shop;-12,50')).toEqual([
      ['Date', 'Description', 'Amount'],
      ['2026-11-02', 'Shop', '-12,50'],
    ])
    expect(parseCsv('a\tb\tc\n1\t2\t3')[1]).toEqual(['1', '2', '3'])
  })

  it('finds the header row below a preamble', () => {
    const rows = parseCsv('Account statement\nAccount,Joint\n\nDate,Description,Amount,Balance\n2026-11-02,Shop,-12.50,100.00')
    expect(findHeaderRow(rows)).toBe(2)
    expect(signatureOf(rows[2]!)).toBe('date|description|amount|balance')
  })

  it('reads dates in each style, and refuses impossible ones', () => {
    expect(readDate('2026-11-02', 'dmy')).toBe('2026-11-02')
    expect(readDate('02/11/2026', 'dmy')).toBe('2026-11-02')
    expect(readDate('11/02/2026', 'mdy')).toBe('2026-11-02')
    expect(readDate('2 Nov 2026', 'dmy')).toBe('2026-11-02')
    expect(readDate('02-Nov-2026', 'dmy')).toBe('2026-11-02')
    expect(readDate('2026/11/02 14:30', 'ymd')).toBe('2026-11-02')
    expect(readDate('31/02/2026', 'dmy')).toBeNull()
    expect(readDate('Total', 'dmy')).toBeNull()
  })

  it('reads amounts however the bank writes them', () => {
    expect(readAmount('-1 234.50', '.')).toBe(-123450)
    expect(readAmount('1.234,50', ',')).toBe(123450)
    expect(readAmount('(45.00)', '.')).toBe(-4500)
    expect(readAmount('12.00-', '.')).toBe(-1200)
    expect(readAmount('R 12', '.')).toBe(1200)
    expect(readAmount('', '.')).toBeNull()
    expect(readAmount('n/a', '.')).toBeNull()
  })

  it('reads rows by a mapping: one amount column, or money in and out', () => {
    const rows = parseCsv('Date,Description,Reference,Money In,Money Out\n02/11/2026,WOOLWORTHS,Card 1234,,450.00\n03/11/2026,SALARY,ACME,25000.00,\n,Closing balance,,,')
    const m = guessMapping(rows[0]!, 0, rows.slice(1))
    expect(m).toMatchObject({ date: 0, dateStyle: 'dmy', description: [1], amount: null, moneyIn: 3, moneyOut: 4 })
    const read = readRows(rows, { ...m, description: [1, 2] })
    expect(read.rows).toEqual([
      { date: '2026-11-02', description: 'WOOLWORTHS Card 1234', amount: -45000 },
      { date: '2026-11-03', description: 'SALARY ACME', amount: 2_500_000 },
    ])
    expect(read.unread).toBe(1)
    const single = parseCsv('Posting Date,Description,Amount\n2026-11-02,Shop,-12.50')
    expect(readRows(single, guessMapping(single[0]!, 0, single.slice(1))).rows).toEqual([{ date: '2026-11-02', description: 'Shop', amount: -1250 }])
  })

  it('suggests what a rule should match', () => {
    expect(ruleMatchFor('POS PURCHASE WOOLWORTHS SEA POINT 1234 02/11')).toBe('woolworths sea')
    expect(ruleMatchFor('Netflix.com')).toBe('netflix com')
  })
})
