/**
 * The gift planner (phase 8c), for parents: the occasions coming up for the
 * people who matter (anyone in Contacts with a gift idea) and Christmas, each
 * with its gifts on their way from idea to bought, wrapped and given, what
 * they cost, and a planned expense in the budget so the month is ready for
 * it. The gifts are the Contacts gift ideas; any contact can start mattering
 * by getting one.
 */
import { CalendarClock, CheckCircle2, Gift as GiftIcon, Package, Pencil, Plus, ShoppingBag, Wallet } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { PlannedDialog } from '../money/Budget.tsx'
import { monthName, type Category, type Planned } from '../money/budget-model.ts'
import { Actions, Labelled } from '../money/form.tsx'
import { amountText, parseRand, rand, relative, shortDate } from '../money/model.ts'
import { navigate } from '../router.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, PageHeader, Spinner, errorText, useAction } from '../ui.tsx'

type Status = 'idea' | 'bought' | 'wrapped' | 'given'
interface Gift {
  id: string
  contactId: string
  idea: string
  occasion: string
  status: Status
  date: string | null
  link: string
  note: string
  amount: number | null
  forDate: string | null
  plannedId: string | null
}
interface Occasion {
  key: string
  contactId: string | null
  title: string
  kind: 'birthday' | 'anniversary' | 'other' | 'christmas'
  date: string
}
interface PlannerData {
  today: string
  occasions: Occasion[]
  contacts: { id: string; name: string }[]
  gifts: Gift[]
}
interface Extras {
  people: { id: string; name: string }[]
  planned: Planned[]
  categories: Category[]
}
/** An occasion with its gifts: a real one, or a day a gift was set for that is no occasion we know of. */
interface Group {
  key: string
  title: string
  date: string | null
  occasion: Occasion | null
  gifts: Gift[]
}

const NEXT: Record<Status, { to: Status; label: string; icon: typeof ShoppingBag } | null> = {
  idea: { to: 'bought', label: 'Bought', icon: ShoppingBag },
  bought: { to: 'wrapped', label: 'Wrapped', icon: Package },
  wrapped: { to: 'given', label: 'Given', icon: CheckCircle2 },
  given: null,
}
const STATUS_WORD: Record<Status, string> = { idea: 'Idea', bought: 'Bought', wrapped: 'Wrapped', given: 'Given' }
/** How far ahead an occasion shows without any gifts yet (Christmas always shows). */
const QUIET_DAYS = 60

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
const sum = (gifts: Gift[]) => gifts.reduce((n, g) => n + (g.amount ?? 0), 0)
/** The body a gift is saved with (the server keeps exactly what it is sent). */
const body = (g: Omit<Gift, 'id' | 'contactId'>) => ({ idea: g.idea, occasion: g.occasion, status: g.status, date: g.date, link: g.link, note: g.note, amount: g.amount, forDate: g.forDate, plannedId: g.plannedId })

export function GiftPlanner({ ctx }: { ctx: HubContext }) {
  if (ctx.user.role !== 'admin') {
    return (
      <div className="page">
        <PageHeader title="Gift planner" />
        <Card>
          <p>The gift planner is kept by the parents.</p>
        </Card>
      </div>
    )
  }
  return <Planner ctx={ctx} />
}

