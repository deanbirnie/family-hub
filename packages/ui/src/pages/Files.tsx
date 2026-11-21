import { Download, FileText, FolderOpen, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { HubContext } from '../Shell.tsx'
import { Banner, Button, Card, PageHeader, Spinner, errorText, useAction, useLoad } from '../ui.tsx'

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
  const files = useLoad(() => api.get<{ items: DocumentItem[]; maxFileBytes: number }>('/api/files'), [api])
  const input = useRef<HTMLInputElement>(null)
  const controller = useRef<AbortController | null>(null)
  const [uploading, setUploading] = useState(false)
  const [progress, setProgress] = useState<{ name: string; percent: number } | null>(null)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [dragging, setDragging] = useState(false)
  useEffect(() => () => controller.current?.abort(), [])

  const upload = async (selected: File[]) => {
    if (uploading || !selected.length) return
    const abort = new AbortController()
    controller.current = abort
    setUploading(true); setError(''); setNotice('')
    let done = 0
    try {
      for (const file of selected) {
        if (abort.signal.aborted) break
        if (file.size > (files.data?.maxFileBytes ?? 0)) throw new Error(`${file.name} exceeds the upload size limit.`)
        setProgress({ name: file.name, percent: 0 })
        await api.upload(file, '', (percent) => setProgress({ name: file.name, percent }), abort.signal)
        done++
        files.reload()
      }
      if (done) setNotice(`${done} document${done === 1 ? '' : 's'} uploaded.`)
    } catch (e) { setError(errorText(e)) }
    finally { setUploading(false); setProgress(null); controller.current = null; if (input.current) input.current.value = '' }
  }
  const download = useAction(async (file: DocumentItem) => {
    if (ctx.platform.downloadFile) { await ctx.platform.downloadFile(file, 'save'); return }
    const blob = await api.fileBlob(file.id)
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = file.name; link.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  })

  return (
    <div className="page">
      <PageHeader title="Files" subtitle="Important documents, shared with your family." actions={<Button icon={<Upload size={16} />} onClick={() => input.current?.click()} disabled={uploading || !files.data}>Upload documents</Button>} />
      <input ref={input} className="visually-hidden" aria-label="Choose documents" type="file" multiple onChange={(e) => void upload(Array.from(e.target.files ?? []))} />
      {notice && <Banner kind="success" onClose={() => setNotice('')}>{notice}</Banner>}
      {(error || download.error || files.error) && <Banner kind="error">{error || download.error || files.error}</Banner>}
      {progress && <div className="file-upload" role="status"><span>Uploading {progress.name}</span><progress aria-label="Upload progress" max={100} value={progress.percent} /><Button variant="ghost" onClick={() => controller.current?.abort()}>Cancel upload</Button></div>}
      <Card className={`files-card ${dragging ? 'files-dragging' : ''}`}>
        <div onDragOver={(e) => { e.preventDefault(); setDragging(true) }} onDragLeave={() => setDragging(false)} onDrop={(e) => { e.preventDefault(); setDragging(false); void upload(Array.from(e.dataTransfer.files)) }}>
          <div className="files-toolbar"><h2><FolderOpen size={20} aria-hidden /> Family</h2><p className="muted small">Everyone in the family can use these documents.</p></div>
          {!files.data && !files.error && <Spinner />}
          {files.data?.items.length === 0 && <div className="empty"><FileText size={32} aria-hidden /><h3>No documents yet</h3><p>Upload important paperwork, PDFs or reference images.</p><p className="muted small">Drop documents here, or use Upload documents. Up to {fileSize(files.data.maxFileBytes)} per file.</p></div>}
          <ul className="document-list" aria-label="Family documents">
            {files.data?.items.map((f) => <li key={f.id}><FileText size={22} aria-hidden /><div className="document-main"><strong>{f.name}</strong><span className="muted small">{fileSize(f.size)} · {new Date(f.updatedAt).toLocaleDateString()}</span></div><Button variant="secondary" busy={download.busy} aria-label={`Download ${f.name}`} icon={<Download size={16} />} onClick={() => void download.run(f)}>Download</Button></li>)}
          </ul>
        </div>
      </Card>
    </div>
  )
}
