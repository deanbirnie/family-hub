import { describe, expect, it } from 'vitest'
import { decryptHealth, encryptHealth, type HealthContent } from '../src/health/model.ts'
import { healthReminders } from '../src/health/reminders.ts'
import { dueDate, SA_SCHEDULE, scheduleApplies } from '../src/health/vaccines.ts'

const rec = (id: string, kind: HealthContent['kind'], fields: Record<string, string>) => ({ id, content: { kind, fields, documents: [], changes: [] } as HealthContent })

describe('health records on the device', () => {
  it('are bound to their person', async () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const content: HealthContent = { kind: 'allergy', fields: { substance: 'Penicillin', severity: 'anaphylaxis' }, documents: [], changes: [] }
    const ciphertext = await encryptHealth(key, 'sam', content)
    expect(await decryptHealth(key, { profileId: 'sam', ciphertext })).toEqual(content)
    await expect(decryptHealth(key, { profileId: 'lwazi', ciphertext })).rejects.toThrow()
  })
})

describe('the vaccination schedule', () => {
  it('works out due dates from the date of birth', () => {
    expect(dueDate('2026-01-31', { days: 42 })).toBe('2026-03-14')
    expect(dueDate('2026-01-15', { months: 6 })).toBe('2026-07-15')
    expect(dueDate('2020-02-29', { years: 6 })).toBe('2026-03-01')
    expect(scheduleApplies('2020-05-01', '2026-11-23')).toBe(true)
    expect(scheduleApplies('1985-05-01', '2026-11-23')).toBe(false)
    expect(SA_SCHEDULE.map((d) => d.id)).toContain('hexa4')
  })
})

describe('health reminders', () => {
  it('cover repeats, script expiry, due and booked vaccinations, measuring, check-ups and off-calendar appointments', () => {
    const on = '2026-11-23'
    const records = [
      rec('m1', 'medicine', { name: 'Ventolin', chronic: 'yes', nextRepeat: '2026-12-01', scriptExpiry: '2027-03-01' }),
      rec('m2', 'medicine', { name: 'Old course', chronic: 'yes', end: '2026-01-01', nextRepeat: '2026-12-01' }),
      // Born 1 Sept 2026: 6-week doses are past due (given one), 14-week ones still to come.
      rec('v1', 'vaccine', { doseId: 'hexa1', status: 'given', date: '2026-10-13' }),
      rec('v2', 'vaccine', { doseId: 'rv2', status: 'held', reason: 'Doctor said wait' }),
      rec('v3', 'vaccine', { name: 'Flu', status: 'planned', due: '2027-04-01' }),
      rec('b', 'basics', { measureEvery: '3' }),
      rec('g1', 'growth', { date: '2026-10-01', height: '60' }),
      rec('c1', 'checkup', { what: 'Dentist', everyMonths: '6', last: '2026-06-10' }),
      rec('a1', 'appointment', { date: '2026-11-30', reason: 'Follow-up', calendar: 'none' }),
      rec('a2', 'appointment', { date: '2026-11-30', reason: 'On calendar', calendar: 'generic' }),
    ]
    const r = healthReminders(records, '2026-09-01', on)
    const titles = r.map((x) => `${x.date} ${x.title}`)
    expect(titles).toContain('2026-12-01 Repeat due: Ventolin')
    expect(titles).toContain('2027-03-01 Script expires: Ventolin')
    expect(titles.some((t) => t.includes('Old course'))).toBe(false)
    expect(titles).toContain('2026-12-08 Vaccination due: Hexavalent 3')
    expect(titles.some((t) => t.includes('Rotavirus 2'))).toBe(false) // held back
    expect(titles.some((t) => t.includes('Hexavalent 1 '))).toBe(false) // given
    expect(titles.some((t) => t.includes('Rotavirus 1'))).toBe(false) // overdue: shown in the app, not reminded
    expect(titles).toContain('2027-04-01 Vaccination: Flu')
    expect(titles).toContain('2027-01-01 Measure height and weight')
    expect(titles).toContain('2026-12-10 Check-up: Dentist')
    expect(titles).toContain('2026-11-30 Appointment: Follow-up')
    expect(titles.some((t) => t.includes('On calendar'))).toBe(false)
    expect([...titles].sort()).toEqual(titles)
  })
})
