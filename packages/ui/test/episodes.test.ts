import { describe, expect, it } from 'vitest'
import { doseReminders, doseWarnings, HOUR, localStamp, parseStamp, planStatus, planSummary, temperatures, timeSlots, type Dose, type Plan } from '../src/health/episodes.ts'
import type { HealthContent } from '../src/health/model.ts'
import { healthReminders } from '../src/health/reminders.ts'

const t = (stamp: string) => parseStamp(stamp)
const plan = (fields: Record<string, string>): Plan => ({ id: 'p1', fields: { start: '2026-11-20T08:00', ...fields } })
const dose = (stamp: string, extra: Partial<Dose> = {}): Dose => ({ planId: 'p1', at: t(stamp), ...extra })

describe('local times', () => {
  it('round-trip', () => {
    expect(localStamp(t('2026-11-20T14:30'))).toBe('2026-11-20T14:30')
    expect(parseStamp('not a time')).toBeNaN()
  })
})

describe('a plan every so many hours', () => {
  const p = plan({ mode: 'interval', everyHours: '6', amount: '5 ml' })

  it('reads as prescribed', () => {
    expect(planSummary(p.fields)).toBe('5 ml every 6 hours')
    expect(planSummary({ mode: 'times', times: '20:00, 08:00', amount: '1 tablet', maxPer24: '2' })).toBe('1 tablet at 08:00 and 20:00 (at most 2 in 24 hours)')
    expect(planSummary({ mode: 'prn', minGapHours: '4', maxPer24: '4' })).toBe('when needed (at least 4 h apart, at most 4 in 24 hours)')
  })

  it('knows the next dose, and when it is late', () => {
    const doses = [dose('2026-11-20T08:00'), dose('2026-11-20T14:10')]
    const s = planStatus(p, doses, t('2026-11-20T18:00'))
    expect(s.next).toBe(t('2026-11-20T20:10'))
    expect(s.late).toBe(false)
    expect(s.missed).toBe(0)
    expect(s.inLast24).toBe(2)
    expect(planStatus(p, doses, t('2026-11-20T20:30')).late).toBe(true)
  })

  it('counts missed doses: a gap of about two intervals or more', () => {
    // 08:00 given, 14:00 missed, 20:00 given; now 23:00.
    expect(planStatus(p, [dose('2026-11-20T08:00'), dose('2026-11-20T20:00')], t('2026-11-20T23:00')).missed).toBe(1)
    // Nothing given since the plan started at 08:00: at 16:30 the 08:00 dose was missed and the 14:00 one is late;
    // by 17:30 the 14:00 one is missed too (half an interval's grace), and the next is 20:00.
    const s = planStatus(p, [], t('2026-11-20T16:30'))
    expect([s.missed, s.next, s.late]).toEqual([1, t('2026-11-20T14:00'), true])
    const later = planStatus(p, [], t('2026-11-20T17:30'))
    expect([later.missed, later.next, later.late]).toEqual([2, t('2026-11-20T20:00'), false])
  })

  it('warns only from the prescription: too soon, and more than the daily maximum', () => {
    const doses = [dose('2026-11-20T08:00', { id: 'a' })]
    expect(doseWarnings(p, doses, t('2026-11-20T14:00'))).toEqual([])
    expect(doseWarnings(p, doses, t('2026-11-20T12:10'))[0]).toMatch(/Too soon: .* at least 6 hours apart, and the last dose was 4 h 10 min before/)
    // Editing the dose itself is not "too soon" after itself.
    expect(doseWarnings(p, doses, t('2026-11-20T08:20'), 'a')).toEqual([])
    const capped = plan({ mode: 'prn', maxPer24: '3' })
    const three = ['2026-11-20T08:00', '2026-11-20T12:00', '2026-11-20T16:00'].map((s) => dose(s))
    expect(doseWarnings(capped, three, t('2026-11-20T20:00'))[0]).toMatch(/at most 3 in 24 hours, and this would make 4/)
    expect(doseWarnings(capped, three, t('2026-11-21T08:30'))).toEqual([])
    // With no limits entered, there is nothing to warn about.
    expect(doseWarnings(plan({ mode: 'prn' }), three, t('2026-11-20T16:05'))).toEqual([])
    expect(doseWarnings({ id: 'p1', fields: { ...p.fields, stoppedAt: '2026-11-21T09:00' } }, doses, t('2026-11-21T10:00'))).toContain('This plan has been stopped.')
  })

  it('reminds only the next dose', () => {
    expect(doseReminders(p, [dose('2026-11-20T08:00')], t('2026-11-20T09:00'))).toEqual([t('2026-11-20T14:00')])
    // Ended: no more reminders.
    expect(doseReminders({ id: 'p1', fields: { ...p.fields, until: '2026-11-20' } }, [dose('2026-11-20T20:00')], t('2026-11-20T21:00'))).toEqual([])
  })
})

