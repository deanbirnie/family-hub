/**
 * Wishlists (phase 8a): everyone's list, kept by themselves (the parents keep
 * the lists of children without an account). Others mark "I'm getting this",
 * alone or sharing the cost, and the list's owner never sees any of it: the
 * server leaves claims out of everything it sends them. A sizes card per
 * person sits alongside.
 */
import { CheckCircle2, Copy, ExternalLink, Gift, Link2, Pencil, Plus, Ruler, Undo2, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Actions, conflict, Labelled } from '../money/form.tsx'
import { parseRand, rand } from '../money/model.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, PageHeader, Spinner, errorText, useAction } from '../ui.tsx'

type Want = 'really' | 'would like' | 'nice to have'
const WANTS: [Want, string][] = [
  ['really', 'Really want'],
  ['would like', 'Would like'],
  ['nice to have', 'Nice to have'],
]
const SIZES: [keyof Omit<Sizes, 'profileId' | 'version'>, string][] = [
  ['tops', 'Tops'],
  ['bottoms', 'Bottoms'],
  ['dress', 'Dress'],
  ['shoes', 'Shoes'],
  ['ring', 'Ring'],
  ['hat', 'Hat'],
]

interface Profile {
  id: string
  displayName: string
  userId: string | null
  mine: boolean
  mayEdit: boolean
  /** Parents can share the children's lists by link. */
  mayShare: boolean
}
interface Claim {
  id: string
  name: string
  amount: number | null
  note: string
  mine: boolean
  /** Marked by a visitor through the share link. */
  byLink: boolean
}
interface Item {
  id: string
  profileId: string
  version: number
  what: string
  link: string
  price: number | null
  want: Want
  details: string
  notes: string
  done: boolean
  /** Absent on your own list: you never learn what others are getting you. */
  claims?: Claim[]
}
interface Sizes {
  profileId: string
  version: number
  tops: string
  bottoms: string
  dress: string
  shoes: string
  ring: string
  hat: string
  notes: string
}
interface Data {
  profiles: Profile[]
  items: Item[]
  sizes: Sizes[]
  links: { id: string; profileId: string; createdAt: number }[]
}

type Editing = { what: 'item'; profile: Profile; item?: Item } | { what: 'claim'; item: Item; share: boolean } | { what: 'sizes'; profile: Profile; sizes?: Sizes } | { what: 'link'; profile: Profile; url: string }

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'link'
  }
}