function Planner({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const [data, setData] = useState<PlannerData | null>(null)
  const [extras, setExtras] = useState<Extras | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ gift?: Gift; occasion?: Occasion | null; contactId?: string } | null>(null)
  const [budgeting, setBudgeting] = useState<Group | null>(null)

  const load = useCallback(async () => {
    try {
      const [planner, book, budget] = await Promise.all([
        api.get<PlannerData>('/api/gifts/planner'),
        api.get<{ contacts: { id: string; name: string; deceased?: boolean }[] }>('/api/contacts'),
        api.get<{ planned: Planned[]; categories: Category[] }>('/api/budget'),
      ])
      setData(planner)
      setExtras({ people: book.contacts.filter((c) => !c.deceased).map((c) => ({ id: c.id, name: c.name })), planned: budget.planned, categories: budget.categories })
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])

  const advance = useAction(async (g: Gift) => {
    const next = NEXT[g.status]
    if (!next || !data) return
    await api.request('PUT', `/api/contacts/gifts/${g.id}`, body({ ...g, status: next.to, date: next.to === 'given' ? data.today : null }))
    await load()
  })

  if (error) return <Banner kind="error">{error}</Banner>
  if (!data || !extras) return <Spinner />
  const t = data.today
  const nameOf = (id: string) => extras.people.find((p) => p.id === id)?.name ?? data.contacts.find((c) => c.id === id)?.name ?? 'Someone'

  // Each gift goes with the occasion it is for: the person's own day, or Christmas.
  const groups = new Map<string, Group>()
  for (const o of data.occasions) groups.set(o.key, { key: o.key, title: o.title, date: o.date, occasion: o, gifts: [] })
  const matter = new Set(data.contacts.map((c) => c.id))
  const loose: Gift[] = []
  for (const g of data.gifts) {
    const o = g.forDate ? data.occasions.find((x) => x.date === g.forDate && (x.contactId === g.contactId || x.contactId === null)) : undefined
    if (o) groups.get(o.key)!.gifts.push(g)
    else if (g.forDate) {
      const key = `day:${g.forDate}:${g.occasion}`
      const group = groups.get(key) ?? { key, title: g.occasion || 'Another day', date: g.forDate, occasion: null, gifts: [] }
      group.gifts.push(g)
      groups.set(key, group)
    } else if (g.status !== 'given') loose.push(g)
  }
  const shown = [...groups.values()]
    // Only the people who matter (with gift ideas); their days show a while ahead even before there is a gift.
    .filter((x) => x.gifts.length > 0 || x.occasion?.kind === 'christmas' || (x.occasion !== null && x.occasion.contactId !== null && matter.has(x.occasion.contactId) && x.date !== null && daysBetween(t, x.date) <= QUIET_DAYS))
    .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''))
  const open = data.gifts.filter((g) => g.status !== 'given')
  const toBuy = open.filter((g) => g.status === 'idea' && g.forDate && daysBetween(t, g.forDate) <= 30)

  return (
    <div className="page">
      <PageHeader
        title="Gift planner"
        subtitle="The occasions coming up for the people who matter, and Christmas: each gift from idea to bought, wrapped and given, and in the budget."
        actions={
          <>
            <Button variant="ghost" onClick={() => navigate('/wishlists')}>
              Wishlists
            </Button>
            <Button icon={<Plus size={16} aria-hidden />} onClick={() => setEditing({})}>
              Add a gift idea
            </Button>
          </>
        }
      />
      {open.length > 0 && (
        <p className="muted small">
          {open.length} gift{open.length === 1 ? '' : 's'} on the go{sum(open) > 0 && `, ${rand(sum(open))} in all`}
          {toBuy.length > 0 && ` · ${toBuy.length} still to buy for the next month`}.
        </p>
      )}
      {data.contacts.length === 0 && (
        <Banner>Add a gift idea for someone in Contacts and their birthday shows here. Only the people you add ideas for are in the planner; anyone can be added later.</Banner>
      )}
      {shown.map((group) => (
        <OccasionCard
          key={group.key}
          group={group}
          today={t}
          nameOf={nameOf}
          planned={extras.planned}
          advancing={advance.busy}
          onAdvance={(g) => void advance.run(g)}
          onEdit={(g) => setEditing({ gift: g })}
          onAdd={() => setEditing({ occasion: group.occasion, contactId: group.occasion?.contactId ?? undefined })}
          onBudget={() => setBudgeting(group)}
        />
      ))}
      {advance.error && <Banner kind="error">{advance.error}</Banner>}
      {loose.length > 0 && (
        <Card
          title={
            <>
              <GiftIcon size={18} aria-hidden /> Ideas, not for a day yet
            </>
          }
        >
          <ul className="item-list">
            {loose.map((g) => (
              <GiftRow key={g.id} gift={g} who={nameOf(g.contactId)} planned={extras.planned} busy={advance.busy} onAdvance={() => void advance.run(g)} onEdit={() => setEditing({ gift: g })} />
            ))}
          </ul>
        </Card>
      )}

      {editing && <GiftDialog ctx={ctx} data={data} people={extras.people} {...editing} onClose={(c) => (setEditing(null), c && void load())} />}
      {budgeting && (
        <PlannedDialog
          ctx={ctx}
          view={{ today: t, categories: extras.categories }}
          people={[]}
          preset={{
            name: `Gifts: ${budgeting.title}`,
            amount: sum(budgeting.gifts.filter((g) => !g.plannedId && g.status !== 'given')),
            month: (budgeting.date ?? t).slice(0, 7),
            categoryId: extras.categories.some((c) => c.id === 'gifts') ? 'gifts' : null,
            tag: 'gifts',
          }}
          onClose={(changed, saved) => {
            const group = budgeting
            setBudgeting(null)
            if (!changed) return
            void (async () => {
              // Link the gifts not yet in the budget to the new planned expense.
              if (saved) for (const g of group.gifts.filter((x) => !x.plannedId && x.status !== 'given')) await api.request('PUT', `/api/contacts/gifts/${g.id}`, body({ ...g, plannedId: saved.id }))
              await load()
            })().catch((e: unknown) => setError(errorText(e)))
          }}
        />
      )}
    </div>
  )
}

