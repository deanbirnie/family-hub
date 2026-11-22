import { ArrowRight, ShieldCheck, Users } from 'lucide-react'
import { greeting, initials } from '../format.ts'
import { MODULES } from '../modules.ts'
import { href, navigate } from '../router.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Card, useLoad } from '../ui.tsx'

interface Member {
  id: string
  displayName: string
  role: 'admin' | 'member'
  disabled: boolean
  twoFactor: boolean
}

export function HomePage({ ctx }: { ctx: HubContext }) {
  const members = useLoad(() => ctx.platform.api.get<{ members: Member[] }>('/api/members'), [])
  const active = members.data?.members.filter((m) => !m.disabled) ?? []
  const firstName = ctx.user.displayName.split(/\s+/)[0]

  return (
    <div className="page">
      <div className="hero">
        <p className="eyebrow">{ctx.familyName}</p>
        <h1>
          {greeting()}, {firstName}
        </h1>
        <p className="muted">Everything the family shares, in one private place on your own server.</p>
      </div>

      <h2 className="section-title">Your hub</h2>
      <div className="module-grid">
        {MODULES.map((m) => {
          const open = m.status !== 'planned'
          return (
            <a
              key={m.id}
              href={href(m.path)}
              className={`module-card ${open ? '' : 'module-card-planned'}`}
              onClick={(e) => {
                e.preventDefault()
                navigate(m.path)
              }}
            >
              <span className={`module-icon module-icon-${m.id}`} aria-hidden>
                <m.icon size={22} />
              </span>
              <span className="module-body">
                <span className="module-name">
                  {m.name}
                  {m.status === 'ready' ? null : m.status === 'next' ? <Badge tone="accent">Coming next</Badge> : <Badge>Phase {m.phase}</Badge>}
                </span>
                <span className="module-desc">{m.description}</span>
              </span>
            </a>
          )
        })}
      </div>

      <div className="grid-2">
        <Card
          title={
            <>
              <Users size={18} aria-hidden /> Family
            </>
          }
          actions={
            <button className="link" onClick={() => navigate('/family')}>
              Manage <ArrowRight size={14} aria-hidden />
            </button>
          }
        >
          <ul className="people">
            {active.map((m) => (
              <li key={m.id}>
                <span className="avatar" aria-hidden>
                  {initials(m.displayName)}
                </span>
                <span>{m.displayName}</span>
                {m.role === 'admin' && <Badge>Parent</Badge>}
              </li>
            ))}
          </ul>
          {active.length === 1 && <p className="muted">It’s just you so far. Invite the rest of the family from the Family page.</p>}
        </Card>
        <Card
          title={
            <>
              <ShieldCheck size={18} aria-hidden /> Security
            </>
          }
          actions={
            <button className="link" onClick={() => navigate('/settings')}>
              Settings <ArrowRight size={14} aria-hidden />
            </button>
          }
        >
          <p>
            Everyone signs in with a password and a code from an authenticator app. On Android, the app opens only with your fingerprint or face.
          </p>
          <p className="muted">
            {members.data ? `${active.filter((m) => m.twoFactor).length} of ${active.length} family members have two-factor sign-in set up.` : ' '}
          </p>
        </Card>
      </div>
    </div>
  )
}
