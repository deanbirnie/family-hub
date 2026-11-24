import { useEffect, useRef, useState } from 'react'
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type RenderTask } from 'pdfjs-dist'
import type { Api } from '../api.ts'
import { Banner, Button, Dialog, Spinner, errorText } from '../ui.tsx'
import type { DocumentItem } from './Files.tsx'

GlobalWorkerOptions.workerSrc = new URL('/pdf-assets/pdf.worker.js', location.origin).href

export default function DocumentPreview({ api, file, onClose, onDownload }: { api: Api; file: DocumentItem; onClose: () => void; onDownload: () => void }) {
  const [blob, setBlob] = useState<Blob | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    api.fileBlob(file.id, true, controller.signal).then(setBlob, (e) => { if (!controller.signal.aborted) setError(errorText(e)) })
    return () => controller.abort()
  }, [api, file.id])
  return <Dialog open title={file.name} onClose={onClose}><div className="document-preview stack">
    {!blob && !error && <Spinner label="Loading preview…" />}
    {error && <Banner kind="error">{error}</Banner>}
    {blob && (blob.type === 'application/pdf' ? <PdfPreview blob={blob} /> : <ImagePreview blob={blob} name={file.name} />)}
    <Button variant="secondary" onClick={onDownload}>Download document</Button>
  </div></Dialog>
}

function ImagePreview({ blob, name }: { blob: Blob; name: string }) {
  const [url, setUrl] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => { const next = URL.createObjectURL(blob); setUrl(next); return () => URL.revokeObjectURL(next) }, [blob])
  return failed ? <Banner kind="error">This image could not be previewed. Try downloading it.</Banner> : url && <img className="document-image" src={url} alt={name} onError={() => setFailed(true)} />
}

export function PdfPreview({ blob }: { blob: Blob }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [number, setNumber] = useState(1)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  const [text, setText] = useState('')
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let live = true
    let loading: ReturnType<typeof getDocument> | undefined
    void blob.arrayBuffer().then((data) => {
      if (!live) return
      const assets = new URL('/pdf-assets/', location.origin).href
      loading = getDocument({ data: new Uint8Array(data), cMapUrl: `${assets}cmaps/`, cMapPacked: true,
        standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`,
        useWasm: false, disableFontFace: true, useSystemFonts: true,
        maxImageSize: 16_777_216, enableXfa: false, disableWorkerRendering: true })
      return loading.promise.then((doc) => { if (live) setPdf(doc) })
    }).catch((e) => { if (live) { setError(errorText(e)); setBusy(false) } })
    return () => { live = false; void loading?.destroy().catch(() => undefined) }
  }, [blob])
  useEffect(() => {
    if (!pdf || !canvas.current) return
    let live = true
    let render: RenderTask | undefined
    setBusy(true); setText(''); setError('')
    void pdf.getPage(number).then(async (page) => {
      if (!live || !canvas.current) return
      const original = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: Math.min(2, 1600 / original.width, 2400 / original.height) })
      const target = canvas.current
      target.width = Math.ceil(viewport.width); target.height = Math.ceil(viewport.height)
      render = page.render({ canvas: target, viewport })
      await render.promise
      const content = await page.getTextContent()
      if (live) { setText(content.items.map((item) => 'str' in item ? item.str : '').join(' ')); setBusy(false) }
    }).catch((e) => { if (live) { setError(errorText(e)); setBusy(false) } })
    return () => { live = false; render?.cancel() }
  }, [pdf, number])
  return <div className="stack">
    {pdf && <div className="files-toolbar"><Button variant="secondary" disabled={number <= 1 || busy} onClick={() => setNumber((n) => n - 1)}>Previous page</Button><span role="status">Page {number} of {pdf.numPages}</span><Button variant="secondary" disabled={number >= pdf.numPages || busy} onClick={() => setNumber((n) => n + 1)}>Next page</Button></div>}
    {busy && !error && <Spinner label="Rendering PDF…" />}
    {error && <Banner kind="error">This PDF could not be previewed: {error}. Try downloading it.</Banner>}
    <canvas ref={canvas} className="pdf-page" aria-label={`PDF page ${number}`} role="img" hidden={busy || !!error} />
    <p className="visually-hidden">{text}</p>
  </div>
}
