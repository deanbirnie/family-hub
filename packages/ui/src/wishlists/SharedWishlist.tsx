/**
 * A child's wishlist opened from a share link (8b), for grandparents and
 * friends without an account. They see what is still wanted and whether it
 * is taken (never by whom), and mark what they are getting with their name,
 * which only the family sees. What they marked is remembered in this browser
 * so they can take it back.
 */
import { ExternalLink, Gift, Undo2, Users } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { Api as ApiClient } from '../api.ts'
import { AuthLayout } from '../auth/screens.tsx'
import { Labelled } from '../money/form.tsx'
import { parseRand, rand } from '../money/model.ts'
import { Badge, Banner, Button, Spinner, errorText, useAction } from '../ui.tsx'

interface SharedItem {
  id: string
  what: string
  link: string
  price: number | null
  want: 'really' | 'would like' | 'nice to have'
  details: string
  notes: string
  taken: boolean
  pledged: number
  sharers: number
  claimIds: string[]
}
interface Shared {
  name: string
  items: SharedItem[]
  sizes: Record<string, string> | null
}
interface Mine {
  claimId: string
  undo: string
}

const SIZE_LABELS: [string, string][] = [
  ['tops', 'Tops'],
  ['bottoms', 'Bottoms'],
  ['dress', 'Dress'],
  ['shoes', 'Shoes'],
  ['ring', 'Ring'],
  ['hat', 'Hat'],
]

const storeKey = (token: string) => `wishlist-claims:${token.slice(0, 12)}`
const remembered = (token: string): Mine[] => {
  try {
    const v = JSON.parse(localStorage.getItem(storeKey(token)) ?? '[]') as unknown
    return Array.isArray(v) ? (v as Mine[]) : []
  } catch {
    return []
  }
}
const remember = (token: string, mine: Mine[]) => {
  try {
    localStorage.setItem(storeKey(token), JSON.stringify(mine))
  } catch {
    // Private browsing: they can still mark things, just not take them back from here.
  }
}
const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return 'link'
  }
}

