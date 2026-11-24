import { describe, expect, it } from 'vitest'
import { blankBill, howOften, parseRand, rand, relative, shortDate, yearlyChange } from '../src/money/model.ts'

describe('money on the page', () => {
  it('reads amounts however they are typed', () => {
    expect(parseRand('199')).toBe(19900)
    expect(parseRand('R 1 234,50')).toBe(123450)
    expect(parseRand('1,234.50')).toBe(123450)
    expect(parseRand('1.234,5')).toBe(123450)
    expect(parseRand('R2450')).toBe(245000)
    expect(parseRand('0.05')).toBe(5)
    for (const bad of ['', 'abc', '12.345', '-5', '1 2 3,4,5']) expect(parseRand(bad)).toBeNull()
  })

  it('shows rand, how often, dates and price changes', () => {
    expect(rand(123450).replace(/ /g, ' ')).toBe('R 1 234.50')
    expect(howOften({ unit: 'month', every: 1 })).toBe('every month')
    expect(howOften({ unit: 'week', every: 2 })).toBe('every 2 weeks')
    expect(howOften({ unit: 'once', every: 1 })).toBe('once')
    expect(shortDate('2026-11-25', '2026-11-24')).toBe('25 Nov')
    expect(shortDate('2027-01-05', '2026-11-24')).toBe('5 Jan 2027')
    expect(relative('2026-11-24', '2026-11-27')).toBe('in 3 days')
    expect(relative('2026-11-24', '2026-11-21')).toBe('3 days ago')
    const b = { ...blankBill('subscription', '2026-11-24'), amount: 22900, prices: [{ from: '2025-03-01', amount: 19900 }, { from: '2026-03-01', amount: 22900 }] }
    expect(yearlyChange(b, '2026-11-24')).toBe('+15% in a year')
    expect(yearlyChange({ ...b, prices: [{ from: '2026-03-01', amount: 22900 }] }, '2026-11-24')).toBeNull()
  })
})
