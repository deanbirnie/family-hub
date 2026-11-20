import type { HubModule } from '../modules.ts'
import { Badge } from '../ui.tsx'

export function ComingSoon({ module }: { module: HubModule }) {
  return (
    <div className="page">
      <div className="empty">
        <span className={`module-icon module-icon-${module.id} module-icon-large`} aria-hidden>
          <module.icon size={32} />
        </span>
        <h1>{module.name}</h1>
        <p className="muted">{module.description}</p>
        <Badge tone={module.status === 'next' ? 'accent' : 'neutral'}>
          {module.status === 'next' ? 'Being built now' : `Planned for phase ${module.phase}`}
        </Badge>
      </div>
    </div>
  )
}
