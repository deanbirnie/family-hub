import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { Services } from './app.ts'
import { tx } from './db.ts'

export const TRASH_DAYS = 30
export const TRASH_MS = TRASH_DAYS * 24 * 60 * 60_000
const ORPHAN_GRACE = 24 * 60 * 60_000

/** Expire trash, then remove unreferenced blobs and interrupted upload parts. */
export async function maintainFiles(s: Services): Promise<void> {
  const cutoff = s.now() - TRASH_MS
  const expired = s.db.prepare("SELECT id FROM files WHERE kind = 'file' AND deleted_at <= ?").all(cutoff) as { id: string }[]
  tx(s.db, () => {
    // Independently deleted items remain recoverable if their old parent
    // expires first (for example after an older database has been restored).
    s.db.prepare('UPDATE files SET parent_id = NULL WHERE deleted_at > ? AND parent_id IN (SELECT id FROM files WHERE deleted_at <= ?)').run(cutoff, cutoff)
    s.db.prepare('DELETE FROM files WHERE deleted_at <= ?').run(cutoff)
  })
  const referenced = new Set((s.db.prepare("SELECT id FROM files WHERE kind = 'file'").all() as { id: string }[]).map((f) => f.id))
  const root = join(s.config.dataDir, 'files')
  for (const f of expired) await unlink(join(root, f.id)).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') console.error('Could not remove expired document', f.id, e.code) })
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !/^[a-f0-9-]{36}(\.part|\.enc)?$/.test(entry.name) || referenced.has(entry.name)) continue
    const path = join(root, entry.name)
    try {
      if ((await stat(path)).mtimeMs <= s.now() - ORPHAN_GRACE) await unlink(path)
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
}