function OccasionCard({
  group,
  today,
  nameOf,
  planned,
  advancing,
  onAdvance,
  onEdit,
  onAdd,
  onBudget,
}: {
  group: Group
  today: string
  nameOf: (id: string) => string
  planned: Planned[]
  advancing: boolean
  onAdvance: (g: Gift) => void
  onEdit: (g: Gift) => void
  onAdd: () => void
  onBudget: () => void
}) {
  const open = group.gifts.filter((g) => g.status !== 'given')
  const unbudgeted = open.filter((g) => !g.plannedId || !planned.some((p) => p.id === g.plannedId))
  const budgets = [...new Set(open.map((g) => g.plannedId).filter((id): id is string => !!id))].map((id) => planned.find((p) => p.id === id)).filter((p): p is Planned => !!p)
  const days = group.date ? daysBetween(today, group.date) : null
  return (
    <Card
      title={
        <>
          <CalendarClock size={18} aria-hidden /> {group.title}
          {group.date && (
            <span className="muted small">
              {' '}
              · {shortDate(group.date, today)} ({relative(today, group.date)})
            </span>
          )}
          {days !== null && days < 0 && open.length > 0 && <Badge tone="warning">Past</Badge>}
        </>
      }
      actions={
        <>
          {unbudgeted.length > 0 && sum(unbudgeted) > 0 && (
            <Button variant="ghost" icon={<Wallet size={16} aria-hidden />} onClick={onBudget}>
              Plan in the budget
            </Button>
          )}
          <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={onAdd}>
            Add an idea
          </Button>
        </>
      }
    >
      {group.gifts.length === 0 && <p className="muted small">No gift yet.</p>}
      <ul className="item-list">
        {group.gifts.map((g) => (
          <GiftRow key={g.id} gift={g} who={group.occasion?.contactId ? null : nameOf(g.contactId)} planned={planned} busy={advancing} onAdvance={() => onAdvance(g)} onEdit={() => onEdit(g)} />
        ))}
      </ul>
      {(sum(group.gifts) > 0 || budgets.length > 0) && (
        <p className="small">
          {sum(group.gifts) > 0 && `${rand(sum(group.gifts))} in all`}
          {budgets.map((p) => ` · in the budget: ${p.name}, ${rand(p.amount)} in ${monthName(p.month)}`).join('')}
        </p>
      )}
    </Card>
  )
}

