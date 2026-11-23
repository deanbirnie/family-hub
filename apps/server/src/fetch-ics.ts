/**
 * Fetching an outside calendar (a parent's subscription link), carefully:
 * https only; never an address on the home network or the server itself
 * (checked on the address actually connected to, so a name cannot be made
 * to point inside later); at most 3 redirects, each checked the same way;
 * at most 2 MB; 20 seconds. Nothing is sent but the request for the file.
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request } from 'node:https'
import { isIP } from 'node:net'

export const MAX_ICS_BYTES = 2 * 1024 * 1024

/** Addresses that are not the public internet. */
export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number]
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    )
  }
  const v = ip.toLowerCase()
  if (v === '::' || v === '::1') return true
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v)
  if (mapped) return isPrivateAddress(mapped[1]!)
  return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(v)
}

export class FetchProblem extends Error {}

/** Checks a subscription link before it is saved. */
export function checkLink(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim().replace(/^webcal:/i, 'https:'))
  } catch {
    throw new FetchProblem('That is not a link.')
  }
  if (url.protocol !== 'https:') throw new FetchProblem('Calendar links must start with https:// (or webcal://).')
  if (url.username || url.password) throw new FetchProblem('Links with a user name or password are not accepted.')
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new FetchProblem('That address is on a private network.')
  if (/^(localhost|.*\.local|.*\.internal|.*\.lan|.*\.home)$/i.test(url.hostname)) throw new FetchProblem('That address is on a private network.')
  if (url.toString().length > 2000) throw new FetchProblem('That link is too long.')
  return url
}

/** Resolves a name, refusing it if any of its addresses is private. */
const safeLookup: typeof dnsLookup = ((hostname: string, options: object, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '')
    const list = addresses as LookupAddress[]
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      return callback(Object.assign(new Error('That address is on a private network.'), { code: 'EPRIVATE' }), '')
    }
    if ((options as { all?: boolean }).all) return callback(null, list)
    callback(null, list[0]!.address, list[0]!.family)
  })
}) as typeof dnsLookup

export type IcsFetcher = (url: URL) => Promise<string>

function getOnce(url: URL): Promise<{ status: number; location?: string; body?: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: 'GET', lookup: safeLookup, headers: { Accept: 'text/calendar, */*;q=0.1', 'User-Agent': 'FamilyHub-Calendar/1' }, timeout: 20_000 },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400) {
          res.resume()
          return resolve({ status, location: res.headers.location })
        }
        if (status !== 200) {
          res.resume()
          return resolve({ status })
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_ICS_BYTES) {
            req.destroy(new FetchProblem('The calendar is too big (over 2 MB).'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new FetchProblem('The calendar did not answer in time.')))
    req.on('error', (e) => reject(e))
    const overall = setTimeout(() => req.destroy(new FetchProblem('The calendar did not answer in time.')), 30_000)
    req.on('close', () => clearTimeout(overall))
    req.end()
  })
}

/** Fetches a calendar file. Throws FetchProblem with a message to show. */
export const fetchIcs: IcsFetcher = async (start) => {
  let url = start
  for (let hop = 0; hop <= 3; hop++) {
    checkLink(url.toString())
    let res: Awaited<ReturnType<typeof getOnce>>
    try {
      res = await getOnce(url)
    } catch (e) {
      if (e instanceof FetchProblem) throw e
      if ((e as { code?: string }).code === 'EPRIVATE') throw new FetchProblem('That address is on a private network.')
      throw new FetchProblem('The calendar could not be reached.')
    }
    if (res.location !== undefined) {
      if (!res.location) throw new FetchProblem('The calendar sent a broken redirect.')
      url = new URL(res.location, url)
      continue
    }
    if (res.status !== 200) throw new FetchProblem(`The calendar answered ${res.status}.`)
    if (!res.body!.includes('BEGIN:VCALENDAR')) throw new FetchProblem('That link is not a calendar (.ics).')
    return res.body!
  }
  throw new FetchProblem('The calendar redirected too many times.')
}