describe('a plan at set times', () => {
  const p = plan({ mode: 'times', times: '08:00,14:00,20:00', until: '2026-11-22' })

  it('matches doses to their slots, and finds the missed ones', () => {
    const doses = [dose('2026-11-20T08:20'), dose('2026-11-20T20:00', { skipped: true })]
    const slots = timeSlots(p.fields, doses, t('2026-11-20T00:00'), t('2026-11-20T23:59'), t('2026-11-20T21:00'))
    expect(slots.map((s) => s.state)).toEqual(['given', 'missed', 'skipped'])
    const s = planStatus(p, doses, t('2026-11-20T21:00'))
    expect(s.missed).toBe(1)
    expect(s.next).toBe(t('2026-11-21T08:00'))
    expect(planStatus(p, doses, t('2026-11-21T08:30')).late).toBe(true)
  })

  it('reminds each slot still to come, until the plan ends', () => {
    const r = doseReminders(p, [dose('2026-11-20T08:00')], t('2026-11-20T09:00'))
    expect(r.map(localStamp)).toEqual(['2026-11-20T14:00', '2026-11-20T20:00', '2026-11-21T08:00', '2026-11-21T14:00', '2026-11-21T20:00', '2026-11-22T08:00', '2026-11-22T14:00', '2026-11-22T20:00'])
  })
})

describe('episodes in the health reminders', () => {
  const rec = (id: string, kind: HealthContent['kind'], fields: Record<string, string>) => ({ id, content: { kind, fields, documents: [], changes: [] } as HealthContent })

  it('remind doses of open episodes only, to the minute', () => {
    const records = [
      rec('e1', 'episode', { title: 'Fever', status: 'open' }),
      rec('p1', 'plan', { episodeId: 'e1', medicine: 'Paracetamol', mode: 'interval', everyHours: '6', start: '2026-11-20T08:00' }),
      rec('d1', 'entry', { episodeId: 'e1', type: 'dose', planId: 'p1', at: '2026-11-20T08:05' }),
      rec('e2', 'episode', { title: 'Old', status: 'closed' }),
      rec('p2', 'plan', { episodeId: 'e2', medicine: 'Old', mode: 'interval', everyHours: '6', start: '2026-11-20T08:00' }),
    ]
    const r = healthReminders(records, undefined, '2026-11-20', t('2026-11-20T09:00'))
    expect(r).toEqual([{ title: 'Dose due: Paracetamol', date: '2026-11-20T14:05', leads: [0], source: 'p1:dose:2026-11-20T14:05' }])
  })

  it('chart temperatures from observations and vitals', () => {
    const e = (type: string, at: string, temperature: string) => ({ fields: { type, at, temperature } })
    expect(temperatures([e('vitals', '2026-11-20T10:00', '38,4'), e('observation', '2026-11-20T08:00', '39.1'), e('note', '2026-11-20T09:00', '37'), e('observation', '2026-11-20T11:00', '391')])).toEqual([
      { at: '2026-11-20T08:00', value: 39.1 },
      { at: '2026-11-20T10:00', value: 38.4 },
    ])
  })
})

describe('hours', () => {
  it('are hours', () => expect(HOUR).toBe(3_600_000))
})
