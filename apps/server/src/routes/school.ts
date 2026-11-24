/**
 * School (phase 7a), for parents only to start: each child's school years,
 * contacts, extra-murals and reminders (school.ts), and the child's folder
 * in the School folder.
 */
import type { Api, Services } from '../app.ts'
import { HttpError, readJson } from '../http.ts'
import { cleanSchool, readSchool, sealSchool, type SchoolKind } from '../school.ts'
import { newId } from '../secrets.ts'
import { childSchoolFolder } from './files.ts'

const KINDS: Record<string, SchoolKind> = { years: 'year', contacts: 'contact', activities: 'activity', reminders: 'reminder', forms: 'form', lists: 'list', timetables: 'timetable', homework: 'homework' }
const MAX_ITEMS = 20_000

export function schoolRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const
  const kindOf = (plural: string | undefined): SchoolKind => {
    const k = KINDS[plural ?? '']
    if (!k) throw new HttpError(404, 'Not found.', 'not_found')
    return k
  }
  const person = (id: unknown) => {
    if (typeof id !== 'string' || !db.prepare('SELECT 1 FROM family_profiles WHERE id = ?').get(id)) throw new HttpError(400, 'Choose one of the family.', 'invalid')
    return id
  }

  api.authed('GET', '/api/school', parents, () => ({
    profiles: (db.prepare('SELECT id, display_name, user_id FROM family_profiles ORDER BY display_name COLLATE NOCASE, id').all() as { id: string; display_name: string; user_id: string | null }[]).map((p) => ({
      id: p.id,
      displayName: p.display_name,
      userId: p.user_id,
    })),
    items: readSchool(s).map((r) => ({ id: r.id, kind: r.kind, profileId: r.profileId, version: r.version, ...r.item })),
  }))

  api.authed('POST', '/api/school/:kind', parents, async (ctx) => {
    const kind = kindOf(ctx.params.kind)
    if ((db.prepare('SELECT COUNT(*) AS n FROM school').get() as { n: number }).n >= MAX_ITEMS) throw new HttpError(400, 'That is more than the hub keeps.', 'invalid')
    const body = await readJson(ctx.req)
    // School contacts and reminders can be for every child (no profile).
    const profileId = body.profileId === null && (kind === 'contact' || kind === 'reminder') ? null : person(body.profileId)
    const item = cleanSchool(kind, body.item)
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO school (id, kind, profile_id, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(id, kind, profileId, sealSchool(s, kind, id, item), now, now, ctx.user.id)
    s.audit('school.added', ctx, ctx.user.id, kind)
    return { item: { id, kind, profileId, version: 1, ...item } }
  })

  api.authed('PUT', '/api/school/:kind/:id', parents, async (ctx) => {
    const kind = kindOf(ctx.params.kind)
    const row = db.prepare('SELECT id, profile_id, version FROM school WHERE id = ? AND kind = ?').get(ctx.params.id!, kind) as { id: string; profile_id: string | null; version: number } | undefined
    if (!row) throw new HttpError(404, 'That has been deleted.', 'not_found')
    const body = await readJson(ctx.req)
    if (body.baseVersion !== row.version) throw new HttpError(409, 'The other parent changed this a moment ago. Open it again to see their change.', 'edit_conflict')
    const item = cleanSchool(kind, body.item)
    db.prepare('UPDATE school SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(sealSchool(s, kind, row.id, item), s.now(), ctx.user.id, row.id)
    s.audit('school.changed', ctx, ctx.user.id, kind)
    return { item: { id: row.id, kind, profileId: row.profile_id, version: row.version + 1, ...item } }
  })

  api.authed('DELETE', '/api/school/:kind/:id', parents, (ctx) => {
    const kind = kindOf(ctx.params.kind)
    if (Number(db.prepare('DELETE FROM school WHERE id = ? AND kind = ?').run(ctx.params.id!, kind).changes) === 0) throw new HttpError(404, 'That has been deleted.', 'not_found')
    s.audit('school.removed', ctx, ctx.user.id, kind)
    return undefined
  })

  /** The child's folder for reports, letters and forms (made on first use). */
  api.authed('GET', '/api/school/folder/:profileId', parents, (ctx) => {
    const p = db.prepare('SELECT display_name FROM family_profiles WHERE id = ?').get(ctx.params.profileId!) as { display_name: string } | undefined
    if (!p) throw new HttpError(404, 'That person is no longer in the family.', 'not_found')
    return { folderId: childSchoolFolder(s, ctx.user.id, ctx.params.profileId!, p.display_name) }
  })
}
