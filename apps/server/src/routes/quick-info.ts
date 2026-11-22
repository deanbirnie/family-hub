/**
 * Quick Info: the family's reference card (ID numbers, medical aid, passport,
 * vehicles, policies, household address), for parents only.
 *
 * Every record's contents are encrypted on a parent's device with the family
 * key (packages/ui/src/vault/), which the server never has. The server stores
 * and returns the ciphertext as is, and knows only which person a record is
 * for, what kind it is, and when and by whom it last changed
 * (docs/DATA-PROTECTION.md, "Quick Info").
 *
 * Each record carries a version: an update names the version it was based
 * on, so two parents editing the same record at once cannot silently
 * overwrite each other.
 */
import type { Api, Services } from '../app.ts'
import { HttpError, readJson, str } from '../http.ts'
import { newId } from '../secrets.ts'
import { openEmergency } from './contacts.ts'

export const RECORD_KINDS = ['personal', 'medical', 'passport', 'vehicle', 'policy', 'household'] as const
type Kind = (typeof RECORD_KINDS)[number]
/** Kinds that exist once per person (or once for the household). */
const SINGLE: Kind[] = ['personal', 'medical', 'passport', 'household']
const MAX_CIPHERTEXT = 64 * 1024
const MAX_PROFILES = 50
const MAX_RECORDS = 500

interface ProfileRow {
  id: string
  display_name: string
  user_id: string | null
  created_at: number
  /** Emergency contacts, sealed with the server key (routes/contacts.ts). */
  emergency: string | null
}

interface RecordRow {
  id: string
  profile_id: string | null
  kind: Kind
  ciphertext: string
  version: number
  created_at: number
  updated_at: number
  updated_by: string | null
}

const profileInfo = (p: ProfileRow) => ({ id: p.id, displayName: p.display_name, userId: p.user_id, createdAt: p.created_at })
const recordInfo = (r: RecordRow) => ({
  id: r.id,
  profileId: r.profile_id,
  kind: r.kind,
  ciphertext: r.ciphertext,
  version: r.version,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
})

