/**
 * Money (phase 6a), for parents: bills, subscriptions and invoices, with
 * what is due, overdue and coming up for renewal. Sealed with the server key
 * on the server; no account or card numbers anywhere (docs/DATA-PROTECTION.md,
 * "Household admin").
 */
import { AlertTriangle, CheckCircle2, CreditCard, FileText, Landmark, Pencil, Plus, Receipt, Repeat } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AttachDocuments, Documents, type DocumentFolder } from '../health/parts.tsx'
import { Actions, conflict, Labelled } from './form.tsx'
import { BudgetTab, DebtTab, PlannedTab } from './Budget.tsx'
import type { Contact } from '../pages/Contacts.tsx'
import { decryptRecord, type StoredRecord } from '../quickinfo/model.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, PageHeader, Spinner, errorText, useAction } from '../ui.tsx'
import { vault } from '../vault/store.ts'
import { useVaultUnlocked } from '../vault/VaultCard.tsx'
import {
  amountText,
  automatic,
  BANKS,
  billFields,
  blankBill,
  CATEGORIES,
  daysFrom,
  howOften,
  METHODS,
  methodName,
  parseRand,
  rand,
  relative,
  shortDate,
  STATUSES,
  yearlyChange,
  type Account,
  type Bill,
  type BillFields,
  type Invoice,
  type InvoiceStatus,
  type Money,
} from './model.ts'

const dayAfter = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)

const HOUSEHOLD: DocumentFolder = { path: '/api/money/folder', name: 'Household' }

type Tab = 'overview' | 'budget' | 'bills' | 'subscriptions' | 'invoices' | 'planned' | 'debt' | 'accounts'
const TABS: [Tab, string][] = [
  ['overview', 'Overview'],
  ['budget', 'Budget'],
  ['bills', 'Bills'],
  ['subscriptions', 'Subscriptions'],
  ['invoices', 'Invoices'],
  ['planned', 'Planned'],
  ['debt', 'Debt'],
  ['accounts', 'Accounts'],
]

interface Extras {
  contacts: Contact[]
  people: { id: string; displayName: string }[]
  /** Insurance policies from Quick Info (only while the vault is open). */
  policies: { id: string; label: string }[]
}

type Editing =
  | { what: 'account'; account?: Account }
  | { what: 'bill'; bill?: Bill; type: 'bill' | 'subscription' }
  | { what: 'paid'; bill: Bill; due: string }
  | { what: 'problem'; bill: Bill; due: string }
  | { what: 'invoice'; invoice?: Invoice }

export function MoneyPage({ ctx }: { ctx: HubContext }) {
  if (ctx.user.role !== 'admin') {
    return (
      <div className="page">
        <PageHeader title="Bills & budget" />
        <Card>
          <p>Bills and the budget are kept by the parents.</p>
        </Card>
      </div>
    )
  }
  return <MoneyBody ctx={ctx} />
}

