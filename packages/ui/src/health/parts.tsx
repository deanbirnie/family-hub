/** Pieces shared by the Health page and Episodes: form fields and linked documents. */
import { FileText, Paperclip, Upload } from 'lucide-react'
import { useState } from 'react'
import type { Contact } from '../pages/Contacts.tsx'
import type { HubContext } from '../Shell.tsx'
import { Banner, Button, useAction } from '../ui.tsx'
import type { FieldDef, LinkedDocument } from './model.ts'

export function Documents({ ctx, documents }: { ctx: HubContext; documents: LinkedDocument[] }) {
  const open = useAction(async (d: LinkedDocument) => {
    if (ctx.platform.downloadFile) return ctx.platform.downloadFile({ id: d.id, name: d.name, mediaType: 'application/octet-stream' }, 'open')
    const blob = await ctx.platform.api.fileBlob(d.id)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = d.name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  })
  return (
    <div className="row">
      {documents.map((d) => (
        <Button key={d.id} variant="secondary" icon={<FileText size={16} aria-hidden />} onClick={() => void open.run(d)}>
          {d.name}
        </Button>
      ))}
      {open.error && <Banner kind="error">{open.error}</Banner>}
    </div>
  )
}

export function FieldInput({ def, value, onChange, contacts }: { def: FieldDef; value: string; onChange: (v: string) => void; contacts: Contact[] }) {
  const id = `hf-${def.key}`
  if (def.type === 'checkbox') {
    return (
      <label className="check">
        <input type="checkbox" checked={value === 'yes'} onChange={(e) => onChange(e.target.checked ? 'yes' : '')} />
        <span>{def.label}</span>
      </label>
    )
  }
  const control =
    def.type === 'textarea' ? (
      <textarea id={id} className="textarea" rows={3} maxLength={4000} placeholder={def.placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
    ) : def.type === 'select' ? (
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {def.options!.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    ) : def.type === 'contact' ? (
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)} required={def.required}>
        <option value="">{def.required ? 'Choose…' : 'None'}</option>
        {contacts.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    ) : (
      <input
        id={id}
        className="qi-search"
        type={def.type === 'date' ? 'date' : def.type === 'datetime' ? 'datetime-local' : def.type === 'time' ? 'time' : def.type === 'number' ? 'number' : 'text'}
        min={def.type === 'number' ? 0 : undefined}
        step={def.type === 'number' ? 'any' : undefined}
        maxLength={200}
        placeholder={def.placeholder}
        required={def.required}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  return (
    <div className="field">
      <label htmlFor={id}>{def.label}</label>
      {control}
      {def.hint && <div className="field-hint">{def.hint}</div>}
    </div>
  )
}

/** Link documents from the parents-only Health folder in Files, or upload one into it. */
export function AttachDocuments({ ctx, documents, onChange }: { ctx: HubContext; documents: LinkedDocument[]; onChange: (d: LinkedDocument[]) => void }) {
  const { api } = ctx.platform
  const [picking, setPicking] = useState<{ id: string; name: string }[] | null>(null)
  const folder = async () => (await api.get<{ folderId: string }>('/api/health/folder')).folderId
  const upload = useAction(async (file: File) => {
    const parent = await folder()
    const res = await fetch(`${api.baseUrl}/api/files/upload?${new URLSearchParams({ name: file.name, parent })}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Requested-With': 'family-hub', ...(api.token ? { Authorization: `Bearer ${api.token}` } : {}) },
      body: file,
    })
    const body = (await res.json().catch(() => ({}))) as { item?: { id: string; name: string }; message?: string }
    if (!res.ok || !body.item) throw new Error(body.message ?? 'The upload failed.')
    onChange([...documents, { id: body.item.id, name: body.item.name }])
  })
  const pick = useAction(async () => {
    const r = await api.get<{ items: { id: string; name: string; kind: string }[] }>(`/api/files?parent=${encodeURIComponent(await folder())}`)
    setPicking(r.items.filter((i) => i.kind === 'file'))
  })
  return (
    <fieldset className="radio-group">
      <legend>Documents</legend>
      {documents.map((d) => (
        <div key={d.id} className="row">
          <FileText size={16} aria-hidden /> {d.name}
          <Button type="button" variant="ghost" aria-label={`Unlink ${d.name}`} onClick={() => onChange(documents.filter((x) => x.id !== d.id))}>
            Remove
          </Button>
        </div>
      ))}
      <div className="row">
        <label className="btn btn-secondary file-pick">
          <Upload size={16} aria-hidden />
          <span>{upload.busy ? 'Uploading…' : 'Upload to the Health folder'}</span>
          <input
            type="file"
            aria-label="Upload a health document"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void upload.run(f)
            }}
          />
        </label>
        <Button type="button" variant="ghost" icon={<Paperclip size={16} aria-hidden />} busy={pick.busy} onClick={() => void pick.run()}>
          Link one already there
        </Button>
      </div>
      {picking && (
        <div className="stack-sm">
          {picking.length === 0 && <p className="muted small">The Health folder is empty.</p>}
          {picking
            .filter((f) => !documents.some((d) => d.id === f.id))
            .map((f) => (
              <button key={f.id} type="button" className="link" onClick={() => (onChange([...documents, f]), setPicking(null))}>
                {f.name}
              </button>
            ))}
        </div>
      )}
      <p className="muted small">Documents are kept in Files, in a Health folder only parents can open.</p>
      {(upload.error || pick.error) && <Banner kind="error">{upload.error || pick.error}</Banner>}
    </fieldset>
  )
}
