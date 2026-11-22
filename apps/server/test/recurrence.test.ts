import { describe, expect, it } from 'vitest'
import { nthWeekday, occurrences, toRRule } from '../src/recurrence.ts'

describe('repeating events', () => {
  it('one-off events fall on their day only', () => {
    expect(occurrences('2026-11-20', null, '2026-11-01', '2026-11-30')).toEqual(['2026-11-20'])
    expect(occurrences('2026-11-20', null, '2026-12-01', '2026-12-31')).toEqual([])
  })

  it('daily, every N days, until a date or a number of times', () => {
    expect(occurrences('2026-11-20', { freq: 'daily', interval: 2, count: 3 }, '2026-11-01', '2026-12-31')).toEqual(['2026-11-20', '2026-11-22', '2026-11-24'])
    expect(occurrences('2026-11-20', { freq: 'daily', interval: 1, until: '2026-11-22' }, '2026-11-21', '2026-12-31')).toEqual(['2026-11-21', '2026-11-22'])
  })

  it('weekly on chosen days, every other week', () => {
    // 2026-11-16 is a Monday.
    expect(occurrences('2026-11-16', { freq: 'weekly', interval: 2, byDay: ['MO', 'TH'] }, '2026-11-16', '2026-12-13')).toEqual([
      '2026-11-16',
      '2026-11-19',
      '2026-11-30',
      '2026-12-03',
    ])
    // Days before the start in its first week are not included; count counts from the start.
    expect(occurrences('2026-11-19', { freq: 'weekly', interval: 1, byDay: ['MO', 'TH'], count: 3 }, '2026-11-01', '2026-12-31')).toEqual(['2026-11-19', '2026-11-23', '2026-11-26'])
  })

  it('monthly on a date (skipping months without it) or on e.g. the 2nd Tuesday or the last Friday', () => {
    expect(occurrences('2026-01-31', { freq: 'monthly', interval: 1 }, '2026-01-01', '2026-05-31')).toEqual(['2026-01-31', '2026-03-31', '2026-05-31'])
    // 2026-11-10 is the 2nd Tuesday of November.
    expect(occurrences('2026-11-10', { freq: 'monthly', interval: 1, monthlyBy: 'weekday' }, '2026-11-01', '2027-01-31')).toEqual(['2026-11-10', '2026-12-08', '2027-01-12'])
    // 2026-10-30 is the last (and 5th) Friday of October: it stays "the last Friday".
    expect(nthWeekday('2026-10-30')).toEqual({ nth: 5, last: true })
    expect(occurrences('2026-10-30', { freq: 'monthly', interval: 1, monthlyBy: 'weekday' }, '2026-10-01', '2026-12-31')).toEqual(['2026-10-30', '2026-11-27', '2026-12-25'])
  })

  it('yearly, with 29 February only in leap years', () => {
    expect(occurrences('2024-02-29', { freq: 'yearly', interval: 1 }, '2024-01-01', '2029-12-31')).toEqual(['2024-02-29', '2028-02-29'])
    expect(occurrences('2020-06-01', { freq: 'yearly', interval: 1 }, '2026-01-01', '2027-12-31')).toEqual(['2026-06-01', '2027-06-01'])
  })

  it('writes the iCalendar rule', () => {
    expect(toRRule('2026-11-16', { freq: 'weekly', interval: 2, byDay: ['MO', 'TH'], until: '2027-03-01' })).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;UNTIL=20270301')
    expect(toRRule('2026-10-30', { freq: 'monthly', interval: 1, monthlyBy: 'weekday', count: 6 })).toBe('RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=6')
    expect(toRRule('2026-11-10', { freq: 'monthly', interval: 1, monthlyBy: 'weekday' })).toBe('RRULE:FREQ=MONTHLY;BYDAY=2TU')
  })
})
