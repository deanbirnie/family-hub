import { describe, expect, it } from 'vitest'
import { applicableLead, daysBetween, localNow, nextOccurrence, parseDate, yearsAt } from '../src/schedule.ts'

describe('reminder dates', () => {
  it('reads full and year-less dates, and refuses impossible ones', () => {
    expect(parseDate('2027-03-01')).toEqual({ year: 2027, month: 3, day: 1 })
    expect(parseDate('--03-15')).toEqual({ year: null, month: 3, day: 15 })
    expect(parseDate('--02-29')).toEqual({ year: null, month: 2, day: 29 })
    for (const bad of ['2027-02-29', '2027-13-01', '27-03-01', '2027-3-1', '--3-15', '202703-01', '1800-01-01', '']) expect(parseDate(bad)).toBeNull()
  })

  it('finds the next yearly occurrence, with 29 February on the 28th in other years', () => {
    expect(nextOccurrence({ date: '1984-11-25', yearly: true }, '2026-11-20')).toBe('2026-11-25')
    expect(nextOccurrence({ date: '--11-20', yearly: true }, '2026-11-20')).toBe('2026-11-20')
    expect(nextOccurrence({ date: '--11-19', yearly: true }, '2026-11-20')).toBe('2027-11-19')
    expect(nextOccurrence({ date: '--02-29', yearly: true }, '2026-11-20')).toBe('2027-02-28')
    expect(nextOccurrence({ date: '2000-02-29', yearly: true }, '2027-03-01')).toBe('2028-02-29')
    // One-off dates stay put, even once past.
    expect(nextOccurrence({ date: '2026-01-01', yearly: false }, '2026-11-20')).toBe('2026-01-01')
    expect(nextOccurrence({ date: '--01-01', yearly: false }, '2026-11-20')).toBeNull()
  })

  it('picks the reminder that applies, catching up on ones already passed', () => {
    const leads = [90, 30, 7]
    expect(applicableLead(120, leads)).toBeNull()
    expect(applicableLead(90, leads)).toBe(90)
    expect(applicableLead(45, leads)).toBe(90)
    expect(applicableLead(20, leads)).toBe(30)
    expect(applicableLead(0, leads)).toBe(7)
    expect(applicableLead(-1, leads)).toBeNull()
  })

  it('counts days and years', () => {
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3)
    expect(yearsAt({ date: '1986-11-25', yearly: true }, '2026-11-25')).toBe(40)
    expect(yearsAt({ date: '--11-25', yearly: true }, '2026-11-25')).toBeNull()
  })

  it('uses the family time zone for today', () => {
    // 22:30 UTC on 20 November is already 21 November in Johannesburg.
    const t = Date.UTC(2026, 10, 20, 22, 30)
    expect(localNow(t, 'UTC')).toEqual({ date: '2026-11-20', hour: 22 })
    expect(localNow(t, 'Africa/Johannesburg')).toEqual({ date: '2026-11-21', hour: 0 })
  })
})