function MoneyBody({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const unlocked = useVaultUnlocked()
  const [money, setMoney] = useState<Money | null>(null)
  const [extras, setExtras] = useState<Extras>({ contacts: [], people: [], policies: [] })
  const [error, setError] = useState('')
  const [tab, setTab] = useState<Tab>('overview')
  const [editing, setEditing] = useState<Editing | null>(null)

  const load = useCallback(async () => {
    try {
      setMoney(await api.get<Money>('/api/money'))
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [api])

  useEffect(() => {
    void load()
    void (async () => {
      const [book, qi] = await Promise.all([api.get<{ contacts: Contact[] }>('/api/contacts'), api.get<{ profiles: { id: string; displayName: string }[]; records: StoredRecord[] }>('/api/quick-info')])
      const policies: Extras['policies'] = []
      const key = vault.use()
      if (key) {
        for (const r of qi.records.filter((x) => x.kind === 'policy')) {
          try {
            const f = (await decryptRecord(key, r)).fields
            policies.push({ id: r.id, label: [f.insurer, f.type].filter(Boolean).join(' · ') || 'Policy' })
          } catch {
            // not this family's key
          }
        }
      }
      setExtras({ contacts: book.contacts, people: qi.profiles, policies })
    })().catch(() => undefined)
  }, [api, load, unlocked])

  const done = (changed?: boolean) => {
    setEditing(null)
    if (changed) void load()
  }

  return (
    <div className="page">
      <PageHeader title="Bills & budget" subtitle="Bills, subscriptions and invoices; the monthly budget, planned expenses and debt. For parents only." />
      <div className="row chips" role="tablist" aria-label="Money">
        {TABS.map(([t, label]) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`chip ${tab === t ? 'chip-on' : ''}`} onClick={() => setTab(t)}>
            {label}
          </button>
        ))}
      </div>
      {error && <Banner kind="error">{error}</Banner>}
      {!money ? (
        !error && <Spinner />
      ) : (
        <>
          {tab === 'overview' && <Overview money={money} edit={setEditing} />}
          {tab === 'bills' && <Bills money={money} type="bill" edit={setEditing} />}
          {tab === 'subscriptions' && <Bills money={money} type="subscription" edit={setEditing} ctx={ctx} reload={load} />}
          {tab === 'invoices' && <Invoices ctx={ctx} money={money} edit={setEditing} />}
          {tab === 'accounts' && <Accounts money={money} edit={setEditing} />}
          {tab === 'budget' && <BudgetTab ctx={ctx} />}
          {tab === 'planned' && <PlannedTab ctx={ctx} />}
          {tab === 'debt' && <DebtTab ctx={ctx} />}
        </>
      )}
      {money && editing?.what === 'account' && <AccountDialog ctx={ctx} account={editing.account} onClose={done} />}
      {money && editing?.what === 'bill' && <BillDialog ctx={ctx} money={money} extras={extras} bill={editing.bill} type={editing.type} onClose={done} />}
      {money && (editing?.what === 'paid' || editing?.what === 'problem') && <PaidDialog ctx={ctx} money={money} bill={editing.bill} due={editing.due} problem={editing.what === 'problem'} onClose={done} />}
      {money && editing?.what === 'invoice' && <InvoiceDialog ctx={ctx} money={money} extras={extras} invoice={editing.invoice} onClose={done} />}
    </div>
  )
}

const accountName = (money: Money, id: string | null) => {
  if (!id) return ''
  const a = money.accounts.find((x) => x.id === id)
  return a ? `${a.bank}, ${a.nickname}` : 'Removed account'
}

const active = (money: Money, type?: 'bill' | 'subscription') => money.bills.filter((b) => b.status === 'active' && (!type || b.type === type))

// ---- overview --------------------------------------------------------------------------------

function Overview({ money, edit }: { money: Money; edit: (e: Editing) => void }) {
  const t = money.today
  const fixed = active(money).reduce((n, b) => n + b.monthly, 0)
  const subs = active(money, 'subscription')
  const subsMonthly = subs.reduce((n, b) => n + b.monthly, 0)
  const unpaid = money.invoices.filter((i) => i.status === 'unpaid')
  const late = [
    ...money.bills.flatMap((b) => b.overdue.map((due) => ({ key: `${b.id}-${due}`, title: b.name, due, amount: b.amount, problem: automatic(b), bill: b }))),
    ...unpaid.filter((i) => i.due && i.due < t).map((i) => ({ key: i.id, title: `Invoice: ${i.from}`, due: i.due!, amount: i.amount, problem: false, invoice: i })),
  ].sort((a, b) => a.due.localeCompare(b.due))
  const soon = [
    ...active(money)
      .filter((b) => b.nextDue && daysFrom(t, b.nextDue) <= 7 && !b.payments.some((p) => p.due === b.nextDue))
      .map((b) => ({ key: b.id, title: b.name, due: b.nextDue!, amount: b.amount, note: automatic(b) ? methodName(b.method).toLowerCase() : '', bill: b })),
    ...unpaid.filter((i) => i.due && i.due >= t && daysFrom(t, i.due) <= 7).map((i) => ({ key: i.id, title: `Invoice: ${i.from}`, due: i.due!, amount: i.amount, note: '', invoice: i })),
  ].sort((a, b) => a.due.localeCompare(b.due))
  const deadlines = [
    ...active(money)
      .filter((b) => b.noticeDeadline && b.noticeDeadline >= t && daysFrom(t, b.noticeDeadline) <= 60)
      .map((b) => ({ key: `n-${b.id}`, text: `${b.name}: last day to give notice`, date: b.noticeDeadline!, bill: b })),
    ...active(money)
      .filter((b) => b.trialEnd && b.trialEnd >= t && daysFrom(t, b.trialEnd) <= 30)
      .map((b) => ({ key: `t-${b.id}`, text: `${b.name}: free trial ends, then ${rand(b.amount)}`, date: b.trialEnd!, bill: b })),
    ...active(money)
      .filter((b) => b.reviewDue && daysFrom(t, b.reviewDue) <= 14)
      .map((b) => ({ key: `r-${b.id}`, text: `${b.name}: still using it?`, date: b.reviewDue!, bill: b })),
  ].sort((a, b) => a.date.localeCompare(b.date))

  if (money.bills.length === 0 && money.invoices.length === 0) {
    return (
      <Card title="Getting started">
        <p>Add the bills you pay every month or year (rates, insurance, school fees, the cellphone contract), your subscriptions, and invoices as they arrive. The hub then shows what is due, reminds you before notice deadlines and free trials end, and adds up what it all costs.</p>
        <p className="muted small">No account or card numbers are ever kept: an account is just the bank and a nickname, for knowing where a debit order comes from.</p>
        <div className="row">
          <Button icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'bill', type: 'bill' })}>
            Add a bill
          </Button>
          <Button variant="secondary" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'bill', type: 'subscription' })}>
            Add a subscription
          </Button>
          <Button variant="secondary" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'invoice' })}>
            Add an invoice
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <div className="stack">
      <div className="money-tiles">
        <Tile label="Fixed costs a month" value={rand(fixed)} note={`${active(money).length} bills and subscriptions`} />
        <Tile label="Subscriptions" value={`${rand(subsMonthly)} a month`} note={`${rand(subsMonthly * 12)} a year`} />
        <Tile label="Unpaid invoices" value={rand(unpaid.reduce((n, i) => n + i.amount, 0))} note={`${unpaid.length} invoice${unpaid.length === 1 ? '' : 's'}`} />
      </div>

      {late.length > 0 && (
        <Card
          title={
            <>
              <AlertTriangle size={18} aria-hidden /> Overdue
            </>
          }
          className="money-late"
        >
          <ul className="item-list">
            {late.map((l) => (
              <li key={l.key}>
                <div className="item-main">
                  <div>
                    <strong>{l.title}</strong> {rand(l.amount)}
                  </div>
                  <div className="small field-error">
                    {l.problem ? 'Payment problem' : 'Due'} {shortDate(l.due, money.today)} ({relative(money.today, l.due)})
                  </div>
                </div>
                {'bill' in l && l.bill && (
                  <Button variant="secondary" onClick={() => edit({ what: 'paid', bill: l.bill, due: l.due })}>
                    Mark paid
                  </Button>
                )}
                {'invoice' in l && l.invoice && (
                  <Button variant="secondary" onClick={() => edit({ what: 'invoice', invoice: l.invoice })}>
                    Open
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Due in the next 7 days">
        {soon.length === 0 ? (
          <p className="muted small">Nothing due this week.</p>
        ) : (
          <ul className="item-list">
            {soon.map((s) => (
              <li key={s.key}>
                <div className="item-main">
                  <div>
                    <strong>{s.title}</strong> {rand(s.amount)}
                  </div>
                  <div className="muted small">
                    {shortDate(s.due, money.today)} ({relative(money.today, s.due)}){s.note && ` · ${s.note}`}
                  </div>
                </div>
                {'bill' in s && s.bill && !automatic(s.bill) && (
                  <Button variant="secondary" onClick={() => edit({ what: 'paid', bill: s.bill, due: s.due })}>
                    Mark paid
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {deadlines.length > 0 && (
        <Card title="Renewals, trials and reviews">
          <ul className="item-list">
            {deadlines.map((d) => (
              <li key={d.key}>
                <div className="item-main">
                  <div>{d.text}</div>
                  <div className="muted small">
                    {shortDate(d.date, money.today)} ({relative(money.today, d.date)})
                  </div>
                </div>
                <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Open ${d.bill.name}`} onClick={() => edit({ what: 'bill', bill: d.bill, type: d.bill.type })} />
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="money-tile">
      <div className="muted small">{label}</div>
      <div className="money-tile-value">{value}</div>
      {note && <div className="muted small">{note}</div>}
    </div>
  )
}

// ---- bills and subscriptions -------------------------------------------------------------------

function Bills({ money, type, edit, ctx, reload }: { money: Money; type: 'bill' | 'subscription'; edit: (e: Editing) => void; ctx?: HubContext; reload?: () => Promise<void> }) {
  const [showStopped, setShowStopped] = useState(false)
  const t = money.today
  const mine = money.bills.filter((b) => b.type === type)
  const running = mine.filter((b) => b.status === 'active')
  const stopped = mine.filter((b) => b.status !== 'active')
  const monthly = running.reduce((n, b) => n + b.monthly, 0)
  const groups = useMemo(() => {
    const by = new Map<string, Bill[]>()
    for (const b of running.sort((a, b) => (a.nextDue ?? '9').localeCompare(b.nextDue ?? '9'))) by.set(b.category || 'Other', [...(by.get(b.category || 'Other') ?? []), b])
    return [...by.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [running])
  const reviewed = useAction(async (b: Bill) => {
    if (!ctx) return
    await ctx.platform.api.request('PUT', `/api/money/bills/${b.id}`, { baseVersion: b.version, item: { ...billFields(b), reviewedOn: t } })
    await reload?.()
  })

  const row = (b: Bill) => {
    const change = yearlyChange(b, t)
    const overdue = b.overdue[0]
    const paidNext = !!b.nextDue && b.payments.some((p) => p.due === b.nextDue)
    return (
      <li key={b.id}>
        <div className="item-main">
          <div>
            <strong>{b.name}</strong>
            {b.plan && <span className="muted small"> · {b.plan}</span>} {rand(b.amount)} <span className="muted small">{howOften(b)}</span>
            {b.status !== 'active' && <Badge>Cancelled</Badge>}
            {b.trialEnd && b.trialEnd >= t && <Badge tone="accent">Free trial to {shortDate(b.trialEnd, t)}</Badge>}
            {change && <Badge tone={change.startsWith('+') ? 'warning' : 'neutral'}>{change}</Badge>}
          </div>
          <div className="muted small">
            {b.status === 'active' && b.nextDue ? `Next ${shortDate(b.nextDue, t)} (${relative(t, b.nextDue)})${paidNext ? ', paid' : ''}` : b.status === 'active' ? 'No more payments' : `Cancelled ${shortDate(b.cancelledOn, t)}`}
            {` · ${methodName(b.method)}`}
            {b.accountId && ` · ${accountName(money, b.accountId)}`}
            {b.noticeDeadline && b.noticeDeadline >= t && ` · notice by ${shortDate(b.noticeDeadline, t)}`}
          </div>
          {overdue && (
            <div className="small field-error">
              {automatic(b) ? 'Payment problem' : 'Not marked paid'}: due {shortDate(overdue, t)}
              {b.overdue.length > 1 && ` and ${b.overdue.length - 1} before`}
            </div>
          )}
          {b.reviewDue && daysFrom(t, b.reviewDue) <= 14 && b.status === 'active' && (
            <div className="row small">
              <span>Still using it?</span>
              <Button variant="ghost" busy={reviewed.busy} onClick={() => void reviewed.run(b)}>
                Yes, keep it
              </Button>
              <Button variant="ghost" onClick={() => edit({ what: 'bill', bill: b, type: b.type })}>
                No, cancel it
              </Button>
            </div>
          )}
        </div>
        {b.status === 'active' && automatic(b) && !overdue && b.lastDue && daysFrom(b.lastDue, t) <= 10 && !b.problems.some((p) => p.due === b.lastDue) && (
          <Button variant="ghost" aria-label={`The ${b.name} payment did not go through`} onClick={() => edit({ what: 'problem', bill: b, due: b.lastDue! })}>
            Did not go through?
          </Button>
        )}
        {b.status === 'active' && (!automatic(b) || overdue) && (overdue || (b.nextDue && !paidNext && daysFrom(t, b.nextDue) <= 7)) && (
          <Button variant="secondary" aria-label={`Mark ${b.name} paid`} onClick={() => edit({ what: 'paid', bill: b, due: overdue ?? b.nextDue! })}>
            Mark paid
          </Button>
        )}
        <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${b.name}`} onClick={() => edit({ what: 'bill', bill: b, type: b.type })} />
      </li>
    )
  }

  return (
    <Card
      title={
        <>
          {type === 'bill' ? <Receipt size={18} aria-hidden /> : <Repeat size={18} aria-hidden />} {type === 'bill' ? 'Bills' : 'Subscriptions'}
        </>
      }
      actions={
        <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'bill', type })}>
          {type === 'bill' ? 'Add a bill' : 'Add a subscription'}
        </Button>
      }
    >
      {running.length > 0 && (
        <p className="small">
          <strong>{rand(monthly)}</strong> a month on average · <strong>{rand(monthly * 12)}</strong> a year
        </p>
      )}
      {mine.length === 0 && (
        <p className="muted small">
          {type === 'bill'
            ? 'Rates, levies, insurance, school fees, the cellphone contract: anything paid regularly.'
            : 'Streaming, music, apps, cloud storage, gym: what renews by itself. Add free trials too, to be reminded before they end.'}
        </p>
      )}
      {groups.map(([category, list]) => (
        <div key={category} className="stack-sm">
          <div className="muted small money-group">{category}</div>
          <ul className="item-list">{list.map(row)}</ul>
        </div>
      ))}
      {stopped.length > 0 && (
        <>
          <button className="link small" onClick={() => setShowStopped(!showStopped)}>
            {showStopped ? 'Hide cancelled' : `Cancelled (${stopped.length})`}
          </button>
          {showStopped && <ul className="item-list">{stopped.map(row)}</ul>}
        </>
      )}
      {reviewed.error && <Banner kind="error">{reviewed.error}</Banner>}
    </Card>
  )
}

// ---- invoices --------------------------------------------------------------------------------

function Invoices({ ctx, money, edit }: { ctx: HubContext; money: Money; edit: (e: Editing) => void }) {
  const [status, setStatus] = useState<'' | InvoiceStatus>('')
  const [year, setYear] = useState('')
  const [query, setQuery] = useState('')
  const t = money.today
  const years = [...new Set(money.invoices.map((i) => i.date.slice(0, 4)))].sort().reverse()
  const shown = money.invoices
    .filter((i) => (!status || i.status === status) && (!year || i.date.startsWith(year)))
    .filter((i) => !query.trim() || [i.from, i.number, i.notes].some((v) => v.toLowerCase().includes(query.trim().toLowerCase())))
    .sort((a, b) => (a.status === 'unpaid' ? 0 : 1) - (b.status === 'unpaid' ? 0 : 1) || (a.due ?? a.date).localeCompare(b.due ?? b.date))
  const unpaid = money.invoices.filter((i) => i.status === 'unpaid')
  return (
    <Card
      title={
        <>
          <FileText size={18} aria-hidden /> Invoices
        </>
      }
      actions={
        <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'invoice' })}>
          Add an invoice
        </Button>
      }
    >
      {unpaid.length > 0 && (
        <p className="small">
          <strong>{rand(unpaid.reduce((n, i) => n + i.amount, 0))}</strong> unpaid in {unpaid.length} invoice{unpaid.length === 1 ? '' : 's'}
        </p>
      )}
      {money.invoices.length === 0 ? (
        <p className="muted small">One-off bills: the plumber, the school trip, the doctor’s account. Keep the PDF with it in the Household folder.</p>
      ) : (
        <div className="row">
          <input className="qi-search" aria-label="Search invoices" placeholder="Search invoices" value={query} onChange={(e) => setQuery(e.target.value)} />
          <select className="select select-small" aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            <option value="">Any status</option>
            {STATUSES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
          <select className="select select-small" aria-label="Year" value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="">All years</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      )}
      <ul className="item-list">
        {shown.map((i) => {
          const late = i.status === 'unpaid' && i.due && i.due < t
          return (
            <li key={i.id}>
              <div className="item-main">
                <div>
                  <strong>{i.from}</strong>
                  {i.number && <span className="muted small"> · {i.number}</span>} {rand(i.amount)}
                  {i.status !== 'unpaid' && <Badge tone={i.status === 'paid' ? 'success' : i.status === 'disputed' ? 'warning' : 'neutral'}>{STATUSES.find(([s]) => s === i.status)?.[1]}</Badge>}
                </div>
                <div className={`small ${late ? 'field-error' : 'muted'}`}>
                  {shortDate(i.date, t)}
                  {i.due && i.status === 'unpaid' && ` · due ${shortDate(i.due, t)} (${relative(t, i.due)})`}
                  {i.status === 'paid' && i.paidOn && ` · paid ${shortDate(i.paidOn, t)}`}
                  {i.billId && ` · ${money.bills.find((b) => b.id === i.billId)?.name ?? ''}`}
                </div>
                {i.documents.length > 0 && <Documents ctx={ctx} documents={i.documents} />}
              </div>
              <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit the invoice from ${i.from}`} onClick={() => edit({ what: 'invoice', invoice: i })} />
            </li>
          )
        })}
      </ul>
      {money.invoices.length > 0 && shown.length === 0 && <p className="muted small">Nothing matches.</p>}
    </Card>
  )
}

// ---- accounts --------------------------------------------------------------------------------

function Accounts({ money, edit }: { money: Money; edit: (e: Editing) => void }) {
  return (
    <Card
      title={
        <>
          <Landmark size={18} aria-hidden /> Accounts
        </>
      }
      actions={
        <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => edit({ what: 'account' })}>
          Add an account
        </Button>
      }
    >
      <p className="muted small">Just the bank and a nickname, to see where each debit order comes from. Account and card numbers are never kept.</p>
      <ul className="item-list">
        {money.accounts.map((a) => {
          const bills = active(money).filter((b) => b.accountId === a.id)
          return (
            <li key={a.id}>
              <CreditCard size={20} aria-hidden />
              <div className="item-main">
                <div>
                  <strong>{a.nickname}</strong> <span className="muted small">{a.bank}</span>
                </div>
                <div className="muted small">
                  {bills.length} bill{bills.length === 1 ? '' : 's'}
                  {bills.length > 0 && ` · ${rand(bills.reduce((n, b) => n + b.monthly, 0))} a month`}
                </div>
              </div>
              <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit the account ${a.nickname}`} onClick={() => edit({ what: 'account', account: a })} />
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

// ---- dialogs ---------------------------------------------------------------------------------

function AccountDialog({ ctx, account, onClose }: { ctx: HubContext; account?: Account; onClose: (changed?: boolean) => void }) {
  const [bank, setBank] = useState(account?.bank ?? 'Capitec')
  const [nickname, setNickname] = useState(account?.nickname ?? '')
  const [notes, setNotes] = useState(account?.notes ?? '')
  const { api } = ctx.platform
  const save = useAction(async () => {
    const item = { bank, nickname, notes }
    if (account) await api.request('PUT', `/api/money/accounts/${account.id}`, { baseVersion: account.version, item }).catch(conflict)
    else await api.post('/api/money/accounts', { item })
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!account || !window.confirm(`Delete “${account.nickname}”? Bills paid from it are kept, without the account.`)) return
    await api.del(`/api/money/accounts/${account.id}`)
    onClose(true)
  })
  return (
    <Dialog open title={account ? 'Edit the account' : 'Add an account'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="acc-bank" label="Bank">
          <select id="acc-bank" className="select" value={bank} onChange={(e) => setBank(e.target.value)}>
            {[...new Set([...BANKS, bank])].map((b) => (
              <option key={b}>{b}</option>
            ))}
          </select>
        </Labelled>
        <Labelled id="acc-nick" label="Nickname" hint="e.g. Joint, Dean’s cheque, Savings. Never the account number.">
          <input id="acc-nick" className="qi-search" maxLength={60} required value={nickname} onChange={(e) => setNickname(e.target.value)} />
        </Labelled>
        <Labelled id="acc-notes" label="Notes">
          <textarea id="acc-notes" className="textarea" rows={2} maxLength={1000} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Labelled>
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={account ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

const REMIND_CHOICES: [string, number[]][] = [
  ['No reminder', []],
  ['On the day', [0]],
  ['3 days before and on the day', [3, 0]],
  ['A week before and the day before', [7, 1]],
]

function BillDialog({ ctx, money, extras, bill, type, onClose }: { ctx: HubContext; money: Money; extras: Extras; bill?: Bill; type: 'bill' | 'subscription'; onClose: (changed?: boolean) => void }) {
  const { api } = ctx.platform
  const t = money.today
  const [f, setF] = useState<BillFields>(() => (bill ? billFields(bill) : blankBill(type, t)))
  const [amount, setAmount] = useState(bill ? amountText(bill.amount) : '')
  const [priceFrom, setPriceFrom] = useState(t)
  const [contract, setContract] = useState(!!(bill?.contractEnd || bill?.contractStart))
  const set = <K extends keyof BillFields>(k: K, v: BillFields[K]) => setF((x) => ({ ...x, [k]: v }))
  const cents = parseRand(amount)
  const changed = bill && cents !== null && cents !== bill.amount
  const sub = f.type === 'subscription'

  const save = useAction(async () => {
    if (!f.name.trim()) throw new Error('Give it a name.')
    if (cents === null) throw new Error('Enter the amount, for example 199.00.')
    const item: BillFields = { ...f, amount: cents }
    // A new amount starts a new line in the price history.
    if (!bill) item.prices = [{ from: f.firstDue, amount: cents }]
    else if (changed) item.prices = [...f.prices.filter((p) => p.from !== priceFrom), { from: priceFrom, amount: cents }].sort((a, b) => a.from.localeCompare(b.from))
    if (!contract) Object.assign(item, { contractStart: null, contractEnd: null, noticeDays: null })
    if (item.status === 'cancelled' && !item.cancelledOn) item.cancelledOn = t
    if (item.status === 'active') item.cancelledOn = null
    if (bill) await api.request('PUT', `/api/money/bills/${bill.id}`, { baseVersion: bill.version, item }).catch(conflict)
    else await api.post('/api/money/bills', { item })
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!bill || !window.confirm(`Delete “${bill.name}” and its history? To stop it but keep the history, mark it cancelled instead.`)) return
    await api.del(`/api/money/bills/${bill.id}`)
    onClose(true)
  })
  const remindIndex = REMIND_CHOICES.findIndex(([, r]) => JSON.stringify(r) === JSON.stringify(f.remind))

  return (
    <Dialog open title={`${bill ? 'Edit' : 'Add'} ${sub ? 'a subscription' : 'a bill'}`} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="bill-name" label={sub ? 'Service' : 'What it is'}>
          <input id="bill-name" className="qi-search" maxLength={120} required placeholder={sub ? 'e.g. Netflix, Spotify, iCloud' : 'e.g. Municipal rates, Car insurance, School fees'} value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Labelled>
        {sub && (
          <Labelled id="bill-plan" label="Plan">
            <input id="bill-plan" className="qi-search" maxLength={80} placeholder="e.g. Premium, Family" value={f.plan} onChange={(e) => set('plan', e.target.value)} />
          </Labelled>
        )}
        <Labelled id="bill-payee" label="Paid to (from Contacts)" hint="Optional: link the company or person in Contacts.">
          <select id="bill-payee" className="select" value={f.payeeId ?? ''} onChange={(e) => set('payeeId', e.target.value || null)}>
            <option value="">Not in Contacts</option>
            {extras.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled id="bill-category" label="Category">
          <select id="bill-category" className="select" value={f.category} onChange={(e) => set('category', e.target.value)}>
            {[...new Set([...CATEGORIES, f.category])].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Labelled>
        <Labelled id="bill-amount" label="Amount (R)">
          <input id="bill-amount" className="qi-search" inputMode="decimal" required placeholder="e.g. 199.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Labelled>
        {changed && (
          <Labelled id="bill-price-from" label="The new amount applies from" hint={`It was ${rand(bill!.amount)}. Both stay in the price history.`}>
            <input id="bill-price-from" className="qi-search" type="date" value={priceFrom} onChange={(e) => setPriceFrom(e.target.value)} />
          </Labelled>
        )}
        <div className="row">
          <Labelled id="bill-unit" label="How often">
            <select id="bill-unit" className="select" value={f.unit} onChange={(e) => set('unit', e.target.value as BillFields['unit'])}>
              <option value="month">Monthly</option>
              <option value="year">Yearly</option>
              <option value="week">Weekly</option>
              <option value="once">Once</option>
            </select>
          </Labelled>
          {f.unit !== 'once' && (
            <Labelled id="bill-every" label={`Every how many ${f.unit}s`}>
              <input id="bill-every" className="qi-search year-input" type="number" min={1} max={60} value={f.every} onChange={(e) => set('every', Math.max(1, Number(e.target.value) || 1))} />
            </Labelled>
          )}
        </div>
        <Labelled id="bill-due" label={bill ? 'A due date' : 'Next due date'} hint={f.unit === 'once' ? undefined : 'The others follow from it (the same day each month; the month’s last day if it is shorter).'}>
          <input id="bill-due" className="qi-search" type="date" required value={f.firstDue} onChange={(e) => set('firstDue', e.target.value)} />
        </Labelled>
        <Labelled id="bill-method" label="How it is paid">
          <select
            id="bill-method"
            className="select"
            value={f.method}
            onChange={(e) => {
              const m = e.target.value as BillFields['method']
              setF((x) => ({ ...x, method: m, remind: !bill && x.remind.length === 0 && m === 'eft' ? [3, 0] : x.remind }))
            }}
          >
            {METHODS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled id="bill-account" label="From which account" hint={money.accounts.length === 0 ? 'Add accounts (bank and nickname) under Accounts.' : undefined}>
          <select id="bill-account" className="select" value={f.accountId ?? ''} onChange={(e) => set('accountId', e.target.value || null)}>
            <option value="">Not chosen</option>
            {money.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.bank}, {a.nickname}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled id="bill-remind" label="Remind me" hint={automatic(f) ? 'Debit orders and card charges count as paid unless you mark a problem.' : 'Mark it paid each time, or it shows as overdue the day after.'}>
          <select id="bill-remind" className="select" value={remindIndex < 0 ? 0 : remindIndex} onChange={(e) => set('remind', REMIND_CHOICES[Number(e.target.value)]![1])}>
            {REMIND_CHOICES.map(([l], i) => (
              <option key={l} value={i}>
                {l}
              </option>
            ))}
          </select>
        </Labelled>

        {sub && (
          <>
            <Labelled id="bill-trial" label="Free trial ends" hint="Reminded 3 days and 1 day before, so it does not roll into a paid plan by accident.">
              <input
                id="bill-trial"
                className="qi-search"
                type="date"
                value={f.trialEnd ?? ''}
                onChange={(e) => {
                  const end = e.target.value || null
                  // A new subscription is first charged the day after its free trial.
                  setF((x) => ({ ...x, trialEnd: end, firstDue: !bill && end && x.firstDue <= end ? dayAfter(end) : x.firstDue }))
                }}
              />
            </Labelled>
            <Labelled id="bill-review" label="Ask “still using it?”">
              <select id="bill-review" className="select" value={f.reviewMonths ?? ''} onChange={(e) => set('reviewMonths', e.target.value ? Number(e.target.value) : null)}>
                <option value="">Never</option>
                <option value="3">Every 3 months</option>
                <option value="6">Every 6 months</option>
                <option value="12">Every year</option>
              </select>
            </Labelled>
            {extras.people.length > 0 && (
              <fieldset className="radio-group">
                <legend>Who uses it</legend>
                <div className="row chips">
                  {extras.people.map((p) => {
                    const on = f.users.includes(p.id)
                    return (
                      <button key={p.id} type="button" className={`chip ${on ? 'chip-on' : ''}`} aria-pressed={on} onClick={() => set('users', on ? f.users.filter((u) => u !== p.id) : [...f.users, p.id])}>
                        {p.displayName}
                      </button>
                    )
                  })}
                </div>
              </fieldset>
            )}
            <Labelled id="bill-cancel-how" label="How to cancel">
              <input id="bill-cancel-how" className="qi-search" maxLength={500} placeholder="e.g. Account → Membership → Cancel; or a link" value={f.cancelHow} onChange={(e) => set('cancelHow', e.target.value)} />
            </Labelled>
          </>
        )}

        {!sub && extras.policies.length > 0 && (
          <Labelled id="bill-policy" label="Insurance policy (Quick Info)" hint="Links the premium to the policy, so it is entered once.">
            <select id="bill-policy" className="select" value={f.policyId ?? ''} onChange={(e) => set('policyId', e.target.value || null)}>
              <option value="">None</option>
              {extras.policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Labelled>
        )}

        <label className="check">
          <input type="checkbox" checked={contract} onChange={(e) => setContract(e.target.checked)} />
          <span>It is a contract with an end date</span>
        </label>
        {contract && (
          <fieldset className="radio-group">
            <legend>Contract</legend>
            <div className="row">
              <Labelled id="bill-cstart" label="Started">
                <input id="bill-cstart" className="qi-search" type="date" value={f.contractStart ?? ''} onChange={(e) => set('contractStart', e.target.value || null)} />
              </Labelled>
              <Labelled id="bill-cend" label="Ends">
                <input id="bill-cend" className="qi-search" type="date" value={f.contractEnd ?? ''} onChange={(e) => set('contractEnd', e.target.value || null)} />
              </Labelled>
            </div>
            <Labelled id="bill-notice" label="Notice needed to cancel (days)" hint="You are reminded before the last day to give notice (30, 7 and 1 day before), not the renewal date.">
              <input id="bill-notice" className="qi-search year-input" type="number" min={0} max={365} value={f.noticeDays ?? ''} onChange={(e) => set('noticeDays', e.target.value === '' ? null : Number(e.target.value))} />
            </Labelled>
          </fieldset>
        )}

        <Labelled id="bill-notes" label="Notes">
          <textarea id="bill-notes" className="textarea" rows={2} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>

        {bill && (
          <label className="check">
            <input type="checkbox" checked={f.status === 'cancelled'} onChange={(e) => set('status', e.target.checked ? 'cancelled' : 'active')} />
            <span>Cancelled (keeps the history; no more reminders)</span>
          </label>
        )}

        {bill && f.prices.length > 1 && (
          <fieldset className="radio-group">
            <legend>Price history</legend>
            {f.prices.map((p) => (
              <div key={p.from} className="row small">
                <span className="muted">From {shortDate(p.from, t)}</span> {rand(p.amount)}
              </div>
            ))}
          </fieldset>
        )}
        {bill && f.payments.length > 0 && (
          <fieldset className="radio-group">
            <legend>Paid</legend>
            {[...f.payments]
              .sort((a, b) => b.due.localeCompare(a.due))
              .slice(0, 12)
              .map((p) => (
                <div key={p.due} className="row small">
                  <CheckCircle2 size={14} aria-hidden /> {shortDate(p.due, t)}: {rand(p.amount)} on {shortDate(p.paidOn, t)}
                  {p.by && ` by ${p.by}`}
                  {p.note && <span className="muted"> · {p.note}</span>}
                </div>
              ))}
          </fieldset>
        )}

        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={bill ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

/** Marking one due date paid, or a debit order that did not go through. */
function PaidDialog({ ctx, money, bill, due, problem, onClose }: { ctx: HubContext; money: Money; bill: Bill; due: string; problem: boolean; onClose: (changed?: boolean) => void }) {
  const [paidOn, setPaidOn] = useState(money.today)
  const [amount, setAmount] = useState(amountText(bill.amount))
  const [note, setNote] = useState('')
  const save = useAction(async () => {
    const item = billFields(bill)
    if (problem) item.problems = [...item.problems.filter((p) => p.due !== due), { due, note: note.trim() }]
    else {
      const cents = parseRand(amount)
      if (cents === null) throw new Error('Enter the amount paid.')
      item.payments = [...item.payments.filter((p) => p.due !== due), { due, paidOn, amount: cents, by: ctx.user.displayName, note: note.trim() }]
    }
    await ctx.platform.api.request('PUT', `/api/money/bills/${bill.id}`, { baseVersion: bill.version, item }).catch(conflict)
    onClose(true)
  })
  return (
    <Dialog open title={problem ? `Payment problem · ${bill.name}` : `Mark paid · ${bill.name}`} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <p className="small">
          The payment due {shortDate(due, money.today)} ({rand(bill.amount)}).
        </p>
        {!problem && (
          <div className="row">
            <Labelled id="paid-on" label="Paid on">
              <input id="paid-on" className="qi-search" type="date" required value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </Labelled>
            <Labelled id="paid-amount" label="Amount (R)">
              <input id="paid-amount" className="qi-search" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Labelled>
          </div>
        )}
        <Labelled id="paid-note" label={problem ? 'What happened' : 'Note'}>
          <input id="paid-note" className="qi-search" maxLength={300} placeholder={problem ? 'e.g. Bounced, paid by EFT instead' : 'e.g. Reference 1234'} value={note} onChange={(e) => setNote(e.target.value)} />
        </Labelled>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} submit={problem ? 'Save the problem' : 'Mark paid'} />
      </form>
    </Dialog>
  )
}

function InvoiceDialog({ ctx, money, extras, invoice, onClose }: { ctx: HubContext; money: Money; extras: Extras; invoice?: Invoice; onClose: (changed?: boolean) => void }) {
  const { api } = ctx.platform
  const t = money.today
  const [f, setF] = useState(() => ({
    from: invoice?.from ?? '',
    payeeId: invoice?.payeeId ?? null,
    number: invoice?.number ?? '',
    date: invoice?.date ?? t,
    due: invoice?.due ?? '',
    status: invoice?.status ?? ('unpaid' as InvoiceStatus),
    paidOn: invoice?.paidOn ?? '',
    billId: invoice?.billId ?? null,
    notes: invoice?.notes ?? '',
  }))
  const [amount, setAmount] = useState(invoice ? amountText(invoice.amount) : '')
  const [documents, setDocuments] = useState(invoice?.documents ?? [])
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    const cents = parseRand(amount)
    if (!f.from.trim()) throw new Error('Say who it is from.')
    if (cents === null) throw new Error('Enter the amount, for example 850.00.')
    const item = { ...f, amount: cents, due: f.due || null, paidOn: f.status === 'paid' ? f.paidOn || t : null, documents }
    if (invoice) await api.request('PUT', `/api/money/invoices/${invoice.id}`, { baseVersion: invoice.version, item }).catch(conflict)
    else await api.post('/api/money/invoices', { item })
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!invoice || !window.confirm('Delete this invoice? Its documents stay in the Household folder.')) return
    await api.del(`/api/money/invoices/${invoice.id}`)
    onClose(true)
  })
  return (
    <Dialog open title={invoice ? 'Edit the invoice' : 'Add an invoice'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="inv-payee" label="From (Contacts)">
          <select
            id="inv-payee"
            className="select"
            value={f.payeeId ?? ''}
            onChange={(e) => {
              const c = extras.contacts.find((x) => x.id === e.target.value)
              setF((x) => ({ ...x, payeeId: c?.id ?? null, from: c ? c.name : x.from }))
            }}
          >
            <option value="">Not in Contacts</option>
            {extras.contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled id="inv-from" label="From">
          <input id="inv-from" className="qi-search" maxLength={120} required placeholder="e.g. Joe’s Plumbing" value={f.from} onChange={(e) => set('from', e.target.value)} />
        </Labelled>
        <div className="row">
          <Labelled id="inv-number" label="Invoice number">
            <input id="inv-number" className="qi-search" maxLength={60} value={f.number} onChange={(e) => set('number', e.target.value)} />
          </Labelled>
          <Labelled id="inv-amount" label="Amount (R)">
            <input id="inv-amount" className="qi-search" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Labelled>
        </div>
        <div className="row">
          <Labelled id="inv-date" label="Invoice date">
            <input id="inv-date" className="qi-search" type="date" required value={f.date} onChange={(e) => set('date', e.target.value)} />
          </Labelled>
          <Labelled id="inv-due" label="Due">
            <input id="inv-due" className="qi-search" type="date" value={f.due} onChange={(e) => set('due', e.target.value)} />
          </Labelled>
        </div>
        <div className="row">
          <Labelled id="inv-status" label="Status">
            <select id="inv-status" className="select" value={f.status} onChange={(e) => set('status', e.target.value as InvoiceStatus)}>
              {STATUSES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Labelled>
          {f.status === 'paid' && (
            <Labelled id="inv-paid" label="Paid on">
              <input id="inv-paid" className="qi-search" type="date" value={f.paidOn || t} onChange={(e) => set('paidOn', e.target.value)} />
            </Labelled>
          )}
        </div>
        {money.bills.length > 0 && (
          <Labelled id="inv-bill" label="Part of a bill" hint="For a statement of a regular bill.">
            <select id="inv-bill" className="select" value={f.billId ?? ''} onChange={(e) => set('billId', e.target.value || null)}>
              <option value="">No</option>
              {money.bills.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </Labelled>
        )}
        <Labelled id="inv-notes" label="Notes">
          <textarea id="inv-notes" className="textarea" rows={2} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        <AttachDocuments ctx={ctx} documents={documents} onChange={setDocuments} folder={HOUSEHOLD} />
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={invoice ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}