export function SharedWishlist({ api, token }: { api: ApiClient; token: string }) {
  const [data, setData] = useState<Shared | null>(null)
  const [error, setError] = useState('')
  const [mine, setMine] = useState<Mine[]>(() => remembered(token))
  const [claiming, setClaiming] = useState<{ item: SharedItem; share: boolean } | null>(null)
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem('wishlist-visitor-name') ?? ''
    } catch {
      return ''
    }
  })
  const base = `/api/shared/wishlist/${encodeURIComponent(token)}`

  const load = useCallback(async () => {
    try {
      setData(await api.get<Shared>(base))
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }, [api, base])
  useEffect(() => {
    void load()
  }, [load])

  const undo = useAction(async (m: Mine) => {
    await api.post(`${base}/claims/${m.claimId}/undo`, { undo: m.undo })
    const left = mine.filter((x) => x.claimId !== m.claimId)
    setMine(left)
    remember(token, left)
    await load()
  })

  if (error && !data) {
    return (
      <AuthLayout title="A family wishlist">
        <Banner kind="error">{error}</Banner>
      </AuthLayout>
    )
  }
  if (!data) {
    return (
      <main className="auth">
        <Spinner />
      </main>
    )
  }
  const sizes = SIZE_LABELS.filter(([k]) => data.sizes?.[k])
  return (
    <AuthLayout wide title={`${data.name}’s wishlist`} subtitle={`Mark what you are getting so nobody buys it twice. Only the family sees your name; ${data.name} does not.`}>
      {data.items.length === 0 && <p className="muted">Nothing on the list right now.</p>}
      <ul className="item-list">
        {data.items.map((i) => {
          const my = mine.find((m) => i.claimIds.includes(m.claimId))
          return (
            <li key={i.id}>
              <div className="item-main">
                <div>
                  <strong>{i.what}</strong> {i.want === 'really' && <Badge tone="accent">Really wants</Badge>}
                  {i.taken && !my && <Badge>Someone is getting this</Badge>}
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
                {i.sharers > 0 && (
                  <div className="small">
                    Shared gift: {rand(i.pledged)} so far{i.price !== null ? ` of about ${rand(i.price)}` : ''}, from {i.sharers} {i.sharers === 1 ? 'person' : 'people'}.
                  </div>
                )}
                {my && <div className="small">You marked this.</div>}
              </div>
              {my ? (
                <Button variant="ghost" icon={<Undo2 size={16} aria-hidden />} busy={undo.busy} onClick={() => void undo.run(my)}>
                  Take it back
                </Button>
              ) : (
                !i.taken && (
                  <div className="row">
                    {i.sharers === 0 && (
                      <Button variant="ghost" icon={<Gift size={16} aria-hidden />} onClick={() => setClaiming({ item: i, share: false })}>
                        I’m getting this
                      </Button>
                    )}
                    <Button variant="ghost" icon={<Users size={16} aria-hidden />} onClick={() => setClaiming({ item: i, share: true })}>
                      Put in towards it
                    </Button>
                  </div>
                )
              )}
            </li>
          )
        })}
      </ul>
      {undo.error && <Banner kind="error">{undo.error}</Banner>}
      {sizes.length > 0 && (
        <>
          <h2>Sizes</h2>
          <dl className="sizes">
            {sizes.map(([k, label]) => (
              <div key={k}>
                <dt>{label}</dt>
                <dd>{data.sizes![k]}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      {claiming && (
        <ClaimForm
          api={api}
          base={base}
          item={claiming.item}
          share={claiming.share}
          name={name}
          onCancel={() => setClaiming(null)}
          onDone={(m, used) => {
            const next = [...mine, m]
            setMine(next)
            remember(token, next)
            setName(used)
            try {
              localStorage.setItem('wishlist-visitor-name', used)
            } catch {
              // Not remembered; they type it again next time.
            }
            setClaiming(null)
            void load()
          }}
        />
      )}
    </AuthLayout>
  )
}

function ClaimForm({ api, base, item, share, name: initial, onCancel, onDone }: { api: ApiClient; base: string; item: SharedItem; share: boolean; name: string; onCancel: () => void; onDone: (m: Mine, name: string) => void }) {
  const [name, setName] = useState(initial)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const save = useAction(async () => {
    const cents = share ? parseRand(amount) : null
    if (share && (cents === null || cents <= 0)) throw new Error('Say how much you are putting in.')
    const r = await api.post<{ claim: { id: string }; undo: string }>(`${base}/items/${item.id}/claims`, { claim: { name, amount: cents, note } })
    onDone({ claimId: r.claim.id, undo: r.undo }, name.trim())
  })
  return (
    <form className="stack card" aria-label={share ? `Put in towards ${item.what}` : `Getting ${item.what}`} onSubmit={(e) => (e.preventDefault(), void save.run())}>
      <h2>{share ? `Put in towards: ${item.what}` : `Getting: ${item.what}`}</h2>
      <Labelled id="visitor-name" label="Your name" hint="So the family knows who it is from.">
        <input id="visitor-name" className="qi-search" maxLength={60} required autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
      </Labelled>
      {share && (
        <Labelled id="visitor-amount" label="What you are putting in" hint={item.price !== null ? `It costs about ${rand(item.price)}.` : undefined}>
          <input id="visitor-amount" className="qi-search" inputMode="decimal" required placeholder="R" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </Labelled>
      )}
      <Labelled id="visitor-note" label="A note for the family (optional)">
        <input id="visitor-note" className="qi-search" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
      </Labelled>
      {save.error && <Banner kind="error">{save.error}</Banner>}
      <div className="row">
        <Button type="submit" busy={save.busy}>
          {share ? 'Put in my share' : 'I’m getting this'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
