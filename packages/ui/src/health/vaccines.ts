/**
 * South Africa's public childhood vaccination schedule (the Road-to-Health
 * booklet), as a checklist per child. The schedule changes from time to time:
 * the app says to check it against the child's own booklet, and each dose can
 * be marked missed, held back, not applicable or booked, and extra vaccines
 * added.
 */

export interface ScheduledDose {
  id: string
  name: string
  /** When it is due, from the date of birth. */
  age: { days?: number; months?: number; years?: number }
  label: string
}

export const SA_SCHEDULE: ScheduledDose[] = [
  { id: 'bcg', name: 'BCG (tuberculosis)', age: { days: 0 }, label: 'At birth' },
  { id: 'opv0', name: 'OPV 0 (polio drops)', age: { days: 0 }, label: 'At birth' },
  { id: 'opv1', name: 'OPV 1 (polio drops)', age: { days: 42 }, label: '6 weeks' },
  { id: 'rv1', name: 'Rotavirus 1', age: { days: 42 }, label: '6 weeks' },
  { id: 'hexa1', name: 'Hexavalent 1 (DTaP-IPV-Hib-HepB)', age: { days: 42 }, label: '6 weeks' },
  { id: 'pcv1', name: 'Pneumococcal (PCV) 1', age: { days: 42 }, label: '6 weeks' },
  { id: 'hexa2', name: 'Hexavalent 2', age: { days: 70 }, label: '10 weeks' },
  { id: 'rv2', name: 'Rotavirus 2', age: { days: 98 }, label: '14 weeks' },
  { id: 'hexa3', name: 'Hexavalent 3', age: { days: 98 }, label: '14 weeks' },
  { id: 'pcv2', name: 'Pneumococcal (PCV) 2', age: { days: 98 }, label: '14 weeks' },
  { id: 'mr1', name: 'Measles (measles-rubella) 1', age: { months: 6 }, label: '6 months' },
  { id: 'pcv3', name: 'Pneumococcal (PCV) 3', age: { months: 9 }, label: '9 months' },
  { id: 'mr2', name: 'Measles (measles-rubella) 2', age: { months: 12 }, label: '12 months' },
  { id: 'hexa4', name: 'Hexavalent 4', age: { months: 18 }, label: '18 months' },
  { id: 'td6', name: 'Td (tetanus, diphtheria)', age: { years: 6 }, label: '6 years' },
  { id: 'hpv', name: 'HPV (Grade 5, at school; girls)', age: { years: 9 }, label: 'About 9 years' },
  { id: 'td12', name: 'Td (tetanus, diphtheria)', age: { years: 12 }, label: '12 years' },
]

const pad = (n: number) => String(n).padStart(2, '0')

/** The date a dose is due for a child born on `birth` (YYYY-MM-DD). */
export function dueDate(birth: string, age: ScheduledDose['age']): string {
  const d = new Date(Number(birth.slice(0, 4)), Number(birth.slice(5, 7)) - 1, Number(birth.slice(8, 10)))
  if (age.days) d.setDate(d.getDate() + age.days)
  if (age.months) d.setMonth(d.getMonth() + age.months)
  if (age.years) d.setFullYear(d.getFullYear() + age.years)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Whether the schedule applies: children up to 13. */
export const scheduleApplies = (birth: string | undefined, today: string) => !!birth && dueDate(birth, { years: 13 }) >= today
