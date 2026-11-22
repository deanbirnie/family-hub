/**
 * Getting the server key into a password manager, from inside the app.
 *
 * Without a copy of the server key, a backup cannot be restored, so until a
 * parent confirms they have saved it, every parent sees a reminder. A parent
 * can show the key after entering a fresh authenticator code (a session alone
 * is not enough), and every showing is recorded in the security log.
 *
 * Showing the key to a parent does not widen what a parent can already read:
 * a signed-in parent can open every document. It lets them do what the key is
 * for: restore a backup on a new machine.
 */
import type { Api, Services } from '../app.ts'
import { readJson } from '../http.ts'
import { requireFreshCode } from '../step-up.ts'

const SAVED_SETTING = 'server_key_saved'

export function serverKeyRoutes(api: Api, s: Services): void {
  const { db } = s
  const saved = () => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SAVED_SETTING) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as { at: number; by: string }) : null
  }

  api.authed('GET', '/api/server-key', { admin: true }, () => {
    const at = saved()
    return { saved: at !== null, savedAt: at?.at ?? null }
  })

  api.authed('POST', '/api/server-key/reveal', { admin: true }, async (ctx) => {
    const body = await readJson(ctx.req)
    requireFreshCode(s, ctx, body.code, 'server_key.reveal_failed')
    s.audit('server_key.revealed', ctx, ctx.user.id)
    return { key: s.serverKey.exportKey(), file: s.config.keyFile }
  })

  api.authed('POST', '/api/server-key/saved', { admin: true }, (ctx) => {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
      SAVED_SETTING,
      JSON.stringify({ at: s.now(), by: ctx.user.id }),
    )
    s.audit('server_key.saved', ctx, ctx.user.id)
    return { saved: true, savedAt: s.now() }
  })
}
