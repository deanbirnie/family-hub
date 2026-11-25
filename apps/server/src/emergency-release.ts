/**
 * Releasing the emergency pack (phase 9c). One release at a time:
 *
 * - **On request:** a trusted party opens the link in their letter. Both
 *   parents are told at once (notification and email) and can cancel. After
 *   the waiting period (3 days) a second confirmation goes to the parents;
 *   if neither cancels within its time (24 hours), the pack goes to the
 *   guardians and those to inform are told.
 * - **When nobody is there:** after 7 days with no activity from either
 *   parent, each parent gets a check-in each day. After 3 days of them, the
 *   trusted parties are emailed, with a link to say all is well and one to
 *   request the pack. If nobody answers within 3 more days, the pack is sent.
 *   Any parent's activity, or a trusted party's "all is well", stops it.
 *
 * The parents choose the periods. The pack goes out as it was last made on
 * a parent's device, locked with the password in the guardians' letters;
 * the emails point to the letter and never hold the password.
 */
import type { Services } from './app.ts'
import { hubAddress, sendTo, subscriptionsOf } from './notifications.ts'
import { familyName } from './routes/auth.ts'
import { hashToken, newId, newToken } from './secrets.ts'

const HOUR = 3_600_000
const DAY = 24 * HOUR

export interface ReleaseSettings {
  /** Days between a request and the second confirmation. */
  requestWaitDays: number
  /** Hours the second confirmation gives the parents to cancel. */
  confirmHours: number
  /** Whether the inactivity backstop runs at all. */
  backstop: boolean
  /** Days without any parent's activity before the check-ins start. */
  inactiveDays: number
  /** Days of daily check-ins before the trusted parties are asked. */
  checkinDays: number
  /** Days the trusted parties have to answer before the pack is sent anyway. */
  partyWaitDays: number
}

export const DEFAULT_SETTINGS: ReleaseSettings = { requestWaitDays: 3, confirmHours: 24, backstop: true, inactiveDays: 7, checkinDays: 3, partyWaitDays: 3 }
export const LIMITS: Record<Exclude<keyof ReleaseSettings, 'backstop'>, [number, number]> = {
  requestWaitDays: [1, 30],
  confirmHours: [1, 168],
  inactiveDays: [3, 90],
  checkinDays: [1, 14],
  partyWaitDays: [1, 30],
}

const SETTINGS_KEY = 'emergency_settings'
const ACTIVITY_KEY = 'emergency_last_activity'

const getSetting = (s: Services, key: string) => (s.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value
const putSetting = (s: Services, key: string, value: string) =>
  s.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, value)

