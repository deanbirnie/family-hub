/** Shared documents: existing full sessions grant access to the whole Family folder. */
import { randomUUID } from 'node:crypto'
import { createReadStream, mkdirSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { presentedToken, type Api, type AuthedCtx, type Services } from '../app.ts'
import { HttpError, readJson } from '../http.ts'
import { findSession, getUser } from '../sessions.ts'

export interface FileRow {
  id: string
  parent_id: string | null
  name: string
  kind: 'file' | 'folder'
  size: number
  media_type: string
  created_by: string
  created_at: number
  updated_at: number
}

export const fileInfo = (f: FileRow) => ({
  id: f.id, parentId: f.parent_id, name: f.name, kind: f.kind,
  size: f.size, mediaType: f.media_type, createdAt: f.created_at, updatedAt: f.updated_at,
})

export function fileName(raw: unknown): string {
  if (typeof raw !== 'string') throw new HttpError(400, 'Choose a file name.', 'invalid')
  const name = raw.trim().normalize('NFC')
  if (!name || name === '.' || name === '..' || /[\x00-\x1f\x7f/\\]/.test(name) || Buffer.byteLength(name) > 240) {
    throw new HttpError(400, 'Use a name of up to 240 bytes without slashes or control characters.', 'invalid')
  }
  return name
}

/** Only raster images and PDFs are eligible for an in-app preview. */
export function documentType(head: Buffer): string {
  if (head.subarray(0, 5).toString() === '%PDF-') return 'application/pdf'
  if (head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (/^GIF8[79]a/.test(head.subarray(0, 6).toString())) return 'image/gif'
  if (head.subarray(0, 4).toString() === 'RIFF' && head.subarray(8, 12).toString() === 'WEBP') return 'image/webp'
  return 'application/octet-stream'
}

export function fileRoutes(api: Api, s: Services): void {
  const root = join(s.config.dataDir, 'files')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const find = (id: string): FileRow => {
    const row = s.db.prepare('SELECT * FROM files WHERE id = ?').get(id) as unknown as FileRow | undefined
    if (!row) throw new HttpError(404, 'That document is no longer here.', 'not_found')
    return row
  }
  const parent = (id: string | null) => {
    if (id !== null && find(id).kind !== 'folder') throw new HttpError(400, 'Choose a folder.', 'invalid')
  }
  const unique = (parentId: string | null, name: string, except = '') => {
    if (s.db.prepare('SELECT id FROM files WHERE parent_id IS ? AND name = ? AND id != ?').get(parentId, name, except)) {
      throw new HttpError(409, 'A document or folder with that name already exists here.', 'name_conflict')
    }
  }
  const ancestors = (id: string | null) => {
    const chain: { id: string; name: string }[] = []
    const seen = new Set<string>()
    while (id) {
      if (seen.has(id) || chain.length >= 100) throw new HttpError(400, 'Folders can be nested at most 100 levels deep.', 'invalid')
      seen.add(id)
      const folder = find(id)
      chain.unshift({ id: folder.id, name: folder.name })
      id = folder.parent_id
    }
    return chain
  }
  const destination = (raw: unknown): string | null => {
    if (raw === null || raw === undefined || raw === '') return null
    if (typeof raw !== 'string') throw new HttpError(400, 'Choose a folder.', 'invalid')
    parent(raw)
    return raw
  }

  api.authed('GET', '/api/files', {}, (ctx) => {
    const parentId = ctx.url.searchParams.get('parent') || null
    parent(parentId)
    const q = (ctx.url.searchParams.get('q') || '').trim()
    if (q.length > 240) throw new HttpError(400, 'Search by a shorter name.', 'invalid')
    const items = (q
      ? s.db.prepare("SELECT * FROM files WHERE instr(lower(name), lower(?)) > 0 ORDER BY kind DESC, name COLLATE NOCASE, id").all(q)
      : s.db.prepare("SELECT * FROM files WHERE parent_id IS ? ORDER BY kind DESC, name COLLATE NOCASE, id").all(parentId)) as unknown as FileRow[]
    return { items: items.map(fileInfo), ancestors: ancestors(parentId), parentId, query: q, maxFileBytes: s.config.maxFileBytes }
  })

  api.authed('POST', '/api/files/folders', {}, async (ctx) => {
    const body = await readJson(ctx.req)
    const name = fileName(body.name)
    const parentId = destination(body.parentId)
    if (ancestors(parentId).length >= 100) throw new HttpError(400, 'This folder is nested too deeply.', 'invalid')
    unique(parentId, name)
    const id = randomUUID(), now = s.now()
    s.db.prepare("INSERT INTO files (id, parent_id, name, kind, created_by, created_at, updated_at) VALUES (?, ?, ?, 'folder', ?, ?, ?)").run(id, parentId, name, ctx.user.id, now, now)
    s.audit('files.folder_created', ctx, ctx.user.id, id)
    return { item: fileInfo(find(id)) }
  })

  api.authed('PATCH', '/api/files/:id', {}, async (ctx) => {
    const body = await readJson(ctx.req)
    const item = find(ctx.params.id!)
    const name = body.name === undefined ? item.name : fileName(body.name)
    const parentId = body.parentId === undefined ? item.parent_id : destination(body.parentId)
    const chain = ancestors(parentId)
    if (item.kind === 'folder' && (item.id === parentId || chain.some((f) => f.id === item.id))) {
      throw new HttpError(400, 'A folder cannot be moved inside itself.', 'folder_cycle')
    }
    // Account for the entire subtree when moving a deeply nested folder.
    const depth = s.db.prepare(`WITH RECURSIVE tree(id, depth) AS (SELECT ?, ? UNION ALL SELECT f.id, t.depth + 1 FROM files f JOIN tree t ON f.parent_id = t.id WHERE f.kind = 'folder') SELECT max(depth) AS depth FROM tree`).get(item.id, item.kind === 'folder' ? 1 : 0) as { depth: number }
    if (chain.length + depth.depth > 100) throw new HttpError(400, 'This move would nest folders too deeply.', 'invalid')
    unique(parentId, name, item.id)
    s.db.prepare('UPDATE files SET parent_id = ?, name = ?, updated_at = ? WHERE id = ?').run(parentId, name, s.now(), item.id)
    s.audit('files.updated', ctx, ctx.user.id, item.id)
    return { item: fileInfo(find(item.id)) }
  })

  // Raw request bodies keep uploads streaming and avoid a multipart dependency.
  api.authed('POST', '/api/files/upload', {}, async (ctx) => {
    const name = fileName(ctx.url.searchParams.get('name'))
    const parentId = ctx.url.searchParams.get('parent') || null
    parent(parentId)
    unique(parentId, name)
    const declared = Number(ctx.req.headers['content-length'] ?? 0)
    if (declared > s.config.maxFileBytes) {
      ctx.res.setHeader('Connection', 'close')
      throw new HttpError(413, 'This file exceeds the upload size limit.', 'too_large')
    }
    const id = randomUUID()
    const partial = join(root, `${id}.part`)
    const target = join(root, id)
    let complete = false
    let moved = false
    try {
      const out = await open(partial, 'wx', 0o600)
      let size = 0
      let head = Buffer.alloc(0)
      try {
        for await (const chunk of ctx.req.iterator({ destroyOnReturn: false })) {
          if (head.length < 16) head = Buffer.concat([head, (chunk as Buffer).subarray(0, 16 - head.length)])
          size += (chunk as Buffer).length
          if (size > s.config.maxFileBytes) {
            ctx.res.setHeader('Connection', 'close')
            throw new HttpError(413, 'This file exceeds the upload size limit.', 'too_large')
          }
          await out.writeFile(chunk as Buffer)
        }
        await out.sync()
      } finally {
        await out.close()
      }
      // A revoked/expired session or a moved/deleted destination during an
      // upload must not leave a newly committed document behind.
      const token = presentedToken(s, ctx)
      const session = token && findSession(s.db, token.token, token.transport, s.now())
      const user = getUser(s.db, ctx.user.id)
      if (!session || session.stage !== 'full' || !user || user.disabled) throw new HttpError(401, 'Please sign in.', 'unauthenticated')
      parent(parentId)
      unique(parentId, name)
      await rename(partial, target)
      moved = true
      // Recheck after the filesystem await; other requests can create names.
      if (!token || !findSession(s.db, token.token, token.transport, s.now())) throw new HttpError(401, 'Please sign in.', 'unauthenticated')
      parent(parentId)
      unique(parentId, name)
      const now = s.now()
      s.db.prepare('INSERT INTO files (id, parent_id, name, kind, size, media_type, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, parentId, name, 'file', size, documentType(head), ctx.user.id, now, now)
      complete = true
      s.audit('files.uploaded', ctx, ctx.user.id, id)
      return { item: fileInfo(find(id)) }
    } finally {
      if (!complete) await unlink(moved ? target : partial).catch(() => undefined)
    }
  })

  api.authed('GET', '/api/files/:id/content', {}, async (ctx: AuthedCtx) => {
    const f = find(ctx.params.id!)
    if (f.kind !== 'file') throw new HttpError(400, 'Choose a document.', 'invalid')
    // Open before sending headers, so a missing disk file is a useful error.
    let handle
    try { handle = await open(join(root, f.id), 'r') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new HttpError(404, 'The document contents are missing. Restore them from a backup.', 'missing_content')
      throw e
    }
    try {
      const preview = ctx.url.searchParams.get('preview') === '1'
      const head = Buffer.alloc(16)
      const { bytesRead } = await handle.read(head, 0, 16, 0)
      const type = documentType(head.subarray(0, bytesRead))
      if (preview && type === 'application/octet-stream') throw new HttpError(415, 'Download this document to open it.', 'no_preview')
      ctx.res.setHeader('Content-Type', preview ? type : 'application/octet-stream')
      ctx.res.setHeader('Content-Disposition', `attachment; filename="document"; filename*=UTF-8''${encodeURIComponent(f.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`)
      ctx.res.setHeader('Content-Length', f.size)
      ctx.res.setHeader('Cache-Control', 'no-store')
      ctx.res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
      if (ctx.method === 'HEAD') ctx.res.end()
      else await pipeline(createReadStream('', { fd: handle.fd, autoClose: false, start: 0 }), ctx.res)
    } finally { await handle.close() }
  })
}
