import { describe, expect, it } from 'vitest'
import { easter, southAfricanHolidays } from '../src/holidays.ts'

describe('South African public holidays', () => {
  it('finds Easter', () => {
    expect(easter(2024)).toBe('2024-03-31')
    expect(easter(2025)).toBe('2025-04-20')
    expect(easter(2026)).toBe('2026-04-05')
    expect(easter(2027)).toBe('2027-03-28')
  })

  it('lists 2026, with Sunday holidays observed on the Monday', () => {
    const h = southAfricanHolidays(2026)
    expect(h.map((x) => `${x.date} ${x.name}`)).toEqual([
      '2026-01-01 New Year’s Day',
      '2026-03-21 Human Rights Day',
      '2026-04-03 Good Friday',
      '2026-04-06 Family Day',
      '2026-04-27 Freedom Day',
      '2026-05-01 Workers’ Day',
      '2026-06-16 Youth Day',
      '2026-08-09 National Women’s Day',
      '2026-08-10 Public holiday (National Women’s Day observed)',
      '2026-09-24 Heritage Day',
      '2026-12-16 Day of Reconciliation',
      '2026-12-25 Christmas Day',
      '2026-12-26 Day of Goodwill',
    ])
  })
})