export function quickInfoRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const

  const ciphertext = (body: Record<string, unknown>) => {
    const value = str(body, 'ciphertext', { max: MAX_CIPHERTEXT })
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(400, 'The record must be sent encrypted.', 'invalid')
    return value
  }
  const findProfile = (id: string) => {
    const p = db.prepare('SELECT * FROM family_profiles WHERE id = ?').get(id) as unknown as ProfileRow | undefined
    if (!p) throw new HttpError(404, 'That person is no longer in Quick Info.', 'not_found')
    return p
  }
  const findRecord = (id: string) => {
    const r = db.prepare('SELECT * FROM quick_info WHERE id = ?').get(id) as unknown as RecordRow | undefined
    if (!r) throw new HttpError(404, 'That record has been deleted.', 'not_found')
    return r
  }
  const linkedUser = (body: Record<string, unknown>): string | null => {
    if (body.userId === undefined || body.userId === null || body.userId === '') return null
    const id = str(body, 'userId', { max: 40 })
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw new HttpError(400, 'No such family member.', 'invalid')
    const taken = db.prepare('SELECT 1 FROM family_profiles WHERE user_id = ?').get(id)
    if (taken) throw new HttpError(409, 'That family member already has a Quick Info profile.', 'profile_exists')
    return id
  }

  api.authed('GET', '/api/quick-info', parents, () => ({
    profiles: (db.prepare('SELECT * FROM family_profiles ORDER BY created_at, id').all() as unknown as ProfileRow[]).map((p) => ({
      ...profileInfo(p),
      emergency: openEmergency(s, p.id, p.emergency),
    })),
    records: (db.prepare('SELECT * FROM quick_info ORDER BY created_at, id').all() as unknown as RecordRow[]).map(recordInfo),
  }))

  // ---- people ------------------------------------------------------------------------

  api.authed('POST', '/api/quick-info/profiles', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const displayName = str(body, 'displayName', { max: 60 })
    const userId = linkedUser(body)
    const count = (db.prepare('SELECT COUNT(*) AS n FROM family_profiles').get() as { n: number }).n
    if (count >= MAX_PROFILES) throw new HttpError(409, 'Quick Info has as many people as it can hold.', 'too_many')
    const id = newId()
    db.prepare('INSERT INTO family_profiles (id, display_name, user_id, created_at) VALUES (?, ?, ?, ?)').run(id, displayName, userId, s.now())
    s.audit('quick_info.person_added', ctx, ctx.user.id, displayName)
    return { profile: profileInfo(findProfile(id)) }
  })

  api.authed('PATCH', '/api/quick-info/profiles/:id', parents, async (ctx) => {
    const p = findProfile(ctx.params.id!)
    const body = await readJson(ctx.req)
    db.prepare('UPDATE family_profiles SET display_name = ? WHERE id = ?').run(str(body, 'displayName', { max: 60 }), p.id)
    return { profile: profileInfo(findProfile(p.id)) }
  })

  /** Removes the person and every record about them. */
  api.authed('DELETE', '/api/quick-info/profiles/:id', parents, (ctx) => {
    const p = findProfile(ctx.params.id!)
    db.prepare('DELETE FROM family_profiles WHERE id = ?').run(p.id)
    s.audit('quick_info.person_removed', ctx, ctx.user.id, p.display_name)
    return undefined
  })

  // ---- records -------------------------------------------------------------------------

  api.authed('POST', '/api/quick-info/records', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const kind = body.kind as Kind
    if (!RECORD_KINDS.includes(kind)) throw new HttpError(400, 'Unknown kind of record.', 'invalid')
    const profileId = kind === 'household' ? null : findProfile(str(body, 'profileId', { max: 40 })).id
    const count = (db.prepare('SELECT COUNT(*) AS n FROM quick_info').get() as { n: number }).n
    if (count >= MAX_RECORDS) throw new HttpError(409, 'Quick Info has as many records as it can hold.', 'too_many')
    if (SINGLE.includes(kind) && db.prepare('SELECT 1 FROM quick_info WHERE profile_id IS ? AND kind = ?').get(profileId, kind)) {
      throw new HttpError(409, 'That record already exists. Reload to see it.', 'record_exists')
    }
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO quick_info (id, profile_id, kind, ciphertext, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(
      id,
      profileId,
      kind,
      ciphertext(body),
      now,
      now,
      ctx.user.id,
    )
    s.audit('quick_info.record_added', ctx, ctx.user.id, kind)
    return { record: recordInfo(findRecord(id)) }
  })

  /** Replaces a record's contents, only if nobody changed it since `baseVersion`. */
  api.authed('PUT', '/api/quick-info/records/:id', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const r = findRecord(ctx.params.id!)
    const base = body.baseVersion
    if (typeof base !== 'number' || !Number.isInteger(base)) throw new HttpError(400, '"baseVersion" is required.', 'invalid')
    const changed = db
      .prepare('UPDATE quick_info SET ciphertext = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ? AND version = ?')
      .run(ciphertext(body), s.now(), ctx.user.id, r.id, base)
    if (Number(changed.changes) !== 1) {
      throw new HttpError(409, 'Someone else changed this record while you were editing. Reload to see their changes.', 'edit_conflict')
    }
    s.audit('quick_info.record_updated', ctx, ctx.user.id, r.kind)
    return { record: recordInfo(findRecord(r.id)) }
  })

  api.authed('DELETE', '/api/quick-info/records/:id', parents, (ctx) => {
    const r = findRecord(ctx.params.id!)
    db.prepare('DELETE FROM quick_info WHERE id = ?').run(r.id)
    db.prepare("DELETE FROM reminders WHERE source = 'quick-info' AND source_id = ?").run(r.id)
    s.audit('quick_info.record_deleted', ctx, ctx.user.id, r.kind)
    return undefined
  })
}
