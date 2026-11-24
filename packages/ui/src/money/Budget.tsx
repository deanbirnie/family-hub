/**
 * The budget (phase 6c): a zero-based monthly plan ("every rand gets a
 * job"), planned expenses with saving towards them, spending against the
 * plan, debts paid off smallest balance first, and the milestones.
 */
import { ArrowLeft, ArrowRight, CheckCircle2, Circle, CircleDot, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, Spinner, errorText, useAction } from '../ui.tsx'
import {
  addMonths,
  coverage,
  DEBT_KINDS,
  GROUP_NAMES,
  incomeTotal,
  linesTotal,
  monthName,
  monthShort,
  newLineId,
  plannedFor,
  type BudgetView,
  type Category,
  type Debt,
  type MonthPlan,
  type Planned,
  type Summary,
  type Txn,
} from './budget-model.ts'
import { amountText, parseRand, rand, shortDate } from './model.ts'
import { Actions, conflict, Labelled } from './form.tsx'

/** Loads one month of the budget, and saves the plan. */
function useBudget(ctx: HubContext, month: string) {
  const { api } = ctx.platform
  const [view, setView] = useState<BudgetView | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      setView(await api.get<BudgetView>(`/api/budget?month=${month}`))
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [api, month])
  useEffect(() => {
    void load()
  }, [load])
  return { view, error, load, setView }
}

const signedRand = (c: number) => (c < 0 ? `−${rand(-c)}` : rand(c))

// ---- the month -----------------------------------------------------------------------------------