export function WishlistsPage({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState('')
  const [personId, setPersonId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [showDone, setShowDone] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.get<Data>('/api/wishlists'))
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])
  const done = (changed?: boolean) => {
    setEditing(null)
    if (changed) void load()
  }
  const unclaim = useAction(async (claim: Claim) => {
    await api.del(`/api/wishlists/claims/${claim.id}`)
    await load()
  })

  if (error) return <Banner kind="error">{error}</Banner>
  if (!data) return <Spinner />
  // My list first, then the lists I keep, then everyone else.
  const order = (p: Profile) => (p.mine ? 0 : p.mayEdit ? 1 : 2)
  const people = [...data.profiles].sort((a, b) => order(a) - order(b))
  const person = people.find((p) => p.id === personId) ?? people[0]
  if (!person) return <Spinner />
  const items = data.items.filter((i) => i.profileId === person.id)
  const open = items.filter((i) => !i.done)
  const finished = items.filter((i) => i.done)
  const sizes = data.sizes.find((s) => s.profileId === person.id)
  const mayEditSizes = person.mayEdit || ctx.user.role === 'admin'

  return (
    <div className="page">
      <PageHeader title="Wishlists" subtitle="Everyone’s wishlist and sizes. Mark what you are getting: the person whose list it is never sees it." />
      <div className="row chips" role="group" aria-label="Whose list">
        {people.map((p) => (
          <button key={p.id} className={`chip ${p.id === person.id ? 'chip-on' : ''}`} aria-pressed={p.id === person.id} onClick={() => setPersonId(p.id)}>
            {p.mine ? 'My list' : p.displayName}
          </button>
        ))}
      </div>

      <Card
        title={
          <>
            <Gift size={18} aria-hidden /> {person.mine ? 'My wishlist' : `${person.displayName}’s wishlist`}
          </>
        }
        actions={
          person.mayEdit && (
            <Button variant="ghost" icon={<Plus size={16} aria-hidden />} onClick={() => setEditing({ what: 'item', profile: person })}>
              Add a wish
            </Button>
          )
        }
      >
        {person.mine && <p className="muted small">When someone marks something as theirs to get, you are not told, so it stays a surprise. Tick off what you have received or no longer want.</p>}
        {!person.mine && person.mayEdit && <p className="muted small">You keep this list for {person.displayName}. You can see what others are getting, so nothing is bought twice.</p>}
        {open.length === 0 && <p className="muted small">{person.mayEdit ? 'Nothing on the list yet. Add what you would love, with a link if it is from a shop.' : `Nothing on ${person.displayName}’s list yet.`}</p>}
        <ul className="item-list">
          {open.map((i) => (
            <WishRow
              key={i.id}
              item={i}
              person={person}
              onEdit={() => setEditing({ what: 'item', profile: person, item: i })}
              onClaim={(share) => setEditing({ what: 'claim', item: i, share })}
              onUnclaim={(c) => void unclaim.run(c)}
            />
          ))}
        </ul>
        {unclaim.error && <Banner kind="error">{unclaim.error}</Banner>}
        {finished.length > 0 && (
          <>
            <Button variant="ghost" onClick={() => setShowDone((v) => !v)}>
              {showDone ? 'Hide' : 'Show'} received or no longer wanted ({finished.length})
            </Button>
            {showDone && (
              <ul className="item-list">
                {finished.map((i) => (
                  <WishRow key={i.id} item={i} person={person} onEdit={() => setEditing({ what: 'item', profile: person, item: i })} />
                ))}
              </ul>
            )}
          </>
        )}
      </Card>

      {person.mayShare && <ShareCard ctx={ctx} person={person} link={data.links.find((l) => l.profileId === person.id)} onMade={(url) => setEditing({ what: 'link', profile: person, url })} onChanged={() => void load()} />}

      <Card
        title={
          <>
            <Ruler size={18} aria-hidden /> Sizes
          </>
        }
        actions={
          mayEditSizes && (
            <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} onClick={() => setEditing({ what: 'sizes', profile: person, sizes })}>
              {sizes ? 'Update' : 'Add sizes'}
            </Button>
          )
        }
      >
        {!sizes || SIZES.every(([k]) => !sizes[k]) ? (
          <p className="muted small">{mayEditSizes ? 'Clothes, shoes and ring sizes, so a gift fits.' : `${person.displayName} has not added sizes yet.`}</p>
        ) : (
          <dl className="sizes">
            {SIZES.filter(([k]) => sizes[k]).map(([k, label]) => (
              <div key={k}>
                <dt>{label}</dt>
                <dd>{sizes[k]}</dd>
              </div>
            ))}
          </dl>
        )}
        {sizes?.notes && <p className="small">{sizes.notes}</p>}
      </Card>

      {editing?.what === 'item' && <ItemDialog ctx={ctx} profile={editing.profile} item={editing.item} onClose={done} />}
      {editing?.what === 'claim' && <ClaimDialog ctx={ctx} item={editing.item} share={editing.share} owner={person.displayName} onClose={done} />}
      {editing?.what === 'sizes' && <SizesDialog ctx={ctx} profile={editing.profile} sizes={editing.sizes} onClose={done} />}
      {editing?.what === 'link' && <LinkDialog name={editing.profile.displayName} url={editing.url} onClose={() => done(true)} />}
    </div>
  )
}

/** A visitor's name, marked as coming through the share link. */
const who = (c: Claim) => (c.byLink ? `${c.name} (via the link)` : c.name)

