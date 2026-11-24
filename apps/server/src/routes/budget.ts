/**
 * The budget (phase 6c, part 1), for parents only: categories, month plans,
 * planned expenses, debts, milestones and transactions typed in by hand.
 * Sealed with the server key (budget.ts).
 */
import type { Api, Services } from '../app.ts'
import {
  addMonthsTo,
  categories,
  cleanCategories,
  cleanDebt,
  cleanMilestones,
  cleanPlan,
  cleanPlanned,
  cleanTxn,
  generatedLines,
  milestones,
  month,
  monthOf,
  plannedFor,
  readBudget,
  readOne,
  readTxns,
  sealBudget,
  sealTxn,
  sinkingBalances,
  snowball,
  spending,
  startMonth,
  type Category,
  type Debt,
  type MonthPlan,
  type Planned,
} from '../budget.ts'
import { HttpError, readJson } from '../http.ts'
import { readAll, type Account } from '../household.ts'
import { localNow } from '../schedule.ts'
import { newId } from '../secrets.ts'

const MAX_TXNS = 200_000

export function budgetRoutes(api: Api, s: Services): void {
  const { db } = s
  const parents = { admin: true } as const
  const today = () => localNow(s.now(), s.config.timeZone).date
  const conflict = () => new HttpError(409, 'The other parent changed this a moment ago. Open it again to see their change.', 'edit_conflict')

  /** Saves a single record (categories, a month, milestones) by kind and key, checking the version. */
  const putOne = (kind: string, key: string | null, item: unknown, baseVersion: unknown, userId: string) => {
    const existing = readOne<unknown>(s, kind, key)
    const now = s.now()
    if (!existing) {
      if (baseVersion !== 0) throw conflict()
      const id = newId()
      db.prepare('INSERT INTO budget (id, kind, key, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(id, kind, key, sealBudget(s, kind, id, item), now, now, userId)
      return 1
    }
    if (baseVersion !== existing.version) throw conflict()
    db.prepare('UPDATE budget SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(sealBudget(s, kind, existing.id, item), now, userId, existing.id)
    return existing.version + 1
  }

  /** One month: the plan, its transactions, what was spent, sinking funds, and everything that feeds the plan. */
  api.authed('GET', '/api/budget', parents, (ctx) => {
    const day = today()
    const m = ctx.url.searchParams.get('month') ? month(ctx.url.searchParams.get('month'), 'The month') : monthOf(day)
    const cats = categories(s)
    const plans = readBudget<MonthPlan>(s, 'month')
    const plan = plans.find((p) => p.key === m)
    const all = readTxns(s)
    const spent = spending(all)
    const debts = readBudget<Debt>(s, 'debt')
    const ms = milestones(s)
    const active = debts.filter((d) => !d.item.paidOff && d.item.balance > 0)
    const balances = sinkingBalances(
      cats.list,
      plans.map((p) => p.item),
      spent,
      m,
    )
    // Milestones: the emergency fund now, and three months of essentials from the latest plans.
    const nowBalances = sinkingBalances(
      cats.list,
      plans.map((p) => p.item),
      spent,
      monthOf(day),
    )
    const emergency = cats.list.find((c) => c.role === 'emergency')
    const essentials = cats.list.filter((c) => c.group === 'essentials').map((c) => c.id)
    const recent = plans
      .filter((p) => p.key! <= monthOf(day))
      .slice(-3)
      .map((p) => essentials.reduce((n, id) => n + plannedFor(p.item, id), 0))
    const essentialMonth = recent.length ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length) : 0
    const retirement = cats.list.find((c) => c.role === 'retirement')
    const current = plans.find((p) => p.key === monthOf(day))?.item
    const income = current ? current.income.reduce((n, i) => n + i.amount, 0) : 0
    return {
      today: day,
      month: m,
      categories: cats.list,
      categoriesVersion: cats.version,
      plan: plan ? plan.item : null,
      planVersion: plan?.version ?? 0,
      months: plans.map((p) => p.key),
      transactions: all.filter((t) => t.month === m).map((t) => ({ id: t.id, version: t.version, ...t.item })),
      spent: Object.fromEntries(spent.get(m) ?? []),
      incomeActual: all.filter((t) => t.month === m && t.item.categoryId === 'income').reduce((n, t) => n + t.item.amount, 0),
      uncategorised: all.filter((t) => t.month === m && !t.item.categoryId).length,
      sinking: balances,
      // Lines the plan would get from bills, planned expenses and debts, to add any that are missing.
      suggested: generatedLines(s, cats.list, m, day).filter((l) => !plan?.item.lines.some((x) => x.source === l.source)),
      planned: readBudget<Planned>(s, 'planned').map((p) => ({ id: p.id, version: p.version, ...p.item })),
      debts: debts.map((d) => ({ id: d.id, version: d.version, ...d.item })),
      snowball: snowball(
        active.map((d) => ({ id: d.id, balance: d.item.balance, rate: d.item.rate, minimum: d.item.minimum })),
        ms.item.extraDebt,
        monthOf(day),
      ),
      milestones: ms.item,
      milestonesVersion: ms.version,
      progress: {
        emergency: emergency ? (nowBalances[emergency.id] ?? 0) : null,
        essentialMonth,
        debtLeft: active.reduce((n, d) => n + d.item.balance, 0),
        retirementPlanned: retirement && current ? plannedFor(current, retirement.id) : null,
        income,
      },
      accounts: readAll<Account>(s, 'account').map((a) => ({ id: a.id, bank: a.item.bank, nickname: a.item.nickname })),
    }
  })

  /** Twelve months up to `month`: income and spending, planned against actual, per category. */
  api.authed('GET', '/api/budget/summary', parents, (ctx) => {
    const end = ctx.url.searchParams.get('month') ? month(ctx.url.searchParams.get('month'), 'The month') : monthOf(today())
    const plans = readBudget<MonthPlan>(s, 'month')
    const all = readTxns(s)
    const spent = spending(all)
    const cats = categories(s).list
    return {
      categories: cats,
      months: Array.from({ length: 12 }, (_, i) => addMonthsTo(end, i - 11)).map((m) => {
        const plan = plans.find((p) => p.key === m)?.item
        return {
          month: m,
          incomePlanned: plan ? plan.income.reduce((n, i) => n + i.amount, 0) : 0,
          incomeActual: all.filter((t) => t.month === m && t.item.categoryId === 'income').reduce((n, t) => n + t.item.amount, 0),
          byCategory: Object.fromEntries(cats.map((c) => [c.id, { planned: plannedFor(plan, c.id), spent: spent.get(m)?.get(c.id) ?? 0 }])),
        }
      }),
    }
  })

  api.authed('PUT', '/api/budget/categories', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const list: Category[] = cleanCategories(body.list)
    if (list.length === 0) throw new HttpError(400, 'Keep at least one category.', 'invalid')
    const version = putOne('categories', null, list, body.baseVersion, ctx.user.id)
    s.audit('budget.changed', ctx, ctx.user.id, 'categories')
    return { version }
  })

  /** Starts a month from last month, bills, planned expenses and debts (the parents then adjust it). */
  api.authed('POST', '/api/budget/months/:month/start', parents, (ctx) => {
    const m = month(ctx.params.month, 'The month')
    if (readOne(s, 'month', m)) throw new HttpError(409, 'That month is already planned.', 'exists')
    const plan = startMonth(s, m, today())
    const version = putOne('month', m, plan, 0, ctx.user.id)
    s.audit('budget.changed', ctx, ctx.user.id, 'month started')
    return { plan, version }
  })

  api.authed('PUT', '/api/budget/months/:month', parents, async (ctx) => {
    const m = month(ctx.params.month, 'The month')
    const body = await readJson(ctx.req)
    const plan = cleanPlan(body.plan, m)
    const version = putOne('month', m, plan, body.baseVersion, ctx.user.id)
    s.audit('budget.changed', ctx, ctx.user.id, 'month')
    return { version }
  })

  api.authed('PUT', '/api/budget/milestones', parents, async (ctx) => {
    const body = await readJson(ctx.req)
    const version = putOne('milestones', null, cleanMilestones(body.item), body.baseVersion, ctx.user.id)
    return { version }
  })

  // Planned expenses and debts: one record each.
  const KINDS: Record<string, { kind: string; clean: (raw: unknown) => unknown }> = {
    planned: { kind: 'planned', clean: cleanPlanned },
    debts: { kind: 'debt', clean: cleanDebt },
  }
  const kindOf = (k: string | undefined) => {
    const v = KINDS[k ?? '']
    if (!v) throw new HttpError(404, 'Not found.', 'not_found')
    return v
  }
  api.authed('POST', '/api/budget/:kind', parents, async (ctx) => {
    const { kind, clean } = kindOf(ctx.params.kind)
    const item = clean((await readJson(ctx.req)).item)
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO budget (id, kind, key, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)').run(id, kind, id, sealBudget(s, kind, id, item), now, now, ctx.user.id)
    s.audit('budget.added', ctx, ctx.user.id, kind)
    return { item: { id, version: 1, ...(item as object) } }
  })
  api.authed('PUT', '/api/budget/:kind/:id', parents, async (ctx) => {
    const { kind, clean } = kindOf(ctx.params.kind)
    const existing = readOne<unknown>(s, kind, ctx.params.id!)
    if (!existing) throw new HttpError(404, 'That has been deleted.', 'not_found')
    const body = await readJson(ctx.req)
    const item = clean(body.item)
    if (body.baseVersion !== existing.version) throw conflict()
    db.prepare('UPDATE budget SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(sealBudget(s, kind, existing.id, item), s.now(), ctx.user.id, existing.id)
    s.audit('budget.changed', ctx, ctx.user.id, kind)
    return { item: { id: existing.id, version: existing.version + 1, ...(item as object) } }
  })
  api.authed('DELETE', '/api/budget/:kind/:id', parents, (ctx) => {
    const { kind } = kindOf(ctx.params.kind)
    if (Number(db.prepare('DELETE FROM budget WHERE kind = ? AND id = ?').run(kind, ctx.params.id!).changes) === 0) throw new HttpError(404, 'That has been deleted.', 'not_found')
    s.audit('budget.removed', ctx, ctx.user.id, kind)
    return undefined
  })

  // Transactions typed in by hand (part 2 adds the bank import).
  api.authed('POST', '/api/budget-transactions', parents, async (ctx) => {
    if ((db.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n >= MAX_TXNS) throw new HttpError(400, 'That is more than the hub keeps.', 'invalid')
    const t = cleanTxn((await readJson(ctx.req)).item)
    const id = newId()
    const now = s.now()
    db.prepare('INSERT INTO transactions (id, month, fingerprint, sealed, version, created_at, updated_at) VALUES (?, ?, NULL, ?, 1, ?, ?)').run(id, monthOf(t.date), sealTxn(s, id, t), now, now)
    return { item: { id, version: 1, ...t } }
  })
  api.authed('PUT', '/api/budget-transactions/:id', parents, async (ctx) => {
    const row = db.prepare('SELECT id, version FROM transactions WHERE id = ?').get(ctx.params.id!) as { id: string; version: number } | undefined
    if (!row) throw new HttpError(404, 'That has been deleted.', 'not_found')
    const body = await readJson(ctx.req)
    if (body.baseVersion !== row.version) throw conflict()
    const t = cleanTxn(body.item)
    db.prepare('UPDATE transactions SET month = ?, sealed = ?, version = version + 1, updated_at = ? WHERE id = ?').run(monthOf(t.date), sealTxn(s, row.id, t), s.now(), row.id)
    return { item: { id: row.id, version: row.version + 1, ...t } }
  })
  api.authed('DELETE', '/api/budget-transactions/:id', parents, (ctx) => {
    if (Number(db.prepare('DELETE FROM transactions WHERE id = ?').run(ctx.params.id!).changes) === 0) throw new HttpError(404, 'That has been deleted.', 'not_found')
    return undefined
  })
}