export function BudgetTab({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7))
  const [mode, setMode] = useState<'month' | 'year'>('month')
  const { view, error, load, setView } = useBudget(ctx, month)
  const [editCats, setEditCats] = useState(false)
  const [move, setMove] = useState<{ to: string; amount: number } | null>(null)
  const [txn, setTxn] = useState<Txn | 'new' | null>(null)

  const start = useAction(async () => {
    await api.post(`/api/budget/months/${month}/start`)
    await load()
  })
  /**
   * Changes the plan: each change applies to the latest plan (so quick edits never overwrite each
   * other), shows at once, and is saved in turn with the latest version.
   */
  const planRef = useRef<MonthPlan | null>(null)
  const versionRef = useRef(0)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const [saveError, setSaveError] = useState('')
  useEffect(() => {
    planRef.current = view?.plan ?? null
    versionRef.current = view?.planVersion ?? 0
  }, [view?.month, view?.planVersion]) // eslint-disable-line react-hooks/exhaustive-deps
  const edit = (change: (p: MonthPlan) => MonthPlan) => {
    if (!planRef.current) return
    const next = change(planRef.current)
    planRef.current = next
    setView((v) => (v ? { ...v, plan: next } : v))
    queue.current = queue.current.then(async () => {
      try {
        const r = await api.request<{ version: number }>('PUT', `/api/budget/months/${month}`, { plan: next, baseVersion: versionRef.current }).catch(conflict)
        versionRef.current = r.version
        setSaveError('')
      } catch (e) {
        setSaveError(errorText(e))
        await load()
      }
    })
  }

  if (error) return <Banner kind="error">{error}</Banner>
  if (!view) return <Spinner />
  const plan = view.plan
  const income = incomeTotal(plan)
  const planned = linesTotal(plan)
  const left = income - planned

  const header = (
    <div className="row budget-month">
      <Button variant="ghost" icon={<ArrowLeft size={16} aria-hidden />} aria-label="Previous month" onClick={() => setMonth(addMonths(month, -1))} />
      <strong>{monthName(month)}</strong>
      <Button variant="ghost" icon={<ArrowRight size={16} aria-hidden />} aria-label="Next month" onClick={() => setMonth(addMonths(month, 1))} />
      <div className="row chips">
        <button className={`chip ${mode === 'month' ? 'chip-on' : ''}`} aria-pressed={mode === 'month'} onClick={() => setMode('month')}>
          The month
        </button>
        <button className={`chip ${mode === 'year' ? 'chip-on' : ''}`} aria-pressed={mode === 'year'} onClick={() => setMode('year')}>
          12 months
        </button>
      </div>
    </div>
  )
  if (mode === 'year') {
    return (
      <div className="stack">
        {header}
        <YearView ctx={ctx} month={month} />
      </div>
    )
  }

  if (!plan) {
    return (
      <div className="stack">
        {header}
        <Card title={`${monthName(month)} is not planned yet`}>
          <p>Plan the month before it starts: give every rand of income a job (giving, saving, the essentials, debt, everything else) until there is nothing left to plan.</p>
          <p className="muted small">The plan starts from {view.months.filter((m) => m < month).length ? 'last month’s plan, ' : ''}the bills due this month, your planned expenses and the debt payments. You change it from there.</p>
          {start.error && <Banner kind="error">{start.error}</Banner>}
          <div className="row">
            <Button busy={start.busy} onClick={() => void start.run()}>
              Plan {monthName(month)}
            </Button>
          </div>
        </Card>
      </div>
    )
  }

  const setLine = (id: string, change: Partial<MonthPlan['lines'][number]>) => void edit((p) => ({ ...p, lines: p.lines.map((l) => (l.id === id ? { ...l, ...change } : l)) }))
  const removeLine = (id: string) => void edit((p) => ({ ...p, lines: p.lines.filter((l) => l.id !== id) }))
  const addLine = (categoryId: string) => void edit((p) => ({ ...p, lines: [...p.lines, { id: newLineId(), categoryId, label: '', amount: 0, source: 'manual' }] }))
  const cats = view.categories

  return (
    <div className="stack">
      {header}
      <div className="money-tiles">
        <div className="money-tile">
          <div className="muted small">Income</div>
          <div className="money-tile-value">{rand(income)}</div>
          <div className="muted small">{view.incomeActual ? `${rand(view.incomeActual)} received` : 'planned'}</div>
        </div>
        <div className="money-tile">
          <div className="muted small">Given a job</div>
          <div className="money-tile-value">{rand(planned)}</div>
        </div>
        <div className={`money-tile ${left === 0 && income > 0 ? 'budget-zero' : left < 0 ? 'budget-over' : ''}`}>
          <div className="muted small">Left to plan</div>
          <div className="money-tile-value">{signedRand(left)}</div>
          <div className="small">{income === 0 ? 'Add the income first.' : left === 0 ? 'Every rand has a job.' : left > 0 ? 'Give it a job: saving, debt or a goal.' : 'Planned more than comes in.'}</div>
        </div>
      </div>

      {view.suggested.length > 0 && (
        <Banner kind="info">
          {view.suggested.length} new from bills, planned expenses and debts ({view.suggested.map((l) => l.label).join(', ')}).{' '}
          <button className="link" onClick={() => void edit((p) => ({ ...p, lines: [...p.lines, ...view.suggested] }))}>
            Add {view.suggested.length === 1 ? 'it' : 'them'}
          </button>
        </Banner>
      )}
      {saveError && <Banner kind="error">{saveError}</Banner>}

      <Card title="Income">
        <ul className="item-list">
          {plan.income.map((i) => (
            <li key={i.id}>
              <input className="qi-search" aria-label="Income name" defaultValue={i.label} placeholder="e.g. Salary" maxLength={80} onBlur={(e) => e.target.value !== i.label && void edit((p) => ({ ...p, income: p.income.map((x) => (x.id === i.id ? { ...x, label: e.target.value || 'Income' } : x)) }))} />
              <AmountInput label={`Amount of ${i.label || 'income'}`} value={i.amount} onChange={(amount) => void edit((p) => ({ ...p, income: p.income.map((x) => (x.id === i.id ? { ...x, amount } : x)) }))} />
              <Button variant="ghost" icon={<Trash2 size={16} aria-hidden />} aria-label={`Remove ${i.label}`} onClick={() => void edit((p) => ({ ...p, income: p.income.filter((x) => x.id !== i.id) }))} />
            </li>
          ))}
        </ul>
        <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => void edit((p) => ({ ...p, income: [...p.income, { id: newLineId(), label: 'Salary', amount: 0 }] }))}>
          Add income
        </Button>
      </Card>

      {GROUP_NAMES.map(([group, title]) => {
        const inGroup = cats.filter((c) => c.group === group)
        if (inGroup.length === 0) return null
        return (
          <Card key={group} title={title} className="budget-group">
            {inGroup.map((c) => {
              const p = plannedFor(plan, c.id)
              const spent = view.spent[c.id] ?? 0
              const leftHere = c.sinking ? (view.sinking[c.id] ?? 0) : p - spent
              const lines = plan.lines.filter((l) => l.categoryId === c.id)
              return (
                <div key={c.id} className="budget-cat">
                  <div className="budget-cat-head">
                    <strong>{c.name}</strong>
                    {c.sinking && <Badge tone="accent">Saves up</Badge>}
                    <span className="budget-figures small">
                      <span>Planned {rand(p)}</span>
                      <span>Spent {rand(spent)}</span>
                      <span className={leftHere < 0 ? 'field-error' : ''}>
                        {c.sinking ? 'Balance' : 'Left'} {signedRand(leftHere)}
                      </span>
                    </span>
                    {leftHere < 0 && (
                      <Button variant="ghost" onClick={() => setMove({ to: c.id, amount: -leftHere })}>
                        Cover it
                      </Button>
                    )}
                  </div>
                  {p > 0 && <div className="budget-bar" aria-hidden><span style={{ width: `${Math.min(100, (spent / Math.max(p, 1)) * 100)}%` }} className={spent > p ? 'over' : ''} /></div>}
                  <ul className="budget-lines">
                    {lines.map((l) => (
                      <li key={l.id}>
                        <input className="qi-search" aria-label={`What ${c.name} is for`} defaultValue={l.label} placeholder={c.name} maxLength={120} onBlur={(e) => e.target.value !== l.label && setLine(l.id, { label: e.target.value })} />
                        <AmountInput label={`Amount for ${l.label || c.name}`} value={l.amount} onChange={(amount) => setLine(l.id, { amount })} />
                        {l.source !== 'manual' && <span className="muted small">{l.source.startsWith('bill') ? 'bill' : l.source.startsWith('debt') ? 'debt' : 'planned'}</span>}
                        <Button variant="ghost" icon={<Trash2 size={14} aria-hidden />} aria-label={`Remove ${l.label || c.name}`} onClick={() => removeLine(l.id)} />
                      </li>
                    ))}
                  </ul>
                  <button className="link small" onClick={() => addLine(c.id)}>
                    + Add to {c.name}
                  </button>
                </div>
              )
            })}
          </Card>
        )
      })}

      <div className="row">
        <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} onClick={() => setEditCats(true)}>
          Change categories
        </Button>
      </div>

      {income > 0 && <IrregularIncome categories={cats} plan={plan} received={view.incomeActual} />}

      <Card
        title="Spending"
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => setTxn('new')}>
            Add
          </Button>
        }
      >
        {view.transactions.length === 0 ? (
          <p className="muted small">Spending and income for the month. Type them in, or import your bank’s CSV export (coming next).</p>
        ) : (
          <>
            {view.uncategorised > 0 && <p className="small field-error">{view.uncategorised} still to put in a category.</p>}
            <ul className="item-list">
              {view.transactions.map((t) => (
                <li key={t.id}>
                  <div className="item-main">
                    <div>
                      {t.description} <span className={t.amount < 0 ? '' : 'budget-in'}>{signedRand(t.amount)}</span>
                    </div>
                    <div className="muted small">
                      {shortDate(t.date, view.today)}
                      {t.accountId && ` · ${view.accounts.find((a) => a.id === t.accountId)?.nickname ?? ''}`}
                    </div>
                  </div>
                  <select
                    className="select select-small"
                    aria-label={`Category for ${t.description}`}
                    value={t.categoryId ?? ''}
                    onChange={async (e) => {
                      await api.request('PUT', `/api/budget-transactions/${t.id}`, { baseVersion: t.version, item: { ...t, categoryId: e.target.value || null } }).catch(conflict)
                      void load()
                    }}
                  >
                    <option value="">Choose…</option>
                    <option value="income">Income</option>
                    <option value="transfer">Between our accounts</option>
                    {cats.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <Button variant="ghost" icon={<Pencil size={14} aria-hidden />} aria-label={`Edit ${t.description}`} onClick={() => setTxn(t)} />
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {editCats && (
        <CategoriesDialog
          ctx={ctx}
          view={view}
          onClose={(changed) => {
            setEditCats(false)
            if (changed) void load()
          }}
        />
      )}
      {move && (
        <MoveDialog
          view={view}
          plan={plan}
          to={move.to}
          amount={move.amount}
          onSave={(m) => {
            setMove(null)
            void edit((p) => ({ ...p, moves: [...p.moves, m] }))
          }}
          onClose={() => setMove(null)}
        />
      )}
      {txn && (
        <TxnDialog
          ctx={ctx}
          view={view}
          txn={txn === 'new' ? undefined : txn}
          onClose={(changed) => {
            setTxn(null)
            if (changed) void load()
          }}
        />
      )}
    </div>
  )
}

/** An amount field that saves when it loses focus. */
function AmountInput({ value, onChange, label }: { value: number; onChange: (cents: number) => void; label: string }) {
  const [text, setText] = useState(amountText(value))
  useEffect(() => setText(amountText(value)), [value])
  return (
    <input
      className="qi-search budget-amount"
      inputMode="decimal"
      aria-label={label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        const c = parseRand(text || '0')
        if (c === null) setText(amountText(value))
        else if (c !== value) onChange(c)
      }}
    />
  )
}

function IrregularIncome({ categories, plan, received }: { categories: Category[]; plan: MonthPlan; received: number }) {
  const [open, setOpen] = useState(false)
  const rows = coverage(categories, plan, received)
  return (
    <Card title="When income comes in bits">
      <p className="muted small">
        Money received so far ({rand(received)}) covers the plan in order of priority: giving, saving and the essentials first. Reorder the categories to change the order.
      </p>
      <button className="link small" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show what is covered'}
      </button>
      {open && (
        <ul className="item-list">
          {rows.map((r) => (
            <li key={r.id}>
              {r.covered === 'yes' ? <CheckCircle2 size={16} aria-label="Covered" /> : r.covered === 'part' ? <CircleDot size={16} aria-label="Partly covered" /> : <Circle size={16} aria-label="Not yet" />}
              <div className="item-main">{categories.find((c) => c.id === r.id)?.name}</div>
              <span className="small">{rand(r.planned)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function MoveDialog({ view, plan, to, amount, onSave, onClose }: { view: BudgetView; plan: MonthPlan; to: string; amount: number; onSave: (m: MonthPlan['moves'][number]) => void; onClose: () => void }) {
  const sources = view.categories.filter((c) => c.id !== to && plannedFor(plan, c.id) - (view.spent[c.id] ?? 0) > 0)
  const [from, setFrom] = useState(sources[0]?.id ?? '')
  const [text, setText] = useState(amountText(amount))
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const name = (id: string) => view.categories.find((c) => c.id === id)?.name ?? ''
  return (
    <Dialog open title={`Cover ${name(to)}`} onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault()
          const c = parseRand(text)
          if (!from || c === null || c <= 0) return setError('Choose where it comes from and how much.')
          onSave({ date: view.today, from, to, amount: c, note })
        }}
      >
        <p className="small">Overspent by {rand(amount)}. Move money from a category with some left, so the plan still adds up.</p>
        {sources.length === 0 ? (
          <Banner kind="warning">No category has money left this month.</Banner>
        ) : (
          <Labelled id="move-from" label="From">
            <select id="move-from" className="select" value={from} onChange={(e) => setFrom(e.target.value)}>
              {sources.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({rand(plannedFor(plan, c.id) - (view.spent[c.id] ?? 0))} left)
                </option>
              ))}
            </select>
          </Labelled>
        )}
        <Labelled id="move-amount" label="Amount (R)">
          <input id="move-amount" className="qi-search" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} />
        </Labelled>
        <Labelled id="move-note" label="Note">
          <input id="move-note" className="qi-search" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
        </Labelled>
        {error && <Banner kind="error">{error}</Banner>}
        <Actions busy={false} onCancel={onClose} submit="Move it" />
      </form>
    </Dialog>
  )
}

function TxnDialog({ ctx, view, txn, onClose }: { ctx: HubContext; view: BudgetView; txn?: Txn; onClose: (changed?: boolean) => void }) {
  const { api } = ctx.platform
  const [f, setF] = useState(() => ({
    date: txn?.date ?? (view.month === view.today.slice(0, 7) ? view.today : `${view.month}-01`),
    description: txn?.description ?? '',
    direction: (txn && txn.amount > 0 ? 'in' : 'out') as 'in' | 'out',
    categoryId: txn?.categoryId ?? '',
    accountId: txn?.accountId ?? '',
    note: txn?.note ?? '',
  }))
  const [amount, setAmount] = useState(txn ? amountText(Math.abs(txn.amount)) : '')
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    const c = parseRand(amount)
    if (c === null) throw new Error('Enter the amount, for example 350.00.')
    const item = { date: f.date, description: f.description, amount: f.direction === 'out' ? -c : c, categoryId: f.categoryId || null, accountId: f.accountId || null, note: f.note }
    if (txn) await api.request('PUT', `/api/budget-transactions/${txn.id}`, { baseVersion: txn.version, item }).catch(conflict)
    else await api.post('/api/budget-transactions', { item })
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!txn || !window.confirm('Delete this transaction?')) return
    await api.del(`/api/budget-transactions/${txn.id}`)
    onClose(true)
  })
  return (
    <Dialog open title={txn ? 'Edit the transaction' : 'Add a transaction'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <div className="row">
          <Labelled id="txn-date" label="Date">
            <input id="txn-date" className="qi-search" type="date" required value={f.date} onChange={(e) => set('date', e.target.value)} />
          </Labelled>
          <Labelled id="txn-dir" label="Money">
            <select id="txn-dir" className="select" value={f.direction} onChange={(e) => set('direction', e.target.value)}>
              <option value="out">Out (spent)</option>
              <option value="in">In (income or refund)</option>
            </select>
          </Labelled>
        </div>
        <Labelled id="txn-desc" label="What">
          <input id="txn-desc" className="qi-search" required maxLength={200} placeholder="e.g. Woolworths" value={f.description} onChange={(e) => set('description', e.target.value)} />
        </Labelled>
        <Labelled id="txn-amount" label="Amount (R)">
          <input id="txn-amount" className="qi-search" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Labelled>
        <Labelled id="txn-cat" label="Category">
          <select id="txn-cat" className="select" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
            <option value="">Choose later</option>
            <option value="income">Income</option>
            <option value="transfer">Between our accounts</option>
            {view.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Labelled>
        {view.accounts.length > 0 && (
          <Labelled id="txn-acc" label="Account">
            <select id="txn-acc" className="select" value={f.accountId} onChange={(e) => set('accountId', e.target.value)}>
              <option value="">Not chosen</option>
              {view.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.bank}, {a.nickname}
                </option>
              ))}
            </select>
          </Labelled>
        )}
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={txn ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

function CategoriesDialog({ ctx, view, onClose }: { ctx: HubContext; view: BudgetView; onClose: (changed?: boolean) => void }) {
  const [list, setList] = useState<Category[]>(view.categories)
  const [openings, setOpenings] = useState<Record<string, string>>(() => Object.fromEntries(view.categories.map((c) => [c.id, c.opening ? amountText(c.opening) : ''])))
  const set = (id: string, change: Partial<Category>) => setList((l) => l.map((c) => (c.id === id ? { ...c, ...change } : c)))
  const moveBy = (i: number, d: number) =>
    setList((l) => {
      const j = i + d
      if (j < 0 || j >= l.length) return l
      const copy = [...l]
      ;[copy[i], copy[j]] = [copy[j]!, copy[i]!]
      return copy
    })
  const save = useAction(async () => {
    const out = list.map((c) => ({ ...c, opening: c.sinking ? (parseRand(openings[c.id] || '0') ?? 0) : 0 }))
    await ctx.platform.api.request('PUT', '/api/budget/categories', { list: out, baseVersion: view.categoriesVersion }).catch(conflict)
    onClose(true)
  })
  return (
    <Dialog open title="Categories" onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <p className="muted small">In order of priority (used when income comes in bits). A category that “saves up” keeps what is not spent for next month: for known irregular costs like the car service, Christmas or school.</p>
        {list.map((c, i) => (
          <fieldset key={c.id} className="radio-group">
            <div className="row">
              <input className="qi-search" aria-label="Category name" maxLength={60} value={c.name} onChange={(e) => set(c.id, { name: e.target.value })} />
              <select className="select select-small" aria-label={`Group of ${c.name}`} value={c.group} onChange={(e) => set(c.id, { group: e.target.value as Category['group'] })}>
                {GROUP_NAMES.map(([g, label]) => (
                  <option key={g} value={g}>
                    {label.replace(/ \(.*\)$/, '')}
                  </option>
                ))}
              </select>
              <Button type="button" variant="ghost" icon={<ArrowLeft size={14} className="rotate-90" aria-hidden />} aria-label={`Move ${c.name} up`} onClick={() => moveBy(i, -1)} />
              <Button type="button" variant="ghost" icon={<Trash2 size={14} aria-hidden />} aria-label={`Remove ${c.name}`} onClick={() => setList((l) => l.filter((x) => x.id !== c.id))} />
            </div>
            <div className="row small">
              <label className="check">
                <input type="checkbox" checked={c.sinking} onChange={(e) => set(c.id, { sinking: e.target.checked })} />
                <span>Saves up</span>
              </label>
              {c.sinking && <input className="qi-search budget-amount" aria-label={`Balance already saved for ${c.name}`} placeholder="Already saved" inputMode="decimal" value={openings[c.id] ?? ''} onChange={(e) => setOpenings({ ...openings, [c.id]: e.target.value })} />}
              <select className="select select-small" aria-label={`What ${c.name} is`} value={c.role} onChange={(e) => set(c.id, { role: e.target.value as Category['role'] })}>
                <option value="">—</option>
                <option value="emergency">The emergency fund</option>
                <option value="retirement">Retirement saving</option>
                <option value="education">Education saving</option>
              </select>
            </div>
          </fieldset>
        ))}
        <Button type="button" variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => setList((l) => [...l, { id: newLineId().replace('l-', 'c-'), name: 'New category', group: 'lifestyle', sinking: false, role: '', opening: 0 }])}>
          Add a category
        </Button>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} />
      </form>
    </Dialog>
  )
}

function YearView({ ctx, month }: { ctx: HubContext; month: string }) {
  const [data, setData] = useState<Summary | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    ctx.platform.api.get<Summary>(`/api/budget/summary?month=${month}`).then(setData, (e) => setError(errorText(e)))
  }, [ctx.platform.api, month])
  if (error) return <Banner kind="error">{error}</Banner>
  if (!data) return <Spinner />
  const year = month.slice(0, 4)
  const used = data.categories.filter((c) => data.months.some((m) => m.byCategory[c.id]!.planned || m.byCategory[c.id]!.spent))
  return (
    <Card title="The last 12 months">
      <div className="budget-year">
        <table>
          <thead>
            <tr>
              <th scope="col">Spent of planned</th>
              {data.months.map((m) => (
                <th key={m.month} scope="col">
                  {monthShort(m.month, year)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="budget-year-income">
              <th scope="row">Income</th>
              {data.months.map((m) => (
                <td key={m.month}>
                  {m.incomeActual || m.incomePlanned ? (
                    <>
                      {rand(m.incomeActual).replace('.00', '')}
                      <div className="muted">{rand(m.incomePlanned).replace('.00', '')}</div>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
              ))}
            </tr>
            {used.map((c) => (
              <tr key={c.id}>
                <th scope="row">{c.name}</th>
                {data.months.map((m) => {
                  const v = m.byCategory[c.id]!
                  return (
                    <td key={m.month} className={v.spent > v.planned && !c.sinking ? 'field-error' : ''}>
                      {v.planned || v.spent ? (
                        <>
                          {rand(v.spent).replace('.00', '')}
                          <div className="muted">{rand(v.planned).replace('.00', '')}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">Each cell: spent (or received), with the plan below. Red where spending went over the plan.</p>
    </Card>
  )
}

// ---- planned expenses ----------------------------------------------------------------------------

export function PlannedTab({ ctx }: { ctx: HubContext }) {
  const { view, error, load } = useBudget(ctx, new Date().toISOString().slice(0, 7))
  const [editing, setEditing] = useState<Planned | 'new' | null>(null)
  const [people, setPeople] = useState<{ id: string; displayName: string }[]>([])
  useEffect(() => {
    ctx.platform.api.get<{ profiles: { id: string; displayName: string }[] }>('/api/quick-info').then((r) => setPeople(r.profiles), () => undefined)
  }, [ctx.platform.api])
  if (error) return <Banner kind="error">{error}</Banner>
  if (!view) return <Spinner />
  const now = view.today.slice(0, 7)
  const upcoming = view.planned.filter((p) => !p.done && p.month >= now).sort((a, b) => a.month.localeCompare(b.month))
  const past = view.planned.filter((p) => p.done || p.month < now)
  const row = (p: Planned) => {
    const n = p.saveFrom ? Math.max(1, (Number(p.month.slice(0, 4)) - Number(p.saveFrom.slice(0, 4))) * 12 + Number(p.month.slice(5)) - Number(p.saveFrom.slice(5)) + 1) : 1
    return (
      <li key={p.id}>
        <div className="item-main">
          <div>
            <strong>{p.name}</strong> {rand(p.amount)}
            {p.tag && <Badge>{p.tag}</Badge>}
            {p.done && <Badge tone="success">Done</Badge>}
          </div>
          <div className="muted small">
            {monthName(p.month)}
            {p.saveFrom && ` · saving ${rand(Math.floor(p.amount / n))} a month from ${monthShort(p.saveFrom, now.slice(0, 4))}`}
            {p.profileId && ` · ${people.find((x) => x.id === p.profileId)?.displayName ?? ''}`}
            {p.categoryId && ` · ${view.categories.find((c) => c.id === p.categoryId)?.name ?? ''}`}
          </div>
        </div>
        <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${p.name}`} onClick={() => setEditing(p)} />
      </li>
    )
  }
  return (
    <Card
      title="Planned expenses"
      actions={
        <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => setEditing('new')}>
          Plan an expense
        </Button>
      }
    >
      <p className="muted small">Known costs ahead (school camp, uniforms, the car service, Christmas, a holiday): each shows up in its month’s budget, or is saved for a little each month until then.</p>
      {upcoming.length > 0 && <ul className="item-list">{upcoming.map(row)}</ul>}
      {past.length > 0 && (
        <details>
          <summary className="small">Done and past ({past.length})</summary>
          <ul className="item-list">{past.map(row)}</ul>
        </details>
      )}
      {editing && (
        <PlannedDialog
          ctx={ctx}
          view={view}
          people={people}
          planned={editing === 'new' ? undefined : editing}
          onClose={(changed) => {
            setEditing(null)
            if (changed) void load()
          }}
        />
      )}
    </Card>
  )
}

export function PlannedDialog({
  ctx,
  view,
  people,
  planned,
  preset,
  onClose,
}: {
  ctx: HubContext
  view: Pick<BudgetView, 'today' | 'categories'>
  people: { id: string; displayName: string }[]
  planned?: Planned
  preset?: Partial<Planned>
  onClose: (changed?: boolean) => void
}) {
  const { api } = ctx.platform
  const base = planned ?? preset ?? {}
  const [f, setF] = useState(() => ({
    name: base.name ?? '',
    month: base.month ?? addMonths(view.today.slice(0, 7), 1),
    categoryId: base.categoryId ?? '',
    saveFrom: base.saveFrom ?? '',
    profileId: base.profileId ?? '',
    tag: base.tag ?? '',
    done: base.done ?? false,
    notes: base.notes ?? '',
  }))
  const [amount, setAmount] = useState(base.amount ? amountText(base.amount) : '')
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }))
  const cat = view.categories.find((c) => c.id === f.categoryId)
  const save = useAction(async () => {
    const c = parseRand(amount)
    if (c === null) throw new Error('Enter the amount, for example 1200.00.')
    const item = { ...f, amount: c, categoryId: f.categoryId || null, saveFrom: f.saveFrom || null, profileId: f.profileId || null }
    if (planned) await api.request('PUT', `/api/budget/planned/${planned.id}`, { baseVersion: planned.version, item }).catch(conflict)
    else await api.post('/api/budget/planned', { item })
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!planned || !window.confirm(`Delete “${planned.name}”?`)) return
    await api.del(`/api/budget/planned/${planned.id}`)
    onClose(true)
  })
  return (
    <Dialog open title={planned ? 'Edit the planned expense' : 'Plan an expense'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="pl-name" label="What">
          <input id="pl-name" className="qi-search" maxLength={120} required placeholder="e.g. School camp, New uniform, Car service" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Labelled>
        <div className="row">
          <Labelled id="pl-amount" label="Amount (R)">
            <input id="pl-amount" className="qi-search" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Labelled>
          <Labelled id="pl-month" label="Month it is spent">
            <input id="pl-month" className="qi-search" type="month" required value={f.month} onChange={(e) => set('month', e.target.value)} />
          </Labelled>
        </div>
        <Labelled id="pl-cat" label="Category">
          <select id="pl-cat" className="select" value={f.categoryId} onChange={(e) => set('categoryId', e.target.value)}>
            <option value="">Miscellaneous</option>
            {view.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.sinking ? ' (saves up)' : ''}
              </option>
            ))}
          </select>
        </Labelled>
        <Labelled id="pl-save" label="Save towards it from" hint={f.saveFrom && cat && !cat.sinking ? 'Choose a category that saves up, so what is put aside carries over to the month it is spent.' : 'Leave empty to plan it all in its month.'}>
          <input id="pl-save" className="qi-search" type="month" max={f.month} value={f.saveFrom} onChange={(e) => set('saveFrom', e.target.value)} />
        </Labelled>
        {people.length > 0 && (
          <Labelled id="pl-who" label="For">
            <select id="pl-who" className="select" value={f.profileId} onChange={(e) => set('profileId', e.target.value)}>
              <option value="">The family</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </Labelled>
        )}
        <Labelled id="pl-tag" label="Tag">
          <input id="pl-tag" className="qi-search" maxLength={30} placeholder="e.g. school" value={f.tag} onChange={(e) => set('tag', e.target.value)} />
        </Labelled>
        {planned && (
          <label className="check">
            <input type="checkbox" checked={f.done} onChange={(e) => set('done', e.target.checked)} />
            <span>Done (paid; no longer planned)</span>
          </label>
        )}
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={planned ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

// ---- debt and milestones -------------------------------------------------------------------------

export function DebtTab({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const { view, error, load } = useBudget(ctx, new Date().toISOString().slice(0, 7))
  const [editing, setEditing] = useState<Debt | 'new' | null>(null)
  const [balanceFor, setBalanceFor] = useState<Debt | null>(null)
  const saveMilestones = useAction(async (change: Partial<BudgetView['milestones']>) => {
    if (!view) return
    await api.request('PUT', '/api/budget/milestones', { item: { ...view.milestones, ...change }, baseVersion: view.milestonesVersion }).catch(conflict)
    await load()
  })
  if (error) return <Banner kind="error">{error}</Banner>
  if (!view) return <Spinner />
  const active = view.debts.filter((d) => !d.paidOff && d.balance > 0)
  const done = view.debts.filter((d) => d.paidOff || d.balance === 0)
  const ordered = view.snowball.order.map((o) => ({ o, d: active.find((d) => d.id === o.id)! })).filter((x) => x.d)
  const year = view.today.slice(0, 4)
  return (
    <div className="stack">
      <Card
        title="Debt, smallest balance first"
        actions={
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => setEditing('new')}>
            Add a debt
          </Button>
        }
      >
        <p className="muted small">Pay the minimum on every debt and everything extra on the smallest. When it is paid off, its whole payment rolls into the next. (The home loan is kept for later.)</p>
        {active.length > 0 && (
          <div className="money-tiles">
            <div className="money-tile">
              <div className="muted small">Owed</div>
              <div className="money-tile-value">{rand(view.progress.debtLeft)}</div>
            </div>
            <div className="money-tile">
              <div className="muted small">Debt-free</div>
              <div className="money-tile-value">{view.snowball.debtFree ? monthName(view.snowball.debtFree) : 'Not at this rate'}</div>
              {!view.snowball.debtFree && <div className="small field-error">The payments do not keep up with the interest.</div>}
            </div>
          </div>
        )}
        <div className="row">
          <label className="small" htmlFor="extra-debt">
            Extra each month for the smallest debt
          </label>
          <AmountInput label="Extra each month for the smallest debt" value={view.milestones.extraDebt} onChange={(c) => void saveMilestones.run({ extraDebt: c })} />
        </div>
        <ol className="item-list debt-list">
          {ordered.map(({ o, d }, i) => (
            <li key={d.id}>
              <div className="item-main">
                <div>
                  <strong>{d.name}</strong> {rand(d.balance)}
                  {i === 0 && <Badge tone="accent">Paying off now</Badge>}
                </div>
                <div className="muted small">
                  {rand(o.payment)} a month now · {d.rate}% interest · minimum {rand(d.minimum)}
                  {o.payoffMonth && ` · paid off ${monthShort(o.payoffMonth, year)}${o.payoffMonth.slice(0, 4) !== year ? '' : ` ${year}`}`}
                </div>
                <div className="muted small">Balance on {shortDate(d.balanceOn, view.today)}</div>
              </div>
              <Button variant="secondary" onClick={() => setBalanceFor(d)}>
                New balance
              </Button>
              <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${d.name}`} onClick={() => setEditing(d)} />
            </li>
          ))}
        </ol>
        {done.length > 0 && (
          <p className="small">
            <CheckCircle2 size={14} aria-hidden /> Paid off: {done.map((d) => `${d.name}${d.paidOff ? ` (${shortDate(d.paidOff, view.today)})` : ''}`).join(', ')}
          </p>
        )}
        {saveMilestones.error && <Banner kind="error">{saveMilestones.error}</Banner>}
      </Card>

      <MilestonesCard view={view} save={(c) => void saveMilestones.run(c)} />

      {editing && (
        <DebtDialog
          ctx={ctx}
          debt={editing === 'new' ? undefined : editing}
          today={view.today}
          onClose={(changed) => {
            setEditing(null)
            if (changed) void load()
          }}
        />
      )}
      {balanceFor && (
        <BalanceDialog
          ctx={ctx}
          debt={balanceFor}
          today={view.today}
          onClose={(changed) => {
            setBalanceFor(null)
            if (changed) void load()
          }}
        />
      )}
    </div>
  )
}

function MilestonesCard({ view, save }: { view: BudgetView; save: (c: Partial<BudgetView['milestones']>) => void }) {
  const m = view.milestones
  const p = view.progress
  const fund = p.emergency ?? 0
  const fullTarget = m.fundMonths * p.essentialMonth
  const retirementPct = p.income > 0 && p.retirementPlanned !== null ? Math.round((p.retirementPlanned / p.income) * 100) : null
  const tick = (step: string) => m.ticks[step] ?? { done: false, note: '' }
  const setTick = (step: string, change: Partial<{ done: boolean; note: string }>) => save({ ticks: { ...m.ticks, [step]: { ...tick(step), ...change } } })
  const steps: { n: number; title: string; done: boolean; detail: React.ReactNode }[] = [
    {
      n: 1,
      title: 'A starter emergency fund',
      done: fund >= m.starterTarget,
      detail: (
        <>
          {rand(fund)} of <AmountInput label="Starter emergency fund target" value={m.starterTarget} onChange={(c) => save({ starterTarget: c })} />
          {p.emergency === null && <div className="muted small">Mark a category as the emergency fund under Budget → Change categories.</div>}
        </>
      ),
    },
    { n: 2, title: 'All debt paid off, except the home', done: p.debtLeft === 0 && view.debts.length > 0, detail: p.debtLeft ? `${rand(p.debtLeft)} to go${view.snowball.debtFree ? `, debt-free by ${monthName(view.snowball.debtFree)}` : ''}` : view.debts.length ? 'Done.' : 'Add your debts above.' },
    {
      n: 3,
      title: 'A full emergency fund',
      done: fullTarget > 0 && fund >= fullTarget,
      detail: (
        <>
          {rand(fund)} of {rand(fullTarget)} ({' '}
          <select className="select select-small" aria-label="Months of essential expenses" value={m.fundMonths} onChange={(e) => save({ fundMonths: Number(e.target.value) })}>
            {[3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n} months
              </option>
            ))}
          </select>{' '}
          of essentials at {rand(p.essentialMonth)} a month)
        </>
      ),
    },
    { n: 4, title: 'Saving 15% of income for retirement', done: tick('4').done || (retirementPct ?? 0) >= 15, detail: retirementPct !== null ? `${retirementPct}% planned this month` : 'Mark a category as retirement saving, or tick it when it is in place.' },
    { n: 5, title: 'Saving for the children’s education', done: tick('5').done, detail: null },
    { n: 6, title: 'Paying off the home early', done: tick('6').done, detail: 'With the home loan feature, later.' },
    { n: 7, title: 'Building wealth and giving', done: tick('7').done, detail: null },
  ]
  const current = steps.find((s) => !s.done)?.n
  return (
    <Card title="Milestones">
      <ol className="milestones">
        {steps.map((s) => (
          <li key={s.n} className={s.done ? 'done' : s.n === current ? 'current' : ''}>
            <div className="milestone-head">
              {s.done ? <CheckCircle2 size={18} aria-label="Done" /> : s.n === current ? <CircleDot size={18} aria-label="Working on it" /> : <Circle size={18} aria-label="Later" />}
              <strong>
                {s.n}. {s.title}
              </strong>
              {s.n >= 4 && (
                <label className="check small">
                  <input type="checkbox" checked={tick(String(s.n)).done} onChange={(e) => setTick(String(s.n), { done: e.target.checked })} />
                  <span>In place</span>
                </label>
              )}
            </div>
            {s.detail && <div className="small muted">{s.detail}</div>}
          </li>
        ))}
      </ol>
    </Card>
  )
}

function DebtDialog({ ctx, debt, today, onClose }: { ctx: HubContext; debt?: Debt; today: string; onClose: (changed?: boolean) => void }) {
  const { api } = ctx.platform
  const [f, setF] = useState(() => ({ name: debt?.name ?? '', kind: debt?.kind ?? 'credit-card', balanceOn: debt?.balanceOn ?? today, rate: String(debt?.rate ?? ''), notes: debt?.notes ?? '', paidOff: debt?.paidOff ?? '' }))
  const [balance, setBalance] = useState(debt ? amountText(debt.balance) : '')
  const [minimum, setMinimum] = useState(debt ? amountText(debt.minimum) : '')
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    const b = parseRand(balance)
    const min = parseRand(minimum)
    const rate = Number(f.rate.replace(',', '.') || 0)
    if (b === null || min === null || !Number.isFinite(rate)) throw new Error('Enter the balance, the minimum payment and the interest rate.')
    const item = { ...f, kind: f.kind, balance: b, minimum: min, rate, paidOff: f.paidOff || null, history: debt?.history ?? [{ date: f.balanceOn, balance: b }] }
    if (debt) await api.request('PUT', `/api/budget/debts/${debt.id}`, { baseVersion: debt.version, item }).catch(conflict)
    else await api.post('/api/budget/debts', { item })
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!debt || !window.confirm(`Delete “${debt.name}”?`)) return
    await api.del(`/api/budget/debts/${debt.id}`)
    onClose(true)
  })
  return (
    <Dialog open title={debt ? `Edit ${debt.name}` : 'Add a debt'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="debt-name" label="Name">
          <input id="debt-name" className="qi-search" maxLength={80} required placeholder="e.g. Woolworths card" value={f.name} onChange={(e) => set('name', e.target.value)} />
        </Labelled>
        <Labelled id="debt-kind" label="Kind">
          <select id="debt-kind" className="select" value={f.kind} onChange={(e) => set('kind', e.target.value)}>
            {DEBT_KINDS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Labelled>
        <div className="row">
          <Labelled id="debt-balance" label="Balance (R)">
            <input id="debt-balance" className="qi-search" inputMode="decimal" required value={balance} onChange={(e) => setBalance(e.target.value)} />
          </Labelled>
          <Labelled id="debt-on" label="On">
            <input id="debt-on" className="qi-search" type="date" required value={f.balanceOn} onChange={(e) => set('balanceOn', e.target.value)} />
          </Labelled>
        </div>
        <div className="row">
          <Labelled id="debt-min" label="Minimum payment (R)">
            <input id="debt-min" className="qi-search" inputMode="decimal" required value={minimum} onChange={(e) => setMinimum(e.target.value)} />
          </Labelled>
          <Labelled id="debt-rate" label="Interest (% a year)">
            <input id="debt-rate" className="qi-search year-input" inputMode="decimal" value={f.rate} onChange={(e) => set('rate', e.target.value)} />
          </Labelled>
        </div>
        {debt && (
          <Labelled id="debt-paid" label="Paid off on">
            <input id="debt-paid" className="qi-search" type="date" value={f.paidOff} onChange={(e) => set('paidOff', e.target.value)} />
          </Labelled>
        )}
        <Labelled id="debt-notes" label="Notes">
          <textarea id="debt-notes" className="textarea" rows={2} maxLength={2000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={debt ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

function BalanceDialog({ ctx, debt, today, onClose }: { ctx: HubContext; debt: Debt; today: string; onClose: (changed?: boolean) => void }) {
  const [day, setDay] = useState(today)
  const [text, setText] = useState('')
  const save = useAction(async () => {
    const b = parseRand(text)
    if (b === null) throw new Error('Enter the balance from the latest statement.')
    const { id, version, ...rest } = debt
    const item = { ...rest, balance: b, balanceOn: day, history: [...debt.history.filter((h) => h.date !== day), { date: day, balance: b }], paidOff: b === 0 ? day : debt.paidOff }
    await ctx.platform.api.request('PUT', `/api/budget/debts/${id}`, { baseVersion: version, item }).catch(conflict)
    onClose(true)
  })
  return (
    <Dialog open title={`New balance · ${debt.name}`} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <p className="muted small">From the latest statement. Enter 0 when it is paid off.</p>
        <div className="row">
          <Labelled id="bal-amount" label="Balance (R)">
            <input id="bal-amount" className="qi-search" inputMode="decimal" required value={text} onChange={(e) => setText(e.target.value)} />
          </Labelled>
          <Labelled id="bal-date" label="On">
            <input id="bal-date" className="qi-search" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
          </Labelled>
        </div>
        {debt.history.length > 1 && (
          <p className="muted small">
            Before: {debt.history
              .slice(-4)
              .map((h) => `${rand(h.balance)} (${shortDate(h.date, today)})`)
              .join(', ')}
          </p>
        )}
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} />
      </form>
    </Dialog>
  )
}
