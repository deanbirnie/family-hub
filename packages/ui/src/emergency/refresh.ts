/**
 * Keeping the emergency pack up to date (9b): whenever a parent's family
 * vault is open, the pack is remade on that device and uploaded locked, at
 * most once a day unless something asks for it (saving the instructions,
 * "Refresh now"). It needs the pack's password, kept end-to-end encrypted
 * with the family key.
 */
import type { Api } from '../api.ts'
import { vault } from '../vault/store.ts'
import { makePack, openSecret } from './pack.ts'

const DAY = 86_400_000

/** Base64 of a large file, a piece at a time (spreading the whole file into one call would overflow the stack). */
export function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
let running: Promise<'made' | 'skipped'> | null = null

interface Status {
  password: { ciphertext: string } | null
  pack: { madeAt: number } | null
}

/** Remakes the pack if it is due (or `force`); resolves to what happened. Never runs twice at once. */
export function refreshPack(api: Api, madeBy: string, opts: { force?: boolean; now?: number } = {}): Promise<'made' | 'skipped'> {
  if (running) return running
  running = (async () => {
    const key = vault.use()
    if (!key) return 'skipped' as const
    const status = await api.get<Status>('/api/emergency')
    if (!status.password) return 'skipped' as const
    const now = opts.now ?? Date.now()
    if (!opts.force && status.pack && now - status.pack.madeAt < DAY) return 'skipped' as const
    const password = await openSecret<string>(key, 'password', status.password.ciphertext)
    const pdf = await makePack(api, key, madeBy, password)
    await api.request('PUT', '/api/emergency/pack', { pdf: base64(pdf) })
    return 'made' as const
  })().finally(() => {
    running = null
  })
  return running
}
