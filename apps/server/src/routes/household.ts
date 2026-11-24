/**
 * Money (phase 6a), for parents only: accounts (a bank and a nickname),
 * bills and subscriptions, and invoices. Each item is sealed with the server
 * key and bound to its ID; the server opens them to work out due dates,
 * totals and reminders (household.ts). Documents go in a parents-only
 * Household folder in Files.
 */
import type { Api, Services } from '../app.ts'
import { HttpError, readJson } from '../http.ts'
import {
  addDays,
  cleanAccount,
  dueDates,
  cleanBill,
  cleanInvoice,
  monthlyCents,
  nextDue,
  noticeDeadline,
  openItem,
  overdue,
  readAll,
  reviewDue,
  sealItem,
  type Bill,
  type Item,
  type Kind,
} from '../household.ts'
import { localNow } from '../schedule.ts'
import { newId } from '../secrets.ts'
import { householdFolder } from './files.ts'

const KINDS: Record<string, Kind> = { accounts: 'account', bills: 'bill', invoices: 'invoice' }
const MAX_ITEMS = 20_000

export function householdRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const
  const today = () => localNow(s.now(), s.config.timeZone).date

  const kindOf = (plural: string | undefined): Kind => {
    const k = KINDS[plural ?? '']
    if (!k) throw new HttpError(404, 'Not found.', 'not_found')
    return k
  }
  const clean = (kind: Kind, raw: unknown, addedOn: string): Item => (kind === 'account' ? cleanAccount(raw) : kind === 'bill' ? cleanBill(raw, addedOn) : cleanInvoice(raw))
  const find = (kind: Kind, id: string) => {
    const r = db.prepare('SELECT id, kind, sealed, version FROM household WHERE id = ? AND kind = ?').get(id, kind) as { id: string; kind: Kind; sealed: string; version: number } | undefined
    if (!r) throw new HttpError(404, 'That has been deleted.', 'not_found')
    return r
  }

  /** Everything, with what the server works out for each bill. */
  api.authed('GET', '/api/money', parents, () => {
    const day = today()
    return {
      today: day,
      accounts: readAll(s, 'account').map((r) => ({ id: r.id, version: r.version, ...r.item })),
      bills: readAll<Bill>(s, 'bill').map((r) => ({
        id: r.id,
        version: r.version,
        ...r.item,
        nextDue: nextDue(r.item, day),
        lastDue: dueDates(r.item, addDays(day, -400), addDays(day, -1)).pop() ?? null,
        overdue: overdue(r.item, day),
        monthly: monthlyCents(r.item),
        noticeDeadline: noticeDeadline(r.item),
        reviewDue: r.item.status === 'active' ? reviewDue(r.item) : null,
      })),
      invoices: readAll(s, 'invoice').map((r) => ({ id: r.id, version: r.version, createdAt: r.createdAt, ...r.item })),
    }
  })

  api.authed('POST', '/api/money/:kind', parents, async (ctx) => {
    const kind = kindOf(ctx.params.kind)
    const count = (db.prepare('SELECT COUNT(*) AS n FROM household').get() as { n: number }).n
    if (count >= MAX_ITEMS) throw new HttpError(400, 'That is more than the hub keeps.', 'invalid')
    const item = clean(kind, (await readJson(ctx.req)).item, today())
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO household (id, kind, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, 1, ?, ?, ?)').run(id, kind, sealItem(s, kind, id, item), now, now, ctx.user.id)
    s.audit('money.added', ctx, ctx.user.id, kind)
    return { item: { id, version: 1, ...item } }
  })

  api.authed('PUT', '/api/money/:kind/:id', parents, async (ctx) => {
    const kind = kindOf(ctx.params.kind)
    const row = find(kind, ctx.params.id!)
    const body = await readJson(ctx.req)
    if (body.baseVersion !== row.version) throw new HttpError(409, 'The other parent changed this a moment ago. Open it again to see their change.', 'edit_conflict')
    // The day a bill was added never changes.
    const before = openItem<Item>(s, row)
    const added = kind === 'bill' ? (before as Bill).addedOn : today()
    const raw = kind === 'bill' ? { ...(body.item as object), addedOn: added } : body.item
    const item = clean(kind, raw, added)
    db.prepare('UPDATE household SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(sealItem(s, kind, row.id, item), s.now(), ctx.user.id, row.id)
    s.audit('money.changed', ctx, ctx.user.id, kind)
    return { item: { id: row.id, version: row.version + 1, ...item } }
  })

  api.authed('DELETE', '/api/money/:kind/:id', parents, (ctx) => {
    const kind = kindOf(ctx.params.kind)
    const row = find(kind, ctx.params.id!)
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('DELETE FROM household WHERE id = ?').run(row.id)
      // Bills paid from a removed account, and invoices of a removed bill, lose the link.
      if (kind === 'account' || kind === 'bill') {
        const linked = kind === 'account' ? 'bill' : 'invoice'
        const field = kind === 'account' ? 'accountId' : 'billId'
        for (const r of readAll<Item>(s, linked)) {
          const item = r.item as unknown as Record<string, unknown>
          if (item[field] !== row.id) continue
          item[field] = null
          db.prepare('UPDATE household SET sealed = ?, version = version + 1 WHERE id = ?').run(sealItem(s, linked, r.id, item as unknown as Item), r.id)
        }
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    s.audit('money.removed', ctx, ctx.user.id, kind)
    return undefined
  })

  /** The parents-only folder for invoices, receipts, warranties and manuals. */
  api.authed('GET', '/api/money/folder', parents, (ctx) => ({ folderId: householdFolder(s, ctx.user.id) }))
}
