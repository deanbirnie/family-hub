/**
 * Health (docs/ROADMAP.md, phase 5), for parents only.
 *
 * Every health record (an allergy, a medicine, a history entry, ...) is
 * encrypted on a parent's device with the family key (packages/ui/src/vault/),
 * which the server never has. The server stores ciphertext and knows only
 * which person a record is for and when, and by whom, it changed: not even
 * what kind of record it is (docs/DATA-PROTECTION.md, "Health").
 *
 * Documents go in Files, in a Health folder only parents can open.
 */
import type { Api, Services } from '../app.ts'
import { HttpError, readJson, str } from '../http.ts'
import { newId } from '../secrets.ts'
import { healthFolder } from './files.ts'

const MAX_CIPHERTEXT = 64 * 1024
const MAX_RECORDS = 50_000

interface RecordRow {
  id: string
  profile_id: string
  ciphertext: string
  version: number
  created_at: number
  updated_at: number
  updated_by: string | null
}

const recordInfo = (r: RecordRow) => ({ id: r.id, profileId: r.profile_id, ciphertext: r.ciphertext, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at, updatedBy: r.updated_by })

export function healthRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const

  const ciphertext = (body: Record<string, unknown>) => {
    const value = str(body, 'ciphertext', { max: MAX_CIPHERTEXT })
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, 'Health records must be sent encrypted.', 'invalid')
    return value
  }
  const find = (id: string) => {
    const r = db.prepare('SELECT * FROM health_records WHERE id = ?').get(id) as unknown as RecordRow | undefined
    if (!r) throw new HttpError(404, 'That has been deleted.', 'not_found')
    return r
  }

  // (/api/health itself is the server's status check.)
  api.authed('GET', '/api/health/records', parents, () => ({
    profiles: (db.prepare('SELECT id, display_name, user_id FROM family_profiles ORDER BY display_name COLLATE NOCASE, id').all() as { id: string; display_name: string; user_id: string | null }[]).map((p) => ({
      id: p.id,
      displayName: p.display_name,
      userId: p.user_id,
    })),
    records: (db.prepare('SELECT * FROM health_records ORDER BY created_at, id').all() as unknown as RecordRow[]).map(recordInfo),
  }))

  api.authed('POST', '/api/health/records', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const profileId = str(body, 'profileId', { max: 40 })
    if (!db.prepare('SELECT 1 FROM family_profiles WHERE id = ?').get(profileId)) throw new HttpError(404, 'That person is no longer in the family.', 'not_found')
    if ((db.prepare('SELECT COUNT(*) AS n FROM health_records').get() as { n: number }).n >= MAX_RECORDS) throw new HttpError(409, 'Health is full.', 'too_many')
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO health_records (id, profile_id, ciphertext, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?)').run(id, profileId, ciphertext(body), now, now, ctx.user.id)
    s.audit('health.added', ctx, ctx.user.id)
    return { record: recordInfo(find(id)) }
  })

  /** Replaces a record, only if nobody changed it since `baseVersion`. */
  api.authed('PUT', '/api/health/records/:id', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const r = find(ctx.params.id!)
    const base = body.baseVersion
    if (typeof base !== 'number' || !Number.isInteger(base)) throw new HttpError(400, '"baseVersion" is required.', 'invalid')
    const changed = db
      .prepare('UPDATE health_records SET ciphertext = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?')
      .run(ciphertext(body), s.now(), ctx.user.id, r.id, base)
    if (Number(changed.changes) !== 1) throw new HttpError(409, 'The other parent changed this while you were editing. Reload to see their changes.', 'edit_conflict')
    s.audit('health.changed', ctx, ctx.user.id)
    return { record: recordInfo(find(r.id)) }
  })

  api.authed('DELETE', '/api/health/records/:id', parents, (ctx) => {
    const r = find(ctx.params.id!)
    db.prepare('DELETE FROM health_records WHERE id = ?').run(r.id)
    s.audit('health.removed', ctx, ctx.user.id)
    return undefined
  })

  /** The parents-only Health folder in Files (made on first use). */
  api.authed('GET', '/api/health/folder', parents, (ctx) => ({ folderId: healthFolder(s, ctx.user.id) }))
}
