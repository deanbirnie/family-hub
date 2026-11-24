/**
 * Wishlists (phase 8a), for everyone in the family.
 *
 * Each family member keeps their own list (parents keep the lists of
 * children without an account). Others mark what they are getting, alone or
 * sharing the cost, and **the list's owner never receives any of it**: the
 * claims are kept apart from the items and left out of every answer to the
 * owner, so surprises survive. Each person also has a sizes card.
 *
 * Sealed with the server key (docs/DATA-PROTECTION.md, "Wishlists").
 */
import type { Api, Services } from '../app.ts'
import { bad, cents, obj, oneOf, text } from '../household.ts'
import { HttpError, readJson } from '../http.ts'
import { newId } from '../secrets.ts'

export interface WishItem {
  what: string
  link: string
  /** A rough price, in cents. */
  price: number | null
  want: 'really' | 'would like' | 'nice to have'
  /** Size, colour, model. */
  details: string
  notes: string
  /** Received or no longer wanted: kept, out of the way. */
  done: boolean
}

export interface Sizes {
  tops: string
  bottoms: string
  dress: string
  shoes: string
  ring: string
  hat: string
  notes: string
}

export interface Claim {
  /** Who is getting it (a family member's name). */
  name: string
  /** Their share, for a gift several people share; null for the whole thing. */
  amount: number | null
  note: string
}

export const cleanItem = (raw: unknown): WishItem => {
  const o = obj(raw)
  const link = text(o, 'link', 1000, 'The link')
  if (link && !/^https?:\/\/[^\s]+$/i.test(link)) bad('The link must start with http:// or https://.')
  return {
    what: text(o, 'what', 200, 'What', true),
    link,
    price: o.price === null || o.price === undefined || o.price === '' ? null : cents(o.price, 'The price'),
    want: oneOf(o.want, ['really', 'would like', 'nice to have'] as const, 'How much it is wanted', 'would like'),
    details: text(o, 'details', 200, 'Size or colour'),
    notes: text(o, 'notes', 1000, 'Notes'),
    done: o.done === true,
  }
}

export const cleanSizes = (raw: unknown): Sizes => {
  const o = obj(raw)
  return {
    tops: text(o, 'tops', 40, 'Tops'),
    bottoms: text(o, 'bottoms', 40, 'Bottoms'),
    dress: text(o, 'dress', 40, 'Dress'),
    shoes: text(o, 'shoes', 40, 'Shoes'),
    ring: text(o, 'ring', 40, 'Ring'),
    hat: text(o, 'hat', 40, 'Hat'),
    notes: text(o, 'notes', 500, 'Notes'),
  }
}

interface Profile {
  id: string
  display_name: string
  user_id: string | null
}

