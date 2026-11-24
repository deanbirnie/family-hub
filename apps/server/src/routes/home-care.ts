/**
 * Home and car (phase 6b), for parents only: vehicles, things with
 * warranties, recurring maintenance and jobs (home-care.ts). Sealed with the
 * server key; documents go in the parents-only Household folder.
 */
import type { Api, Services } from '../app.ts'
import { careState, cleanCare, sealCare, type Care, type CareKind } from '../home-care.ts'
import { HttpError, readJson } from '../http.ts'
import { localNow } from '../schedule.ts'
import { newId } from '../secrets.ts'

const KINDS: Record<string, CareKind> = { vehicles: 'vehicle', items: 'item', tasks: 'task', jobs: 'job' }
const MAX_ITEMS = 20_000

export function homeCareRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const
  const kindOf = (plural: string | undefined): CareKind => {
    const k = KINDS[plural ?? '']
    if (!k) throw new HttpError(404, 'Not found.', 'not_found')
    return k
  }
  const find = (kind: CareKind, id: string) => {
    const r = db.prepare('SELECT id, version FROM home_care WHERE id = ? AND kind = ?').get(id, kind) as { id: string; version: number } | undefined
    if (!r) throw new HttpError(404, 'That has been deleted.', 'not_found')
    return r
  }
  const flat = <T extends Care>(r: { id: string; version: number; item: T }) => ({ id: r.id, version: r.version, ...r.item })

  api.authed('GET', '/api/home-care', parents, () => {
    const today = localNow(s.now(), s.config.timeZone).date
    const st = careState(s, today)
    return {
      today,
      vehicles: st.vehicles.map((v) => ({ ...flat(v), status: v.status })),
      items: st.items.map(flat),
      tasks: st.tasks.map((t) => ({ ...flat(t), status: t.status })),
      jobs: st.jobs.map(flat),
    }
  })

  api.authed('POST', '/api/home-care/:kind', parents, async (ctx) => {
    const kind = kindOf(ctx.params.kind)
    if ((db.prepare('SELECT COUNT(*) AS n FROM home_care').get() as { n: number }).n >= MAX_ITEMS) throw new HttpError(400, 'That is more than the hub keeps.', 'invalid')
    const item = cleanCare(kind, (await readJson(ctx.req)).item)
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO home_care (id, kind, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?)').run(id, kind, sealCare(s, kind, id, item), now, now, ctx.user.id)
    s.audit('home.added', ctx, ctx.user.id, kind)
    return { item: { id, version: 1, ...item } }
  })

  api.authed('PUT', '/api/home-care/:kind/:id', parents, async (ctx) => {
    const kind = kindOf(ctx.params.kind)
    const row = find(kind, ctx.params.id!)
    const body = await readJson(ctx.req)
    if (body.baseVersion !== row.version) throw new HttpError(409, 'The other parent changed this a moment ago. Open it again to see their change.', 'edit_conflict')
    const item = cleanCare(kind, body.item)
    db.prepare('UPDATE home_care SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(sealCare(s, kind, row.id, item), s.now(), ctx.user.id, row.id)
    s.audit('home.changed', ctx, ctx.user.id, kind)
    return { item: { id: row.id, version: row.version + 1, ...item } }
  })

  /** Deleting a vehicle, thing or task keeps its jobs (the history), unlinked. */
  api.authed('DELETE', '/api/home-care/:kind/:id', parents, (ctx) => {
    const kind = kindOf(ctx.params.kind)
    const row = find(kind, ctx.params.id!)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM home_care WHERE id = ?').run(row.id)
      if (kind !== 'job') {
        for (const j of careState(s, localNow(s.now(), s.config.timeZone).date).jobs) {
          if (j.item.forId !== row.id) continue
          db.prepare('UPDATE home_care SET sealed = ?, version = version + 1 WHERE id = ?').run(sealCare(s, 'job', j.id, { ...j.item, forId: null }), j.id)
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    s.audit('home.removed', ctx, ctx.user.id, kind)
    return undefined
  })
}