/** Where share links point: this site in a browser, the server the app talks to on Android. */
const shareUrl = (ctx: HubContext, secret: string) => {
  const base = ctx.platform.kind === 'web' ? window.location.origin : (ctx.platform.serverUrl ?? '')
  return `${base.replace(/\/+$/, '')}/wishlist/${secret}`
}

function ShareCard({ ctx, person, link, onMade, onChanged }: { ctx: HubContext; person: Profile; link?: Data['links'][number]; onMade: (url: string) => void; onChanged: () => void }) {
  const { api } = ctx.platform
  const make = useAction(async () => {
    if (link && !confirm(`Make a new link for ${person.displayName}’s list? The link you shared before stops working.`)) return
    const r = await api.post<{ secret: string }>(`/api/wishlists/${person.id}/link`, {})
    onMade(shareUrl(ctx, r.secret))
  })
  const off = useAction(async () => {
    if (!confirm(`Turn off the link to ${person.displayName}’s list? Anyone who has it will no longer be able to open it.`)) return
    await api.del(`/api/wishlists/${person.id}/link`)
    onChanged()
  })
  return (
    <Card
      title={
        <>
          <Link2 size={18} aria-hidden /> Share {person.displayName}’s list
        </>
      }
      actions={
        <>
          <Button variant="ghost" icon={<Link2 size={16} aria-hidden />} busy={make.busy} onClick={() => void make.run()}>
            {link ? 'Make a new link' : 'Make a link'}
          </Button>
          {link && (
            <Button variant="ghost" busy={off.busy} onClick={() => void off.run()}>
              Turn off
            </Button>
          )}
        </>
      }
    >
      <p className="muted small">
        {link
          ? `A link is on, made ${new Date(link.createdAt).toLocaleDateString()}. The hub keeps only a fingerprint of it, so it cannot show it again: make a new one if you need it (the old one then stops working).`
          : `For grandparents and friends without an account: they see what ${person.displayName} would like and mark what they are getting, with their name, which only the family sees.`}
      </p>
      {(make.error || off.error) && <Banner kind="error">{make.error || off.error}</Banner>}
    </Card>
  )
}

