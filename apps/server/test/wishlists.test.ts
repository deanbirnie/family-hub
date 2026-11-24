import { afterEach, describe, expect, it } from 'vitest'
import { cleanItem } from '../src/routes/wishlists.ts'
import { Client, enrollTotp, nextStep, PASSWORD, setUpAdmin, startServer, type TestServer } from './helpers.ts'

let server: TestServer
afterEach(async () => server?.close())

interface Listing {
  profiles: { id: string; displayName: string; userId: string | null; mine: boolean; mayEdit: boolean }[]
  items: { id: string; profileId: string; what: string; version: number; claims?: { id: string; name: string; mine: boolean; amount: number | null }[] }[]
  sizes: { profileId: string; shoes: string }[]
}

describe('wishlist items', () => {
  it('refuse what does not make sense', () => {
    expect(() => cleanItem({})).toThrow()
    expect(() => cleanItem({ what: 'Lego', link: 'javascript:alert(1)' })).toThrow()
    expect(() => cleanItem({ what: 'Lego', want: 'desperately' })).toThrow()
    expect(cleanItem({ what: 'Lego', link: 'https://example.com/lego', price: 49900 })).toMatchObject({ want: 'would like', done: false, price: 49900 })
  })
})

describe('the Wishlists API', () => {
  it('lets the family get things for each other, and never tells the owner', async () => {
    server = await startServer()
    const { client: parent } = await setUpAdmin(server)
    const invite = await parent.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    const sam = (await parent.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })).body.profile.id

    const first = await parent.get<Listing>('/api/wishlists')
    const mine = first.body.profiles.find((p) => p.mine)!
    const kidProfile = first.body.profiles.find((p) => p.displayName === 'Kid')!
    expect(first.body.profiles.find((p) => p.id === sam)!.mayEdit).toBe(true) // no account: the parents keep it
    expect(kidProfile.mayEdit).toBe(false) // has an account: theirs to keep

    const lego = await parent.post<{ item: { id: string } }>(`/api/wishlists/${mine.id}/items`, { item: { what: 'Lego Technic', link: 'https://example.com/lego', price: 199900, want: 'really' } })
    expect(lego.status).toBe(200)
    // Only they keep their list; parents keep the lists of children without accounts.
    expect((await kid.post(`/api/wishlists/${mine.id}/items`, { item: { what: 'x' } })).status).toBe(403)
    expect((await parent.post(`/api/wishlists/${kidProfile.id}/items`, { item: { what: 'x' } })).status).toBe(403)
    const bike = await parent.post<{ item: { id: string } }>(`/api/wishlists/${sam}/items`, { item: { what: 'Balance bike' } })
    expect(bike.status).toBe(200)

    // The kid is getting the Lego, and shares the bike.
    expect((await kid.post(`/api/wishlists/items/${lego.body.item.id}/claims`, {})).status).toBe(200)
    expect((await kid.post(`/api/wishlists/items/${bike.body.item.id}/claims`, { claim: { amount: 50000 } })).status).toBe(200)
    // The owner cannot claim their own things.
    expect((await parent.post(`/api/wishlists/items/${lego.body.item.id}/claims`, {})).status).toBe(403)

    // The owner sees no claims on their own list: not who, not that there are any.
    const parentView = await parent.get<Listing>('/api/wishlists')
    const ownLego = parentView.body.items.find((i) => i.id === lego.body.item.id)!
    expect(ownLego).not.toHaveProperty('claims')
    expect(JSON.stringify(parentView.body.items.filter((i) => i.profileId === mine.id))).not.toContain('Kid')
    // But parents see claims on the list they keep for Sam.
    expect(parentView.body.items.find((i) => i.id === bike.body.item.id)!.claims).toMatchObject([{ name: 'Kid', amount: 50000, mine: false }])

    // The kid sees their own claim, and can take it back; nobody else can.
    const kidView = await kid.get<Listing>('/api/wishlists')
    const claim = kidView.body.items.find((i) => i.id === lego.body.item.id)!.claims![0]!
    expect(claim).toMatchObject({ name: 'Kid', mine: true })
    expect((await parent.del(`/api/wishlists/claims/${claim.id}`)).status).toBe(404)
    expect((await kid.del(`/api/wishlists/claims/${claim.id}`)).status).toBe(204)

    // Sizes: kept by the person, or a parent.
    expect((await parent.call('PUT', `/api/wishlists/${sam}/sizes`, { sizes: { shoes: '9 (kids)' } })).status).toBe(200)
    expect((await kid.call('PUT', `/api/wishlists/${sam}/sizes`, { sizes: { shoes: '1' } })).status).toBe(403)
    expect((await kid.call('PUT', `/api/wishlists/${kidProfile.id}/sizes`, { sizes: { shoes: '5' } })).status).toBe(200)
    expect((await kid.get<Listing>('/api/wishlists')).body.sizes.map((x) => x.shoes).sort()).toEqual(['5', '9 (kids)'])

    // Editing checks the version.
    expect((await parent.call('PUT', `/api/wishlists/items/${lego.body.item.id}`, { baseVersion: 2, item: { what: 'x' } })).status).toBe(409)
    expect((await parent.call('PUT', `/api/wishlists/items/${lego.body.item.id}`, { baseVersion: 1, item: { what: 'Lego Technic', done: true } })).status).toBe(200)

    const raw = JSON.stringify([...server.services.db.prepare('SELECT * FROM wishlist').all(), ...server.services.db.prepare('SELECT * FROM wishlist_claims').all()])
    for (const w of ['Lego', 'example.com', 'Balance', 'Kid', '9 (kids)']) expect(raw).not.toContain(w)

    expect((await parent.del(`/api/wishlists/items/${bike.body.item.id}`)).status).toBe(204)
    expect(server.services.db.prepare('SELECT COUNT(*) AS n FROM wishlist_claims').get()).toEqual({ n: 0 })
  })
})