function GiftRow({ gift: g, who, planned, busy, onAdvance, onEdit }: { gift: Gift; who: string | null; planned: Planned[]; busy: boolean; onAdvance: () => void; onEdit: () => void }) {
  const next = NEXT[g.status]
  const inBudget = g.plannedId && planned.some((p) => p.id === g.plannedId)
  return (
    <li className={g.status === 'given' ? 'muted' : ''}>
      <div className="item-main">
        <div>
          {who && <span>{who}: </span>}
          {g.link ? (
            <a href={g.link} target="_blank" rel="noopener noreferrer">
              <strong>{g.idea}</strong>
            </a>
          ) : (
            <strong>{g.idea}</strong>
          )}{' '}
          <Badge tone={g.status === 'idea' ? 'neutral' : g.status === 'given' ? 'success' : 'accent'}>{STATUS_WORD[g.status]}</Badge>
        </div>
        <div className="muted small">{[g.amount !== null ? rand(g.amount) : '', inBudget ? 'in the budget' : '', g.note].filter(Boolean).join(' · ')}</div>
      </div>
      {next && (
        <Button variant="ghost" icon={<next.icon size={16} aria-hidden />} busy={busy} aria-label={`${next.label}: ${g.idea}`} onClick={onAdvance}>
          {next.label}
        </Button>
      )}
      <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${g.idea}`} onClick={onEdit} />
    </li>
  )
}

function GiftDialog({
  ctx,
  data,
  people,
  gift,
  occasion,
  contactId,
  onClose,
}: {
  ctx: HubContext
  data: PlannerData
  people: { id: string; name: string }[]
  gift?: Gift
  occasion?: Occasion | null
  contactId?: string
  onClose: (changed?: boolean) => void
}) {
  const { api } = ctx.platform
  const [who, setWho] = useState(gift?.contactId ?? contactId ?? '')
  const [f, setF] = useState(() => ({ idea: gift?.idea ?? '', link: gift?.link ?? '', note: gift?.note ?? '', status: gift?.status ?? ('idea' as Status) }))
  const [amount, setAmount] = useState(gift?.amount != null ? amountText(gift.amount) : '')
  const startFor = gift ? (gift.forDate ? (data.occasions.find((o) => o.date === gift.forDate && (o.contactId === gift.contactId || o.contactId === null))?.key ?? 'day') : '') : (occasion?.key ?? '')
  const [forKey, setForKey] = useState(startFor)
  const [day, setDay] = useState(gift?.forDate ?? '')
  const [dayName, setDayName] = useState(gift && forKey === 'day' ? gift.occasion : '')
  // Their own days, and the family's (Christmas).
  const choices = data.occasions.filter((o) => o.contactId === null || o.contactId === who)
  const save = useAction(async () => {
    if (!who) throw new Error('Choose who it is for.')
    const cents = amount.trim() ? parseRand(amount) : null
    if (amount.trim() && cents === null) throw new Error('The amount is not an amount, for example 450.00.')
    const o = choices.find((x) => x.key === forKey)
    if (forKey === 'day' && !day) throw new Error('Choose the day it is for.')
    const forDate = o ? o.date : forKey === 'day' ? day : null
    const occasionText = o ? (o.kind === 'christmas' ? 'Christmas' : o.title) : forKey === 'day' ? dayName.trim() : (gift?.occasion ?? '')
    const g = { ...f, link: f.link.trim(), amount: cents, forDate, occasion: occasionText, date: f.status === 'given' ? (gift?.date ?? data.today) : null, plannedId: gift?.plannedId ?? null }
    if (gift) await api.request('PUT', `/api/contacts/gifts/${gift.id}`, body(g))
    else await api.post(`/api/contacts/${who}/gifts`, body(g))
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!gift || !window.confirm(`Delete “${gift.idea}”?`)) return
    await api.del(`/api/contacts/gifts/${gift.id}`)
    onClose(true)
  })
  return (
    <Dialog open title={gift ? 'Edit the gift' : 'Add a gift idea'} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        {!gift && (
          <Labelled id="gift-who" label="For" hint="Anyone in Contacts. Only the people with ideas are in the planner.">
            <select id="gift-who" className="select" required value={who} onChange={(e) => (setWho(e.target.value), occasion?.contactId && setForKey(''))}>
              <option value="">Choose someone…</option>
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Labelled>
        )}
        <Labelled id="gift-idea" label="The gift">
          <input id="gift-idea" className="qi-search" maxLength={200} required placeholder="e.g. Hiking boots, size 9" value={f.idea} onChange={(e) => setF({ ...f, idea: e.target.value })} />
        </Labelled>
        <div className="row">
          <Labelled id="gift-for" label="For which day">
            <select id="gift-for" className="select" value={forKey} onChange={(e) => setForKey(e.target.value)}>
              <option value="">Not decided</option>
              {choices.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.title} ({shortDate(o.date, data.today)})
                </option>
              ))}
              <option value="day">Another day…</option>
            </select>
          </Labelled>
          <Labelled id="gift-amount" label="About how much">
            <input id="gift-amount" className="qi-search" inputMode="decimal" placeholder="R" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Labelled>
        </div>
        {forKey === 'day' && (
          <div className="row">
            <Labelled id="gift-day" label="The day">
              <input id="gift-day" className="qi-search" type="date" required value={day} onChange={(e) => setDay(e.target.value)} />
            </Labelled>
            <Labelled id="gift-day-name" label="What it is">
              <input id="gift-day-name" className="qi-search" maxLength={60} placeholder="e.g. Housewarming" value={dayName} onChange={(e) => setDayName(e.target.value)} />
            </Labelled>
          </div>
        )}
        <Labelled id="gift-link" label="Link (optional)">
          <input id="gift-link" className="qi-search" type="url" maxLength={500} placeholder="https://" value={f.link} onChange={(e) => setF({ ...f, link: e.target.value })} />
        </Labelled>
        <div className="row">
          <Labelled id="gift-status" label="Where it is">
            <select id="gift-status" className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as Status })}>
              {(Object.keys(STATUS_WORD) as Status[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_WORD[s]}
                </option>
              ))}
            </select>
          </Labelled>
          <Labelled id="gift-note" label="Notes">
            <input id="gift-note" className="qi-search" maxLength={1000} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </Labelled>
        </div>
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={gift ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}