function LinkDialog({ name, url, onClose }: { name: string; url: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = () =>
    void navigator.clipboard
      ?.writeText(url)
      .then(() => setCopied(true))
      .catch(() => undefined)
  return (
    <Dialog open title={`Link to ${name}’s wishlist`} onClose={onClose}>
      <div className="stack">
        <p className="small">Send this to grandparents and friends. Copy it now: it is shown only this once.</p>
        <input className="qi-search" readOnly aria-label="The link" value={url} onFocus={(e) => e.target.select()} />
        <div className="row">
          <Button icon={<Copy size={16} aria-hidden />} onClick={copy}>
            {copied ? 'Copied' : 'Copy the link'}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

function WishRow({ item: i, person, onEdit, onClaim, onUnclaim }: { item: Item; person: Profile; onEdit: () => void; onClaim?: (share: boolean) => void; onUnclaim?: (c: Claim) => void }) {
  const claims = i.claims ?? []
  const mine = claims.find((c) => c.mine)
  const others = claims.filter((c) => !c.mine)
  const shared = claims.some((c) => c.amount !== null)
  const pledged = claims.reduce((sum, c) => sum + (c.amount ?? 0), 0)
  const whole = claims.some((c) => c.amount === null)
  return (
    <li className={i.done ? 'muted' : ''}>
      <div className="item-main">
        <div>
          <strong>{i.what}</strong> {i.want === 'really' && <Badge tone="accent">Really wants</Badge>}
          {i.want === 'nice to have' && <Badge>Nice to have</Badge>}
          {i.done && <Badge>Done</Badge>}
        </div>
        <div className="muted small">
          {[i.details, i.price !== null ? `about ${rand(i.price)}` : '', i.notes].filter(Boolean).join(' · ')}
          {i.link && (
            <>
              {(i.details || i.price !== null || i.notes) && ' · '}
              <a href={i.link} target="_blank" rel="noopener noreferrer">
                {host(i.link)} <ExternalLink size={12} aria-hidden />
              </a>
            </>
          )}
        </div>
        {!person.mine && claims.length > 0 && (
          <div className="small">
            <CheckCircle2 size={14} aria-hidden />{' '}
            {mine && !others.length && (mine.amount === null ? 'You’re getting this.' : `You’re putting in ${rand(mine.amount)}.`)}
            {mine && others.length > 0 && `You${mine.amount !== null ? ` (${rand(mine.amount)})` : ''} and ${others.map((c) => who(c) + (c.amount !== null ? ` (${rand(c.amount)})` : '')).join(', ')}.`}
            {!mine && (whole && !shared ? `${others.map(who).join(', ')} ${others.length > 1 ? 'are' : 'is'} getting this.` : `Shared by ${others.map(who).join(', ')}`)}
            {shared && pledged > 0 && ` ${rand(pledged)} so far${i.price !== null ? ` of about ${rand(i.price)}` : ''}.`}
          </div>
        )}
      </div>
      {!person.mine && !i.done && onClaim && (
        <div className="row">
          {mine ? (
            <Button variant="ghost" icon={<Undo2 size={16} aria-hidden />} onClick={() => onUnclaim?.(mine)}>
              Not getting it
            </Button>
          ) : (
            <>
              {!whole && (
                <Button variant="ghost" icon={<Gift size={16} aria-hidden />} onClick={() => onClaim(false)}>
                  I’m getting this
                </Button>
              )}
              {(!whole || shared) && (
                <Button variant="ghost" icon={<Users size={16} aria-hidden />} onClick={() => onClaim(true)}>
                  Share this gift
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {person.mayEdit && <Button variant="ghost" icon={<Pencil size={16} aria-hidden />} aria-label={`Edit ${i.what}`} onClick={onEdit} />}
    </li>
  )
}

function ItemDialog({ ctx, profile, item, onClose }: { ctx: HubContext; profile: Profile; item?: Item; onClose: (c?: boolean) => void }) {
  const { api } = ctx.platform
  const [f, setF] = useState(() => ({ what: item?.what ?? '', link: item?.link ?? '', price: item?.price != null ? String(item.price / 100) : '', want: item?.want ?? ('would like' as Want), details: item?.details ?? '', notes: item?.notes ?? '' }))
  const [received, setReceived] = useState(item?.done ?? false)
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }))
  const save = useAction(async () => {
    const price = f.price.trim() ? parseRand(f.price) : null
    if (f.price.trim() && price === null) throw new Error('The price is not an amount.')
    const body = { what: f.what, link: f.link.trim(), price, want: f.want, details: f.details, notes: f.notes, done: received }
    if (item) await api.request('PUT', `/api/wishlists/items/${item.id}`, { baseVersion: item.version, item: body }).catch(conflict)
    else await api.post(`/api/wishlists/${profile.id}/items`, { item: body })
    onClose(true)
  })
  const remove = useAction(async () => {
    if (!item || !confirm(`Remove “${item.what}” from the list?`)) return
    await api.del(`/api/wishlists/items/${item.id}`)
    onClose(true)
  })
  return (
    <Dialog open title={item ? 'Edit the wish' : profile.mine ? 'Add to my wishlist' : `Add to ${profile.displayName}’s wishlist`} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <Labelled id="wish-what" label="What">
          <input id="wish-what" className="qi-search" maxLength={200} required placeholder="e.g. Lego Technic tractor" value={f.what} onChange={(e) => set('what', e.target.value)} />
        </Labelled>
        <Labelled id="wish-link" label="Link to it (optional)">
          <input id="wish-link" className="qi-search" type="url" maxLength={1000} placeholder="https://" value={f.link} onChange={(e) => set('link', e.target.value)} />
        </Labelled>
        <div className="row">
          <Labelled id="wish-price" label="About how much (optional)">
            <input id="wish-price" className="qi-search" inputMode="decimal" placeholder="R" value={f.price} onChange={(e) => set('price', e.target.value)} />
          </Labelled>
          <Labelled id="wish-want" label="How much">
            <select id="wish-want" className="select" value={f.want} onChange={(e) => set('want', e.target.value)}>
              {WANTS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </Labelled>
        </div>
        <Labelled id="wish-details" label="Size, colour or model (optional)">
          <input id="wish-details" className="qi-search" maxLength={200} value={f.details} onChange={(e) => set('details', e.target.value)} />
        </Labelled>
        <Labelled id="wish-notes" label="Notes">
          <input id="wish-notes" className="qi-search" maxLength={1000} value={f.notes} onChange={(e) => set('notes', e.target.value)} />
        </Labelled>
        {item && (
          <label className="check">
            <input type="checkbox" checked={received} onChange={(e) => setReceived(e.target.checked)} />
            <span>Received, or no longer wanted</span>
          </label>
        )}
        {(save.error || remove.error) && <Banner kind="error">{save.error || remove.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} onDelete={item ? () => void remove.run() : undefined} deleting={remove.busy} />
      </form>
    </Dialog>
  )
}

function ClaimDialog({ ctx, item, share, owner, onClose }: { ctx: HubContext; item: Item; share: boolean; owner: string; onClose: (c?: boolean) => void }) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const save = useAction(async () => {
    const cents = share ? parseRand(amount) : null
    if (share && (cents === null || cents <= 0)) throw new Error('Say how much you are putting in.')
    await ctx.platform.api.post(`/api/wishlists/items/${item.id}/claims`, { claim: { amount: cents, note } })
    onClose(true)
  })
  return (
    <Dialog open title={share ? `Share: ${item.what}` : `Getting: ${item.what}`} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <p className="muted small">The rest of the family sees your name on it, so nobody buys it twice. {owner} never sees it.</p>
        {share && (
          <Labelled id="claim-amount" label="What you are putting in" hint={item.price !== null ? `It costs about ${rand(item.price)}.` : undefined}>
            <input id="claim-amount" className="qi-search" inputMode="decimal" required placeholder="R" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </Labelled>
        )}
        <Labelled id="claim-note" label="A note for the others (optional)">
          <input id="claim-note" className="qi-search" maxLength={200} placeholder="e.g. Ordered, arriving Friday" value={note} onChange={(e) => setNote(e.target.value)} />
        </Labelled>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} submit={share ? 'Put in my share' : 'I’m getting this'} />
      </form>
    </Dialog>
  )
}

function SizesDialog({ ctx, profile, sizes, onClose }: { ctx: HubContext; profile: Profile; sizes?: Sizes; onClose: (c?: boolean) => void }) {
  const [f, setF] = useState(() => ({ tops: sizes?.tops ?? '', bottoms: sizes?.bottoms ?? '', dress: sizes?.dress ?? '', shoes: sizes?.shoes ?? '', ring: sizes?.ring ?? '', hat: sizes?.hat ?? '', notes: sizes?.notes ?? '' }))
  const save = useAction(async () => {
    await ctx.platform.api.request('PUT', `/api/wishlists/${profile.id}/sizes`, { sizes: f })
    onClose(true)
  })
  return (
    <Dialog open title={`Sizes · ${profile.mine ? 'mine' : profile.displayName}`} onClose={() => onClose()}>
      <form className="stack" onSubmit={(e) => (e.preventDefault(), void save.run())}>
        <div className="sizes-grid">
          {SIZES.map(([k, label]) => (
            <Labelled key={k} id={`size-${k}`} label={label}>
              <input id={`size-${k}`} className="qi-search" maxLength={40} value={f[k]} onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))} />
            </Labelled>
          ))}
        </div>
        <Labelled id="size-notes" label="Notes" hint="e.g. Prefers loose fits; growing fast, buy a size up.">
          <input id="size-notes" className="qi-search" maxLength={500} value={f.notes} onChange={(e) => setF((x) => ({ ...x, notes: e.target.value }))} />
        </Labelled>
        {save.error && <Banner kind="error">{save.error}</Banner>}
        <Actions busy={save.busy} onCancel={() => onClose()} />
      </form>
    </Dialog>
  )
}
