import { useState } from 'react'
import type { Api } from '../api.ts'
import { Banner, Button, Dialog, Field, Spinner, useAction, useLoad } from '../ui.tsx'
import type { DocumentItem } from './Files.tsx'

export interface FileList {
  items: DocumentItem[]
  ancestors: { id: string; name: string }[]
  parentId: string | null
  query: string
  maxFileBytes: number
}

export function NameDialog({ title, initial = '', onSave, onClose }: { title: string; initial?: string; onSave: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial)
  const action = useAction(async () => { await onSave(name); onClose() })
  return <Dialog open title={title} onClose={onClose}><form className="stack" onSubmit={(e) => { e.preventDefault(); void action.run() }}>
    <Field label="Name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={240} autoFocus />
    {action.error && <Banner kind="error">{action.error}</Banner>}
    <Button type="submit" busy={action.busy}>Save</Button>
  </form></Dialog>
}

export function MoveDialog({ api, item, onDone, onClose }: { api: Api; item: DocumentItem; onDone: () => void; onClose: () => void }) {
  const [folder, setFolder] = useState('')
  const listing = useLoad(() => api.get<FileList>(`/api/files?${new URLSearchParams({ parent: folder })}`), [api, folder])
  const data = listing.data?.parentId === (folder || null) ? listing.data : null
  const action = useAction(async () => {
    await api.patch(`/api/files/${item.id}`, { parentId: folder || null })
    onDone(); onClose()
  })
  return <Dialog open title={`Move ${item.name}`} onClose={onClose}><div className="stack">
    <p>Choose a destination folder.</p>
    <nav className="file-breadcrumbs" aria-label="Move destination"><button className="link" onClick={() => setFolder('')}>Family</button>{data?.ancestors.map((f) => <button className="link" key={f.id} onClick={() => setFolder(f.id)}>{f.name}</button>)}</nav>
    {listing.error && <Banner kind="error">{listing.error}</Banner>}
    {!data && !listing.error && <Spinner />}
    <ul className="folder-choices">{data?.items.filter((f) => f.kind === 'folder' && f.id !== item.id).map((f) => <li key={f.id}><Button variant="secondary" onClick={() => setFolder(f.id)}>{f.name}</Button></li>)}</ul>
    {data && !data.items.some((f) => f.kind === 'folder' && f.id !== item.id) && <p className="muted">No subfolders here.</p>}
    {action.error && <Banner kind="error">{action.error}</Banner>}
    <Button busy={action.busy} disabled={!data || (folder || null) === item.parentId} onClick={() => void action.run()}>Move here</Button>
  </div></Dialog>
}
