/** Small pieces shared by the Money, Budget and Home & car forms. */
import { Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { ApiError } from '../api.ts'
import { Button } from '../ui.tsx'

export function Labelled({ id, label, hint, children }: { id: string; label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  )
}

export function Actions({ busy, onCancel, onDelete, deleting, submit = 'Save' }: { busy: boolean; onCancel: () => void; onDelete?: () => void; deleting?: boolean; submit?: string }) {
  return (
    <div className="row">
      <Button type="submit" busy={busy}>
        {submit}
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
      {onDelete && (
        <Button type="button" variant="danger" icon={<Trash2 size={16} aria-hidden />} busy={deleting} onClick={onDelete}>
          Delete
        </Button>
      )}
    </div>
  )
}

export const conflict = (e: unknown) => {
  if (e instanceof ApiError && e.code === 'edit_conflict') throw new Error(`${e.message} Your changes were not saved.`)
  throw e
}

