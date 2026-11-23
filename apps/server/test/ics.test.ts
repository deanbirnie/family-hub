import { describe, expect, it } from 'vitest'
import { parseIcs, readRRule } from '../src/ics.ts'

const ZONE = 'Africa/Johannesburg'

// A Google Calendar export (UTC times, a weekly series, a folded description,
// a changed day that is left out), a school's all-day term dates, and an
// Outlook event with a Windows time zone name.
const GOOGLE = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VTIMEZONE\r
TZID:Africa/Johannesburg\r
BEGIN:STANDARD\r
DTSTART:19700101T000000\r
TZOFFSETFROM:+0200\r
TZOFFSETTO:+0200\r
END:STANDARD\r
END:VTIMEZONE\r
BEGIN:VEVENT\r
UID:abc123@google.com\r
DTSTART:20261124T070000Z\r
DTEND:20261124T080000Z\r
RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261231T215959Z\r
SUMMARY:Swimming\\, squad A\r
LOCATION:Ballito pool\r
DESCRIPTION:Bring goggles\\nand a towel. This line is long enough that Google \r
 folds it onto the next line.\r
BEGIN:VALARM\r
SUMMARY:Ignore me\r
END:VALARM\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:abc123@google.com\r
RECURRENCE-ID:20261126T070000Z\r
DTSTART:20261126T080000Z\r
SUMMARY:Swimming (late)\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:term4@school\r
DTSTART;VALUE=DATE:20261007\r
DTEND;VALUE=DATE:20261210\r
SUMMARY:Term 4\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:ny@outlook\r
DTSTART;TZID="Eastern Standard Time":20261201T090000\r
DURATION:PT1H30M\r
SUMMARY:Call\r
STATUS:CANCELLED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:ny2@example\r
DTSTART;TZID=America/New_York:20261201T090000\r
DTEND;TZID=America/New_York:20261201T100000\r
SUMMARY:Call with New York\r
END:VEVENT\r
END:VCALENDAR\r
`

describe('reading .ics files', () => {
  it('reads Google, school and Outlook events into the family’s time zone', () => {
    const events = parseIcs(GOOGLE, ZONE)
    expect(events.map((e) => e.uid)).toEqual(['abc123@google.com', 'term4@school', 'ny@outlook', 'ny2@example'])
    expect(events[0]).toEqual({
      uid: 'abc123@google.com',
      title: 'Swimming, squad A',
      allDay: false,
      start: '2026-11-24T09:00',
      end: '2026-11-24T10:00',
      location: 'Ballito pool',
      notes: 'Bring goggles\nand a towel. This line is long enough that Google folds it onto the next line.',
      repeat: { freq: 'weekly', interval: 1, byDay: ['TU', 'TH'], until: '2026-12-31' },
      cancelled: false,
    })
    // All-day: iCalendar's end is the day after; the hub keeps the last day.
    expect(events[1]).toMatchObject({ allDay: true, start: '2026-10-07', end: '2026-12-09' })
    // A Windows zone name is taken as the family's own; a duration gives the end; cancelled is kept.
    expect(events[2]).toMatchObject({ start: '2026-12-01T09:00', end: '2026-12-01T10:30', cancelled: true })
    // A named zone is converted: 09:00 in New York is 16:00 in Johannesburg.
    expect(events[3]).toMatchObject({ start: '2026-12-01T16:00', end: '2026-12-01T17:00' })
  })

  it('keeps simple repeat rules and drops ones the hub cannot hold', () => {
    expect(readRRule('FREQ=MONTHLY;BYDAY=2TU')).toEqual({ freq: 'monthly', interval: 1, monthlyBy: 'weekday' })
    expect(readRRule('FREQ=YEARLY;COUNT=3')).toEqual({ freq: 'yearly', interval: 1, count: 3 })
    expect(readRRule('FREQ=MONTHLY;BYMONTHDAY=1,15')).toBe('unsupported')
    expect(readRRule('FREQ=HOURLY')).toBe('unsupported')
  })

  it('ignores what is not an event', () => {
    expect(parseIcs('hello', ZONE)).toEqual([])
    expect(parseIcs('BEGIN:VEVENT\r\nSUMMARY:No start or UID\r\nEND:VEVENT\r\n', ZONE)).toEqual([])
  })
})