export function wishlistRoutes(api: Api, s: Services): void {
  const { db } = s
  const signedIn = {} as const
  const seal = (kind: string, id: string, v: unknown) => s.serverKey.seal(JSON.stringify(v), 'wishlist', `${kind}:${id}`)
  const open = <T>(kind: string, id: string, sealed: string) => JSON.parse(s.serverKey.open(sealed, 'wishlist', `${kind}:${id}`)) as T

  const profile = (id: string) => {
    const p = db.prepare('SELECT id, display_name, user_id FROM family_profiles WHERE id = ?').get(id) as Profile | undefined
    if (!p) throw new HttpError(404, 'That person is no longer in the family.', 'not_found')
    return p
  }
  /** Whose list it is to keep: the person themselves, or the parents for someone without an account. */
  const mayEdit = (p: Profile, user: { id: string; role: string }) => p.user_id === user.id || (p.user_id === null && user.role === 'admin')
  /** The list's owner, who must never learn who is getting what. */
  const isOwner = (p: Profile, userId: string) => p.user_id === userId

  /** Everyone with an account has a list: give them a family profile if they have none yet. */
  const ensureProfiles = () => {
    const missing = db.prepare('SELECT id, display_name FROM users WHERE disabled = 0 AND id NOT IN (SELECT user_id FROM family_profiles WHERE user_id IS NOT NULL)').all() as { id: string; display_name: string }[]
    for (const u of missing) db.prepare('INSERT INTO family_profiles (id, display_name, user_id, created_at) VALUES (?, ?, ?, ?)').run(newId(), u.display_name, u.id, s.now())
  }

  api.authed('GET', '/api/wishlists', signedIn, (ctx) => {
    ensureProfiles()
    const profiles = db.prepare('SELECT id, display_name, user_id FROM family_profiles ORDER BY display_name COLLATE NOCASE, id').all() as unknown as Profile[]
    const rows = db.prepare('SELECT id, profile_id, kind, sealed, version FROM wishlist ORDER BY created_at, id').all() as { id: string; profile_id: string; kind: 'item' | 'sizes'; sealed: string; version: number }[]
    const claims = db.prepare('SELECT id, item_id, user_id, sealed FROM wishlist_claims ORDER BY created_at, id').all() as { id: string; item_id: string; user_id: string | null; sealed: string }[]
    const owned = new Set(profiles.filter((p) => isOwner(p, ctx.user.id)).map((p) => p.id))
    return {
      me: ctx.user.id,
      profiles: profiles.map((p) => ({ id: p.id, displayName: p.display_name, userId: p.user_id, mine: p.user_id === ctx.user.id, mayEdit: mayEdit(p, ctx.user) })),
      items: rows
        .filter((r) => r.kind === 'item')
        .map((r) => ({
          id: r.id,
          profileId: r.profile_id,
          version: r.version,
          ...open<WishItem>('item', r.id, r.sealed),
          // The owner gets no claims at all: not who, not how many, not that there are any.
          claims: owned.has(r.profile_id)
            ? undefined
            : claims
                .filter((c) => c.item_id === r.id)
                .map((c) => ({ id: c.id, mine: c.user_id === ctx.user.id, ...open<Claim>('claim', c.id, c.sealed) })),
        })),
      sizes: rows.filter((r) => r.kind === 'sizes').map((r) => ({ id: r.id, profileId: r.profile_id, version: r.version, ...open<Sizes>('sizes', r.id, r.sealed) })),
    }
  })

  api.authed('POST', '/api/wishlists/:profileId/items', signedIn, async (ctx) => {
    const p = profile(ctx.params.profileId!)
    if (!mayEdit(p, ctx.user)) throw new HttpError(403, 'Only they (or the parents, for a child without an account) keep this list.', 'forbidden')
    if ((db.prepare('SELECT COUNT(*) AS n FROM wishlist WHERE profile_id = ?').get(p.id) as { n: number }).n >= 500) throw new HttpError(400, 'That list is full.', 'invalid')
    const item = cleanItem((await readJson(ctx.req)).item)
    const id = newId()
    const now = s.now()
    db.prepare("INSERT INTO wishlist (id, profile_id, kind, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, 'item', ?, 1, ?, ?, ?)").run(id, p.id, seal('item', id, item), now, now, ctx.user.id)
    s.audit('wishlist.added', ctx, ctx.user.id)
    return { item: { id, profileId: p.id, version: 1, ...item } }
  })

  const itemRow = (id: string) => {
    const r = db.prepare("SELECT id, profile_id, version FROM wishlist WHERE id = ? AND kind = 'item'").get(id) as { id: string; profile_id: string; version: number } | undefined
    if (!r) throw new HttpError(404, 'That is no longer on the list.', 'not_found')
    return r
  }

  api.authed('PUT', '/api/wishlists/items/:id', signedIn, async (ctx) => {
    const r = itemRow(ctx.params.id!)
    if (!mayEdit(profile(r.profile_id), ctx.user)) throw new HttpError(403, 'Only they keep this list.', 'forbidden')
    const body = await readJson(ctx.req)
    if (body.baseVersion !== r.version) throw new HttpError(409, 'This was changed a moment ago. Open it again.', 'edit_conflict')
    const item = cleanItem(body.item)
    db.prepare('UPDATE wishlist SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(seal('item', r.id, item), s.now(), ctx.user.id, r.id)
    return { item: { id: r.id, profileId: r.profile_id, version: r.version + 1, ...item } }
  })

  api.authed('DELETE', '/api/wishlists/items/:id', signedIn, (ctx) => {
    const r = itemRow(ctx.params.id!)
    if (!mayEdit(profile(r.profile_id), ctx.user)) throw new HttpError(403, 'Only they keep this list.', 'forbidden')
    db.prepare('DELETE FROM wishlist WHERE id = ?').run(r.id)
    s.audit('wishlist.removed', ctx, ctx.user.id)
    return undefined
  })

  /** "I'm getting this" (or my share of it). Never the list's owner. */
  api.authed('POST', '/api/wishlists/items/:id/claims', signedIn, async (ctx) => {
    const r = itemRow(ctx.params.id!)
    if (isOwner(profile(r.profile_id), ctx.user.id)) throw new HttpError(403, 'That is your own list.', 'forbidden')
    const o = obj((await readJson(ctx.req)).claim ?? {})
    const claim: Claim = {
      name: ctx.user.displayName,
      amount: o.amount === null || o.amount === undefined || o.amount === '' ? null : cents(o.amount, 'Your share'),
      note: text(o, 'note', 200, 'A note'),
    }
    // One claim per person per item: a new one replaces theirs.
    db.prepare('DELETE FROM wishlist_claims WHERE item_id = ? AND user_id = ?').run(r.id, ctx.user.id)
    const id = newId()
    db.prepare('INSERT INTO wishlist_claims (id, item_id, user_id, sealed, created_at) VALUES (?, ?, ?, ?, ?)').run(id, r.id, ctx.user.id, seal('claim', id, claim), s.now())
    return { claim: { id, mine: true, ...claim } }
  })

  api.authed('DELETE', '/api/wishlists/claims/:id', signedIn, (ctx) => {
    if (Number(db.prepare('DELETE FROM wishlist_claims WHERE id = ? AND user_id = ?').run(ctx.params.id!, ctx.user.id).changes) === 0) throw new HttpError(404, 'That is not your claim.', 'not_found')
    return undefined
  })

  /** A person's sizes card: kept by them, or by the parents for a child without an account (parents may update any). */
  api.authed('PUT', '/api/wishlists/:profileId/sizes', signedIn, async (ctx) => {
    const p = profile(ctx.params.profileId!)
    if (!mayEdit(p, ctx.user) && ctx.user.role !== 'admin') throw new HttpError(403, 'Only they (or a parent) keep their sizes.', 'forbidden')
    const sizes = cleanSizes((await readJson(ctx.req)).sizes)
    const existing = db.prepare("SELECT id FROM wishlist WHERE profile_id = ? AND kind = 'sizes'").get(p.id) as { id: string } | undefined
    const now = s.now()
    if (existing) db.prepare('UPDATE wishlist SET sealed = ?, version = version + 1, updated_at = ?, updated_by = ? WHERE id = ?').run(seal('sizes', existing.id, sizes), now, ctx.user.id, existing.id)
    else {
      const id = newId()
      db.prepare("INSERT INTO wishlist (id, profile_id, kind, sealed, version, created_at, updated_at, updated_by) VALUES (?, ?, 'sizes', ?, 1, ?, ?, ?)").run(id, p.id, seal('sizes', id, sizes), now, now, ctx.user.id)
    }
    return { sizes }
  })
}