describe('share links for the children’s wishlists', () => {
  it('let visitors see the list and mark what they are getting, without names, until the link is turned off', async () => {
    server = await startServer()
    const { client: parent } = await setUpAdmin(server)
    const sam = (await parent.post<{ profile: { id: string } }>('/api/quick-info/profiles', { displayName: 'Sam' })).body.profile.id
    const mine = (await parent.get<Listing>('/api/wishlists')).body.profiles.find((p) => p.mine)!
    const bike = await parent.post<{ item: { id: string } }>(`/api/wishlists/${sam}/items`, { item: { what: 'Balance bike', price: 120000 } })
    const blocks = await parent.post<{ item: { id: string } }>(`/api/wishlists/${sam}/items`, { item: { what: 'Wooden blocks' } })
    await parent.post(`/api/wishlists/${sam}/items`, { item: { what: 'Old teddy', done: true } })
    await parent.call('PUT', `/api/wishlists/${sam}/sizes`, { sizes: { shoes: '9 (kids)' } })

    // A parent's own list cannot be shared; a child's can.
    expect((await parent.post(`/api/wishlists/${mine.id}/link`, {})).status).toBe(403)
    const made = await parent.post<{ secret: string; link: { id: string } }>(`/api/wishlists/${sam}/link`, {})
    expect(made.status).toBe(200)
    const token = made.body.secret
    expect(JSON.stringify(server.services.db.prepare('SELECT * FROM wishlist_links').all())).not.toContain(token)
    const listing = await parent.get<{ links: { profileId: string }[] }>("/api/wishlists")
    expect(listing.body).toMatchObject({ links: [{ profileId: sam }] })

    // A visitor without an account.
    const granny = new Client(server.url)
    const seen = await granny.get<{ name: string; items: { id: string; what: string; taken: boolean; pledged: number }[]; sizes: { shoes: string } }>(`/api/shared/wishlist/${token}`)
    expect(seen.status).toBe(200)
    expect(seen.body.name).toBe('Sam')
    expect(seen.body.items.map((i) => i.what).sort()).toEqual(['Balance bike', 'Wooden blocks']) // not what Sam has had
    expect(seen.body.sizes.shoes).toBe('9 (kids)')
    expect((await granny.get('/api/wishlists')).status).toBe(401)
    expect((await granny.get('/api/shared/wishlist/not-a-real-token')).status).toBe(404)

    // Granny is getting the blocks, and puts R300 towards the bike; she needs a name.
    expect((await granny.post(`/api/shared/wishlist/${token}/items/${blocks.body.item.id}/claims`, { claim: {} })).status).toBe(400)
    const gift = await granny.post<{ claim: { id: string }; undo: string }>(`/api/shared/wishlist/${token}/items/${blocks.body.item.id}/claims`, { claim: { name: 'Granny Jo', note: 'Posted' } })
    expect(gift.status).toBe(200)
    await granny.post(`/api/shared/wishlist/${token}/items/${bike.body.item.id}/claims`, { claim: { name: 'Granny Jo', amount: 30000 } })
    const after = await granny.get<{ items: { what: string; taken: boolean; pledged: number; sharers: number }[] }>(`/api/shared/wishlist/${token}`)
    expect(after.body.items.map((i) => [i.what, i.taken, i.pledged, i.sharers]).sort()).toEqual([
      ['Balance bike', false, 30000, 1],
      ['Wooden blocks', true, 0, 0],
    ])
    // Visitors see no names, not even their own.
    expect(JSON.stringify(after.body)).not.toContain('Granny')

    // The family sees who.
    const family = await parent.get<Listing & { items: { claims?: { name: string; byLink: boolean }[] }[] }>('/api/wishlists')
    expect(family.body.items.find((i) => i.id === blocks.body.item.id)!.claims).toMatchObject([{ name: 'Granny Jo', byLink: true }])

    // Taking it back needs the secret she was given.
    expect((await granny.post(`/api/shared/wishlist/${token}/claims/${gift.body.claim.id}/undo`, { undo: 'guess' })).status).toBe(404)
    expect((await granny.post(`/api/shared/wishlist/${token}/claims/${gift.body.claim.id}/undo`, { undo: gift.body.undo })).status).toBe(204)

    // A new link replaces the old one; turning it off stops it.
    const again = await parent.post<{ secret: string }>(`/api/wishlists/${sam}/link`, {})
    expect((await granny.get(`/api/shared/wishlist/${token}`)).status).toBe(404)
    expect((await granny.get(`/api/shared/wishlist/${again.body.secret}`)).status).toBe(200)
    expect((await parent.del(`/api/wishlists/${sam}/link`)).status).toBe(204)
    expect((await granny.get(`/api/shared/wishlist/${again.body.secret}`)).status).toBe(404)
    expect((await parent.get<{ links: unknown[] }>('/api/wishlists')).body.links).toEqual([])

    const raw = JSON.stringify(server.services.db.prepare('SELECT * FROM wishlist_claims').all())
    for (const w of ['Granny', 'Posted']) expect(raw).not.toContain(w)
  })

  it('are for parents to make, and only for the children’s lists', async () => {
    server = await startServer()
    const { client: parent } = await setUpAdmin(server)
    const invite = await parent.post<{ token: string }>('/api/invites', { displayName: 'Kid' })
    const kid = new Client(server.url)
    await kid.post(`/api/invites/redeem/${invite.body.token}`, { username: 'kid', displayName: 'Kid', password: PASSWORD })
    nextStep(server)
    await enrollTotp(server, kid)
    const profiles = (await kid.get<Listing>('/api/wishlists')).body.profiles
    const kidProfile = profiles.find((p) => p.mine)!
    expect((await kid.post(`/api/wishlists/${kidProfile.id}/link`, {})).status).toBe(403)
    // A parent may share the list of a child with an account; the child still never sees claims.
    const made = await parent.post<{ secret: string }>(`/api/wishlists/${kidProfile.id}/link`, {})
    expect(made.status).toBe(200)
    const item = await kid.post<{ item: { id: string } }>(`/api/wishlists/${kidProfile.id}/items`, { item: { what: 'Skateboard' } })
    await new Client(server.url).post(`/api/shared/wishlist/${made.body.secret}/items/${item.body.item.id}/claims`, { claim: { name: 'Uncle Ben' } })
    expect(JSON.stringify((await kid.get('/api/wishlists')).body)).not.toContain('Uncle')
    expect((await kid.get<{ links: unknown[] }>('/api/wishlists')).body.links).toEqual([])
  })
})
