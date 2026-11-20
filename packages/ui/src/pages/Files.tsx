/**
 * Shared file storage arrives in phase 1 (docs/ROADMAP.md). Until then this
 * page shows what it will do, so the menu and layout are already in place.
 */
import { FolderOpen, History, Lock, Share2, Smartphone, Upload } from 'lucide-react'
import type { HubContext } from '../Shell.tsx'
import { Badge, Card, PageHeader } from '../ui.tsx'

const PLANNED = [
  { icon: Upload, title: 'Upload anything', text: 'Drag files in on a computer or share them from your phone’s gallery and other apps.' },
  { icon: FolderOpen, title: 'Family and private folders', text: 'Shared folders for everyone, and a private space for each person.' },
  { icon: Smartphone, title: 'Previews on the go', text: 'Photos and PDFs open right in the app; download anything else.' },
  { icon: History, title: 'Undo mistakes', text: 'Deleted files go to a recycle bin for 30 days before they are gone.' },
  { icon: Lock, title: 'Stays at home', text: 'Files live on your server’s disk, never on someone else’s cloud.' },
  { icon: Share2, title: 'Easy to back up', text: 'Plain folders on disk, so your normal backup picks them up.' },
]

export function FilesPage({ ctx }: { ctx: HubContext }) {
  void ctx
  return (
    <div className="page">
      <PageHeader title="Files" subtitle="The family’s shared documents and photos." actions={<Badge tone="accent">Coming next</Badge>} />
      <Card>
        <div className="empty empty-inline">
          <span className="module-icon module-icon-files module-icon-large" aria-hidden>
            <FolderOpen size={32} />
          </span>
          <h2>Shared file storage is being built</h2>
          <p className="muted">It is the first feature on the roadmap. Here is what it will do:</p>
        </div>
        <ul className="feature-list">
          {PLANNED.map((f) => (
            <li key={f.title}>
              <f.icon size={20} aria-hidden />
              <div>
                <strong>{f.title}</strong>
                <p className="muted">{f.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  )
}
