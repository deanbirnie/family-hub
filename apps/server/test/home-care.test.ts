import { afterEach, describe, expect, it } from 'vitest'
import { cleanCare, kmPerDay, taskStatus, vehicleStatus, type Job, type Task, type Vehicle } from '../src/home-care.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

const vehicle = (over: Record<string, unknown> = {}) => cleanCare('vehicle', { label: 'The Polo', serviceMonths: 12, serviceKm: 15000, ...over }) as Vehicle
const job = (over: Record<string, unknown>) => cleanCare('job', { date: '2026-01-10', what: 'Service', ...over }) as Job

describe('vehicles', () => {
  it('estimate kilometres a day from readings at least two weeks apart', () => {
    expect(kmPerDay([])).toBeNull()
    expect(kmPerDay([{ date: '2026-01-01', km: 50000 }, { date: '2026-01-05', km: 50400 }])).toBeNull()
    expect(kmPerDay([{ date: '2026-01-01', km: 50000 }, { date: '2026-03-02', km: 53000 }])).toBe(50)
  })

  it('find the next service by date or by distance, whichever comes first', () => {
    const jobs = [job({ service: true, km: 50000, date: '2026-01-01' })]
    // 50 km a day: 15 000 km takes 300 days, sooner than 12 months.
    const fast = vehicleStatus(vehicle({ readings: [{ date: '2026-03-02', km: 53000 }] }), jobs, '2026-06-01')
    expect(fast).toMatchObject({ lastService: { date: '2026-01-01', km: 50000 }, nextByDate: '2027-01-01', nextKm: 65000, nextByKm: '2026-10-28', nextService: '2026-10-28' })
    expect(fast.kmNow).toBe(53000 + 50 * 91)
    // No readings: by date only.
    expect(vehicleStatus(vehicle(), jobs, '2026-06-01').nextService).toBe('2027-01-01')
    // No service logged yet: nothing to go on.
    expect(vehicleStatus(vehicle(), [], '2026-06-01').nextService).toBeNull()
  })

  it('keep maintenance on schedule from the last job', () => {
    const task = cleanCare('task', { name: 'Geyser service', everyMonths: 24, lastDone: '2024-03-01' }) as Task
    expect(taskStatus(task, [])).toEqual({ lastDone: '2024-03-01', nextDue: '2026-03-01' })
    expect(taskStatus(task, [job({ date: '2026-02-15', what: 'Geyser serviced' })])).toEqual({ lastDone: '2026-02-15', nextDue: '2028-02-15' })
  })

  it('refuse what does not make sense', () => {
    expect(() => vehicle({ label: '' })).toThrow()
    expect(() => vehicle({ serviceKm: 10 })).toThrow()
    expect(() => cleanCare('task', { name: 'x', everyMonths: 0 })).toThrow()
    expect(() => job({ again: 'maybe' })).toThrow()
    expect(() => job({ cost: 1.5 })).toThrow()
  })
})

describe('the Home & car API', () => {
  it('keeps it sealed, for parents only, and reminds with generic text', async () => {
    server = await startServer() // 2026-11-20
    const { client } = await setUpAdmin(server)
    const invite = await client.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)

    const car = await client.post<{ item: { id: string } }>('/api/home-care/vehicles', { item: { label: 'The Polo', serviceMonths: 12, roadworthyDue: '2026-12-10' } })
    await client.post('/api/home-care/jobs', { item: { date: '2025-11-25', what: 'Major service', service: true, forId: car.body.item.id, who: 'Corner Garage', cost: 450000, km: 80000, again: 'yes' } })
    const task = await client.post<{ item: { id: string } }>('/api/home-care/tasks', { item: { name: 'Clean the gutters', everyMonths: 12, lastDone: '2025-11-01' } })
    await client.post('/api/home-care/items', { item: { name: 'Fridge', make: 'Defy', warrantyEnd: '2026-12-15' } })

    const raw = JSON.stringify(server.services.db.prepare('SELECT * FROM home_care').all())
    for (const w of ['Polo', 'Garage', 'gutters', 'Defy']) expect(raw).not.toContain(w)

    const state = await client.get<{ vehicles: { status: { nextService: string } }[]; tasks: { status: { nextDue: string } }[] }>('/api/home-care')
    expect(state.body.vehicles[0]!.status.nextService).toBe('2026-11-25')
    expect(state.body.tasks[0]!.status.nextDue).toBe('2026-11-01')

    const up = await client.get<{ items: { title: string; category: string; daysLeft: number }[] }>('/api/reminders/upcoming')
    expect(up.body.items.map((i) => [i.title, i.daysLeft])).toEqual([
      ['Clean the gutters', -19],
      ['The Polo: service due', 5],
      ['The Polo: roadworthy', 20],
      ['Fridge: warranty ends', 25],
    ])
    const parent = (await client.get<{ user: { id: string } }>('/api/auth/session')).body.user.id
    const { dueMessagesFor } = await import('../src/notifications.ts')
    const bodies = dueMessagesFor(server.services, parent, '2026-11-20').map((m) => m.body)
    expect(bodies).toEqual(expect.arrayContaining(['A vehicle service is due soon. Tap to see.', 'Home maintenance is due. Tap to see.', 'A roadworthy is due soon. Tap to see.', 'A warranty ends soon. Tap to see.']))

    // Logging the gutters moves the task on; deleting the car keeps its job, unlinked.
    await client.post('/api/home-care/jobs', { item: { date: '2026-11-20', what: 'Gutters cleaned', forId: task.body.item.id } })
    expect((await client.get<{ tasks: { status: { nextDue: string } }[] }>('/api/home-care')).body.tasks[0]!.status.nextDue).toBe('2027-11-20')
    expect((await client.del(`/api/home-care/vehicles/${car.body.item.id}`)).status).toBe(204)
    const jobs = (await client.get<{ jobs: { what: string; forId: string | null }[] }>('/api/home-care')).body.jobs
    expect(jobs.find((j) => j.what === 'Major service')!.forId).toBeNull()

    for (const r of [kid.get('/api/home-care'), kid.post('/api/home-care/jobs', { item: {} })]) expect((await r).status).toBe(403)
    expect((await client.post('/api/home-care/boats', { item: {} })).status).toBe(404)
  })
})
