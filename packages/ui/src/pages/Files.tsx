import { Download, FileText, FolderOpen, FolderPlus, Upload } from 'lucide-react'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { HubContext } from '../Shell.tsx'
import { Banner, Button, Card, PageHeader, Spinner, errorText, useAction, useLoad } from '../ui.tsx'
import { MoveDialog, NameDialog, type FileList } from './FileDialogs.tsx'

const DocumentPreview = lazy(() => import('./DocumentPreview.tsx'))
const previewable = (f: DocumentItem) => /^(application\/pdf|image\/(png|jpeg|gif|webp))$/.test(f.mediaType) || /\.(pdf|png|jpe?g|gif|webp)$/i.test(f.name)

export interface DocumentItem {
  id: string
  parentId: string | null
  name: string
  kind: 'file' | 'folder'
  size: number
  mediaType: string
  createdAt: number
  updatedAt: number
}

export const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`

export function FilesPage({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const [folder, setFolder] = useState('')
  const [search, setSearch] = useState('')
  const [query, setQuery] = useState('')
  const [dialog, setDialog] = useState<{ kind: 'new' } | { kind: 'rename' | 'move'; item: DocumentItem } | null>(null)
  const [preview, setPreview] = useState<DocumentItem | null>(null)
  const files = useLoad(() => api.get<FileList>(`/api/files?${new URLSearchParams({ parent: folder, q: query })}`), [api, folder, query])
  const data = files.data?.parentId === (folder || null) && files.data.query === query ? files.data : null
  const browse = (id: string) => { setFolder(id); setQuery(''); setSearch(''); setError(''); setNotice('') }
  const input = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  useEffect(() => () => controller.current?.abort(), [])

  const upload = async (selected: File[]) => {
    if (uploading || !data || query || !selected.length) return
    const abort = new AbortController()
    controller.current = abort
    setUploading(true); setError(''); setNotice('')
    let done = 0
    try {
      for (const file of selected) {
        if (abort.signal.aborted) break
        if (file.size > data.maxFileBytes) throw new Error(`${file.name} exceeds the upload size limit.`)
        setProgress({ name: file.name, percent: 0 })
        await api.upload(file, folder, (percent) => setProgress({ name: file.name, percent }), abort.signal)
        done++
        files.reload()
      }
      if (done) setNotice(`${done} document${done === 1 ? '' : 's'} uploaded.`)
    } catch (e) { setError(errorText(e)) }
    finally { setUploading(false); setProgress(null); controller.current = null; if (input.current) input.current.value = '' }
  }
  const download = useAction(async (file: DocumentItem, action: 'save' | 'open' = 'save') => {
    if (ctx.platform.downloadFile) { await ctx.platform.downloadFile(file, action); return }
    const blob = await api.fileBlob(file.id)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = file.name; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  })

  return (
    <div className="page">
      <PageHeader title="Files" subtitle="Important documents, shared with your family." actions={<><Button variant="secondary" icon={<FolderPlus size={16} />} onClick={() => setDialog({ kind: 'new' })} disabled={uploading || !data || !!query}>New folder</Button><Button icon={<Upload size={16} />} onClick={() => input.current?.click()} disabled={uploading || !data || !!query}>Upload documents</Button></>} />
      <input ref={input} className="visually-hidden" aria-label="Choose documents" type="file" multiple onChange={(e) => void upload(Array.from(e.target.files ?? []))} />
      {notice && <Banner kind="success" onClose={() => setNotice('')}>{notice}</Banner>}
      {(error || download.error || files.error) && <Banner kind="error">{error || download.error || files.error}</Banner>}
      {progress && <div className="file-upload" role="status"><span>Uploading {progress.name}</span><progress aria-label="Upload progress" max={100} value={progress.percent} /><Button variant="ghost" onClick={() => controller.current?.abort()}>Cancel upload</Button></div>}
      <Card className={`files-card ${dragging ? 'files-dragging' : ''}`}>
        <div onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); void upload(Array.from(e.dataTransfer.files)) }}>
          <div className="files-toolbar"><nav className="file-breadcrumbs" aria-label="Folder path"><button className="link" onClick={() => browse('')} disabled={uploading}><FolderOpen size={18} aria-hidden />Family</button>{data?.ancestors.map((f) => <button className="link" key={f.id} onClick={() => browse(f.id)} disabled={uploading}>{f.name}</button>)}</nav><p className="muted small">Everyone in the family can manage these documents.</p></div>
          <form className="file-search" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()) }}><label className="visually-hidden" htmlFor="document-search">Search documents</label><input id="document-search" type="search" value={search} maxLength={240} placeholder="Search all family documents" onChange={(e) => setSearch(e.target.value)} /><Button variant="secondary" type="submit" disabled={uploading}>Search</Button>{query && <Button variant="ghost" onClick={() => { setQuery(''); setSearch('') }}>Clear search</Button>}</form>
          {!data && !files.error && <Spinner />}
          {data?.items.length === 0 && <div className="empty"><FileText size={32} aria-hidden /><h3>{query ? 'No matching documents' : 'No documents yet'}</h3><p>{query ? 'Try another filename.' : 'Upload important paperwork, PDFs or reference images.'}</p>{!query && <p className="muted small">Drop documents here, or use Upload documents. Up to {fileSize(data.maxFileBytes)} per file.</p>}</div>}
          <ul className="document-list" aria-label="Family documents">
            {data?.items.map((f) => <li key={f.id}>
              {f.kind === 'folder' ? <FolderOpen size={22} aria-hidden /> : <FileText size={22} aria-hidden />}
              <div className="document-main"><button className="link document-name" disabled={uploading} onClick={() => { if (f.kind === 'folder') browse(f.id); else if (previewable(f)) setPreview(f); else void download.run(f) }}>{f.name}</button><span className="muted small">{f.kind === 'folder' ? 'Folder' : fileSize(f.size)} · {new Date(f.updatedAt).toLocaleDateString()}</span>{query && <button className="link small" onClick={() => browse(f.parentId || '')}>Show in folder</button>}</div>
              <div className="document-actions">
                {f.kind === 'file' && <Button variant="secondary" busy={download.busy} aria-label={`Download ${f.name}`} icon={<Download size={16} />} onClick={() => void download.run(f)}>Download</Button>}
                {f.kind === 'file' && !previewable(f) && ctx.platform.downloadFile && <Button variant="ghost" aria-label={`Open ${f.name}`} onClick={() => void download.run(f, 'open')}>Open</Button>}
                <Button variant="ghost" aria-label={`Rename ${f.name}`} onClick={() => setDialog({ kind: 'rename', item: f })}>Rename</Button>
                <Button variant="ghost" aria-label={`Move ${f.name}`} onClick={() => setDialog({ kind: 'move', item: f })}>Move</Button>
              </div>
            </li>)}
          </ul>
        </div>
      </Card>
      {dialog?.kind === 'new' && <NameDialog title="New folder" onClose={() => setDialog(null)} onSave={async (name) => { await api.post('/api/files/folders', { name, parentId: folder || null }); files.reload() }} />}
      {dialog?.kind === 'rename' && <NameDialog title={`Rename ${dialog.item.name}`} initial={dialog.item.name} onClose={() => setDialog(null)} onSave={async (name) => { await api.patch(`/api/files/${dialog.item.id}`, { name }); files.reload() }} />}
      {dialog?.kind === 'move' && <MoveDialog api={api} item={dialog.item} onClose={() => setDialog(null)} onDone={files.reload} />}
      {preview && <Suspense fallback={<Spinner label="Opening preview…" />}><DocumentPreview key={preview.id} api={api} file={preview} onClose={() => setPreview(null)} onDownload={() => void download.run(preview)} /></Suspense>}
    </div>
  )
}