export function releaseSettings(s: Services): ReleaseSettings {
  try {
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(getSetting(s, SETTINGS_KEY) ?? '{}') as Partial<ReleaseSettings>) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** Checks and stores the parents' choices; throws a readable message for one out of range. */
export function saveReleaseSettings(s: Services, raw: Record<string, unknown>): ReleaseSettings {
  const out = { ...releaseSettings(s) }
  for (const [k, [min, max]] of Object.entries(LIMITS) as [keyof typeof LIMITS, [number, number]][]) {
    if (raw[k] === undefined) continue
    const v = raw[k]
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error(`Choose ${min} to ${max} for that.`)
    out[k] = v
  }
  if (raw.backstop !== undefined) out.backstop = raw.backstop === true
  putSetting(s, SETTINGS_KEY, JSON.stringify(out))
  return out
}

// ---- the parents: activity, email, notifications ---------------------------------------------

const parents = (s: Services) => s.db.prepare("SELECT id, display_name FROM users WHERE role = 'admin' AND disabled = 0").all() as { id: string; display_name: string }[]

/** The last time either parent used the hub: from their sessions, remembered so expired sessions do not forget it. */
export function lastParentActivity(s: Services): number {
  const seen = (s.db.prepare("SELECT MAX(last_seen_at) AS at FROM sessions JOIN users u ON u.id = sessions.user_id WHERE u.role = 'admin' AND sessions.stage = 'full'").get() as { at: number | null }).at ?? 0
  const kept = Number(getSetting(s, ACTIVITY_KEY) ?? 0)
  if (seen > kept) putSetting(s, ACTIVITY_KEY, String(seen))
  return Math.max(seen, kept)
}

export const sealParentEmail = (s: Services, userId: string, email: string) => s.serverKey.seal(email, 'parent-email', userId)
const parentEmail = (s: Services, userId: string): string | null => {
  const r = s.db.prepare('SELECT sealed FROM emergency_parent_email WHERE user_id = ?').get(userId) as { sealed: string } | undefined
  return r ? s.serverKey.open(r.sealed, 'parent-email', userId) : null
}
export const ownEmail = parentEmail

/** Tells both parents: a notification on every device, and an email where they gave one. */
async function tellParents(s: Services, push: string, subject: string, text: string, tag: string): Promise<void> {
  for (const p of parents(s)) {
    for (const route of subscriptionsOf(s, p.id)) await sendTo(s, route, { title: 'Family Hub', body: push, tag, url: '/emergency' }).catch(() => undefined)
    const to = parentEmail(s, p.id)
    if (to && s.mail.configured) await s.mail.send({ to: [to], subject, text }).catch((e: unknown) => console.error('Emergency email to a parent failed', e))
  }
}

// ---- trusted parties ---------------------------------------------------------------------------

interface Party {
  id: string
  name: string
  email: string
  role: 'guardian' | 'inform'
}

const allParties = (s: Services): Party[] =>
  (s.db.prepare('SELECT id, sealed FROM trusted_parties ORDER BY created_at, rowid').all() as { id: string; sealed: string }[]).map((r) => ({
    id: r.id,
    ...(JSON.parse(s.serverKey.open(r.sealed, 'trusted-party', r.id)) as Omit<Party, 'id'>),
  }))

const when = (s: Services, ms: number) =>
  new Date(ms).toLocaleString('en-ZA', { timeZone: s.config.timeZone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

const SIGN_OFF = '\n\n(Sent by the family’s Family Hub, their own app at home. Please do not reply to this address.)\n'

// ---- the release ---------------------------------------------------------------------------------

export interface ReleaseRow {
  id: string
  kind: 'request' | 'inactive'
  party_id: string | null
  stage: 'waiting' | 'confirming' | 'checkin' | 'asking' | 'sending' | 'sent' | 'cancelled'
  started_at: number
  next_at: number | null
  checkins: number
  ended_at: number | null
  ended_by: string | null
  ended_reason: string | null
}

const OPEN_STAGES = "('waiting', 'confirming', 'checkin', 'asking', 'sending')"
export const openRelease = (s: Services) => s.db.prepare(`SELECT * FROM emergency_release WHERE stage IN ${OPEN_STAGES} ORDER BY started_at DESC LIMIT 1`).get() as unknown as ReleaseRow | undefined
export const lastRelease = (s: Services) => s.db.prepare('SELECT * FROM emergency_release ORDER BY started_at DESC, rowid DESC LIMIT 1').get() as unknown as ReleaseRow | undefined

const setStage = (s: Services, id: string, stage: ReleaseRow['stage'], nextAt: number | null) => s.db.prepare('UPDATE emergency_release SET stage = ?, next_at = ? WHERE id = ?').run(stage, nextAt, id)
const end = (s: Services, id: string, stage: 'sent' | 'cancelled', by: string, reason: string) =>
  s.db.prepare('UPDATE emergency_release SET stage = ?, next_at = NULL, ended_at = ?, ended_by = ?, ended_reason = ? WHERE id = ?').run(stage, s.now(), by, reason, id)

/** Who the link in a letter, or in an "is all well?" email, belongs to. */
export function partyBySecret(s: Services, secret: string): { party: Party; via: 'letter' | 'ask'; askRelease: string | null } | null {
  const hash = hashToken(secret)
  const byLetter = s.db.prepare('SELECT id FROM trusted_parties WHERE request_hash = ?').get(hash) as { id: string } | undefined
  const ask = byLetter ? undefined : (s.db.prepare('SELECT party_id, release_id FROM emergency_asks WHERE token_hash = ?').get(hash) as { party_id: string; release_id: string } | undefined)
  const id = byLetter?.id ?? ask?.party_id
  const party = id ? allParties(s).find((p) => p.id === id) : undefined
  if (!party) return null
  return { party, via: byLetter ? 'letter' : 'ask', askRelease: ask?.release_id ?? null }
}

/**
 * A trusted party asks for the pack. Starts the waiting period and tells the
 * parents at once; while the trusted parties are being asked (the backstop),
 * it sends the pack straight away, since the parents have already missed
 * their check-ins. Returns what now happens.
 */
export async function requestPack(s: Services, party: Party, note: string): Promise<{ status: 'started' | 'already' | 'sending'; sendAt: number | null }> {
  const open = openRelease(s)
  if (open?.stage === 'asking') {
    setStage(s, open.id, 'sending', s.now())
    await tellParents(s, 'The emergency pack is being sent. Open the hub now.', 'Family Hub: the emergency pack is being sent', `${party.name} asked for the emergency pack after you did not answer the check-ins. It is being sent to the guardians now.${SIGN_OFF}`, 'emergency')
    await runEmergency(s)
    return { status: 'sending', sendAt: s.now() }
  }
  if (open && open.kind === 'request') return { status: 'already', sendAt: open.next_at }
  if (open) end(s, open.id, 'cancelled', 'system', 'replaced by a request')
  const settings = releaseSettings(s)
  const id = newId()
  const sendAt = s.now() + settings.requestWaitDays * DAY
  s.db
    .prepare("INSERT INTO emergency_release (id, kind, party_id, stage, started_at, next_at, note_sealed) VALUES (?, 'request', ?, 'waiting', ?, ?, ?)")
    .run(id, party.id, s.now(), sendAt, note ? s.serverKey.seal(note, 'emergency-note', id) : null)
  await tellParents(
    s,
    'Someone asked for the emergency pack. Open the hub now.',
    `Family Hub: ${party.name} asked for the emergency pack`,
    `${party.name} used the link in their letter to ask for the emergency pack${note ? `, saying: “${note}”` : ''}.\n\nIf all is well, open the Family Hub (Settings → In case of emergency) and cancel it. Otherwise, after ${settings.requestWaitDays} day${settings.requestWaitDays === 1 ? '' : 's'} you will be asked once more, and then the pack is sent to the guardians.${SIGN_OFF}`,
    `emergency-${id}`,
  )
  return { status: 'started', sendAt: sendAt + settings.confirmHours * HOUR }
}

/** A parent says all is well: the release stops, and whoever was asked is told. */
export async function cancelRelease(s: Services, byUserId: string, byName: string): Promise<boolean> {
  const open = openRelease(s)
  if (!open || open.stage === 'sending') return false
  end(s, open.id, 'cancelled', byUserId, 'a parent said all is well')
  await tellOthersAllIsWell(s, open, `${byName} has said all is well`)
  return true
}

/** A trusted party says all is well (backstop): it stops. */
export async function partySaysWell(s: Services, party: Party): Promise<boolean> {
  const open = openRelease(s)
  if (!open || open.kind !== 'inactive' || open.stage !== 'asking') return false
  end(s, open.id, 'cancelled', `party:${party.id}`, 'a trusted party said all is well')
  await tellParents(s, 'A check-in was answered: all is well.', 'Family Hub: all is well', `${party.name} said all is well when the hub asked, so nothing was sent. Please open the hub when you can, so it knows you are there.${SIGN_OFF}`, 'emergency')
  await tellOthersAllIsWell(s, open, `${party.name} has said all is well`, party.id)
  return true
}

async function tellOthersAllIsWell(s: Services, release: ReleaseRow, who: string, except?: string) {
  if (!s.mail.configured) return
  const family = familyName(s)
  const asked = release.kind === 'request' ? allParties(s).filter((p) => p.id === release.party_id) : release.stage === 'asking' ? allParties(s) : []
  for (const p of asked.filter((x) => x.id !== except)) {
    await s.mail
      .send({ to: [p.email], subject: `${family}: all is well`, text: `Dear ${p.name},\n\n${who}: the emergency pack will not be sent. Thank you for looking out for them.${SIGN_OFF}` })
      .catch((e: unknown) => console.error('Emergency email failed', e))
  }
}

/** The pack to the guardians, and word to those to inform. True when the guardians' email went. */
async function sendPack(s: Services): Promise<boolean> {
  if (!s.mail.configured) return false
  const family = familyName(s)
  const parties = allParties(s)
  const guardians = parties.filter((p) => p.role === 'guardian')
  if (guardians.length === 0) return true
  const pack = s.db.prepare('SELECT pdf, made_at FROM emergency_pack WHERE id = 1').get() as { pdf: Uint8Array; made_at: number } | undefined
  const text = pack
    ? `This is the emergency pack the parents of ${family} prepared in their Family Hub, for you as a guardian of their children. It is attached as a PDF, made on ${when(s, pack.made_at)}.\n\nThe PDF is locked. The password is in the letter they gave you.\n\nIt holds their instructions and what you will need: the children’s health, ID numbers, medical aid, school, important contacts, the household and money, and where their documents are.${SIGN_OFF}`
    : `The parents of ${family} named you as a guardian of their children in their Family Hub, and asked it to send you their emergency pack. The pack had not been made yet, so nothing is attached: please contact the family’s other guardians and the people in their will.${SIGN_OFF}`
  try {
    await s.mail.send({
      to: guardians.map((g) => g.email),
      subject: `${family}: the emergency pack`,
      text,
      attachments: pack ? [{ filename: 'emergency-pack.pdf', contentType: 'application/pdf', content: pack.pdf }] : [],
    })
  } catch (e) {
    console.error('Sending the emergency pack failed (will try again)', e)
    return false
  }
  for (const p of parties.filter((x) => x.role === 'inform')) {
    await s.mail
      .send({ to: [p.email], subject: `${family}: the emergency pack was sent`, text: `Dear ${p.name},\n\nThe Family Hub of ${family} has sent their emergency pack to the children’s guardians: ${guardians.map((g) => g.name).join(', ')}. They asked for you to be told.${SIGN_OFF}` })
      .catch((e: unknown) => console.error('Emergency email failed', e))
  }
  return true
}

/** Emails each trusted party: is all well? With their own links to say so, or to request the pack. */
async function askParties(s: Services, release: ReleaseRow, deadline: number): Promise<void> {
  const family = familyName(s)
  const base = hubAddress(s)
  for (const p of allParties(s)) {
    const token = newToken()
    s.db.prepare('INSERT INTO emergency_asks (token_hash, release_id, party_id) VALUES (?, ?, ?)').run(hashToken(token), release.id, p.id)
    const link = base ? `${base}/emergency/${token}` : ''
    await s.mail
      .send({
        to: [p.email],
        subject: `${family}: is all well?`,
        text:
          `Dear ${p.name},\n\nNeither parent of ${family} has used their Family Hub for a while, and they have not answered its check-ins. You are one of the people they chose to ask.\n\n` +
          (link
            ? `If all is well (you have heard from them), say so here and nothing is sent:\n${link}\n\nIf something has happened, use the same link to ask for their emergency pack.\n\n`
            : 'If something has happened, use the link in the letter they gave you to ask for their emergency pack.\n\n') +
          `If nobody answers by ${when(s, deadline)}, the hub sends the pack to the children’s guardians.${SIGN_OFF}`,
      })
      .catch((e: unknown) => console.error('Emergency email failed', e))
  }
}

const running = new WeakSet<Services>()

/** Moves any release along, and starts the backstop when it is due. Safe to call often (every minute). */
export async function runEmergency(s: Services): Promise<void> {
  if (running.has(s)) return
  running.add(s)
  try {
    const now = s.now()
    const settings = releaseSettings(s)
    const activity = lastParentActivity(s)
    let open = openRelease(s)

    // Any parent's activity stops the backstop (but not a request: that needs a parent to cancel it).
    if (open?.kind === 'inactive' && open.stage !== 'sending' && activity > open.started_at) {
      end(s, open.id, 'cancelled', 'system', 'a parent used the hub')
      await tellOthersAllIsWell(s, open, 'The parents are back')
      open = undefined
    }

    // The backstop: only once it could send something (email set up, a guardian named).
    const ready = s.mail.configured && allParties(s).some((p) => p.role === 'guardian')
    if (!open && settings.backstop && ready && activity > 0 && now - activity >= settings.inactiveDays * DAY) {
      const last = lastRelease(s)
      // Not again for the same quiet spell (after one was cancelled by a trusted party, or sent).
      if (!last || last.started_at < activity) {
        const id = newId()
        s.db.prepare("INSERT INTO emergency_release (id, kind, stage, started_at, next_at) VALUES (?, 'inactive', 'checkin', ?, ?)").run(id, now, now)
        open = openRelease(s)
      }
    }
    if (!open || open.next_at === null || open.next_at > now) return

    switch (open.stage) {
      case 'waiting': {
        const sendAt = now + settings.confirmHours * HOUR
        setStage(s, open.id, 'confirming', sendAt)
        await tellParents(
          s,
          'The emergency pack will be sent soon. Open the hub to cancel.',
          'Family Hub: the emergency pack will be sent unless you cancel',
          `This is the second and last check. A trusted party asked for the emergency pack ${settings.requestWaitDays} day${settings.requestWaitDays === 1 ? '' : 's'} ago. It will be sent to the guardians on ${when(s, sendAt)} unless one of you cancels it in the Family Hub (Settings → In case of emergency).${SIGN_OFF}`,
          `emergency-${open.id}`,
        )
        return
      }
      case 'checkin': {
        if (open.checkins >= settings.checkinDays) {
          const deadline = now + settings.partyWaitDays * DAY
          setStage(s, open.id, 'asking', deadline)
          await askParties(s, open, deadline)
          return
        }
        s.db.prepare('UPDATE emergency_release SET checkins = checkins + 1, next_at = ? WHERE id = ?').run(now + DAY, open.id)
        await tellParents(
          s,
          'Are you all right? Open the hub to confirm.',
          'Family Hub: are you all right?',
          `Neither of you has used the Family Hub for ${settings.inactiveDays} days or more. Please open it (signing in is enough) to let it know you are there.\n\nIf nobody does, after ${settings.checkinDays} day${settings.checkinDays === 1 ? '' : 's'} of these check-ins the hub asks your trusted parties whether all is well, and then sends the emergency pack to the guardians.${SIGN_OFF}`,
          `emergency-checkin-${open.id}`,
        )
        return
      }
      case 'confirming':
      case 'asking':
        setStage(s, open.id, 'sending', now)
      // falls through
      case 'sending':
        if (await sendPack(s)) {
          end(s, open.id, 'sent', 'system', open.kind === 'request' ? 'requested, not cancelled' : 'nobody answered')
          await tellParents(s, 'The emergency pack was sent to the guardians.', 'Family Hub: the emergency pack was sent', `The emergency pack was sent to the guardians on ${when(s, now)}.${SIGN_OFF}`, `emergency-${open.id}`)
        } else s.db.prepare('UPDATE emergency_release SET next_at = ? WHERE id = ?').run(now + HOUR, open.id)
        return
    }
  } finally {
    running.delete(s)
  }
}
