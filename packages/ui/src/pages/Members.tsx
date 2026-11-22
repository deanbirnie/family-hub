/** The family: members, their roles, and invites (parents). */
import { MailPlus, ShieldAlert, ShieldCheck, Trash2, UserCog } from 'lucide-react'
import { useState } from 'react'
import { CopyButton } from '../auth/screens.tsx'
import { formatDate, initials } from '../format.ts'
import type { HubContext } from '../Shell.tsx'
import { Badge, Banner, Button, Card, Dialog, Field, PageHeader, Spinner, useAction, useLoad } from '../ui.tsx'

interface Member {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'member'
  disabled: boolean
  twoFactor: boolean
  createdAt: number
  self: boolean
}

interface Invite {
  id: string
  displayName: string
  role: 'admin' | 'member'
  expiresAt: number
}

/** Where invite links point: this site in a browser, the server the app talks to on Android. */
function inviteLink(ctx: HubContext, token: string): string {
  const base = ctx.platform.kind === 'web' ? window.location.origin : (ctx.platform.serverUrl ?? '')
  return `${base.replace(/\/+$/, '')}/invite/${token}`
}

export function MembersPage({ ctx }: { ctx: HubContext }) {
  const { api } = ctx.platform
  const isAdmin = ctx.user.role === 'admin'
  const members = useLoad(() => api.get<{ members: Member[] }>('/api/members'), [])
  const invites = useLoad(() => (isAdmin ? api.get<{ invites: Invite[] }>('/api/invites') : Promise.resolve({ invites: [] })), [isAdmin])
  const [inviteOpen, setInviteOpen] = useState(false)
  const [managing, setManaging] = useState<Member | null>(null)

  return (
    <div className="page">
      <PageHeader
        title="Family"
        subtitle={`Everyone in ${ctx.familyName}’s hub.`}
        actions={
          isAdmin && (
            <Button icon={<MailPlus size={16} aria-hidden />} onClick={() => setInviteOpen(true)}>
              Invite someone
            </Button>
          )
        }
      />
      {members.error && <Banner kind="error">{members.error}</Banner>}
      {!members.data && !members.error && <Spinner />}
      {members.data && (
        <Card>
          <ul className="member-list">
            {members.data.members.map((m) => (
              <li key={m.id} className={m.disabled ? 'member-disabled' : ''}>
                <span className="avatar avatar-lg" aria-hidden>
                  {initials(m.displayName)}
                </span>
                <div className="member-main">
                  <div className="member-name">
                    {m.displayName}
                    {m.self && <span className="muted"> (you)</span>}
                  </div>
                  <div className="member-meta muted">
                    @{m.username} · joined {formatDate(m.createdAt)}
                  </div>
                </div>
                <div className="member-badges">
                  {m.role === 'admin' && <Badge tone="accent">Parent</Badge>}
                  {m.disabled && <Badge tone="warning">Turned off</Badge>}
                  {!m.disabled &&
                    (m.twoFactor ? (
                      <span className="status-ok" title="Two-factor sign-in is set up">
                        <ShieldCheck size={16} aria-hidden /> 2FA
                      </span>
                    ) : (
                      <span className="status-warn" title="Has not finished setting up two-factor sign-in">
                        <ShieldAlert size={16} aria-hidden /> Setting up
                      </span>
                    ))}
                </div>
                {isAdmin && !m.self && (
                  <Button variant="ghost" icon={<UserCog size={18} aria-hidden />} aria-label={`Manage ${m.displayName}`} onClick={() => setManaging(m)} />
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {isAdmin && invites.data && invites.data.invites.length > 0 && (
        <Card title="Waiting to join">
          <ul className="member-list">
            {invites.data.invites.map((i) => (
              <PendingInvite key={i.id} invite={i} ctx={ctx} onChange={invites.reload} />
            ))}
          </ul>
        </Card>
      )}

      <InviteDialog
        ctx={ctx}
        open={inviteOpen}
        onClose={() => {
          setInviteOpen(false)
          invites.reload()
        }}
      />
      {managing && (
        <ManageDialog
          ctx={ctx}
          member={managing}
          onClose={() => {
            setManaging(null)
            members.reload()
          }}
        />
      )}
    </div>
  )
}

function PendingInvite({ invite, ctx, onChange }: { invite: Invite; ctx: HubContext; onChange: () => void }) {
  const cancel = useAction(async () => {
    await ctx.platform.api.del(`/api/invites/${invite.id}`)
    onChange()
  })
  return (
    <li>
      <span className="avatar avatar-lg avatar-pending" aria-hidden>
        {initials(invite.displayName)}
      </span>
      <div className="member-main">
        <div className="member-name">{invite.displayName}</div>
        <div className="member-meta muted">Invite link valid until {formatDate(invite.expiresAt)}</div>
      </div>
      <Button variant="ghost" busy={cancel.busy} icon={<Trash2 size={18} aria-hidden />} aria-label={`Cancel invite for ${invite.displayName}`} onClick={() => void cancel.run()} />
    </li>
  )
}

function InviteDialog({ ctx, open, onClose }: { ctx: HubContext; open: boolean; onClose: () => void }) {
  const [name, setName] = useState('')
  const [role, setRole] = useState<'member' | 'admin'>('member')
  const [link, setLink] = useState('')
  const create = useAction(async () => {
    const invite = await ctx.platform.api.post<{ token: string }>('/api/invites', { displayName: name, role })
    setLink(inviteLink(ctx, invite.token))
  })
  const close = () => {
    setName('')
    setRole('member')
    setLink('')
    create.setError('')
    onClose()
  }
  return (
    <Dialog open={open} title="Invite someone" onClose={close}>
      {link ? (
        <div className="stack">
          <p>
            Send this link to <strong>{name}</strong> (a private message is best). It works once and expires in 7 days. They will choose a username and password, then set up two-factor sign-in.
          </p>
          <div className="secret secret-wrap">{link}</div>
          <div className="row">
            <CopyButton text={link} label="Copy link" />
            <Button variant="ghost" onClick={close}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            void create.run()
          }}
        >
          <Field label="Their name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} autoFocus />
          <fieldset className="radio-group">
            <legend>Role</legend>
            <label className="check">
              <input type="radio" name="role" checked={role === 'member'} onChange={() => setRole('member')} />
              <span>
                <strong>Member</strong> — uses everything in the hub
              </span>
            </label>
            <label className="check">
              <input type="radio" name="role" checked={role === 'admin'} onChange={() => setRole('admin')} />
              <span>
                <strong>Parent</strong> — also invites people, manages accounts, and sees Quick Info and Contacts
              </span>
            </label>
          </fieldset>
          {create.error && <Banner kind="error">{create.error}</Banner>}
          <Button type="submit" busy={create.busy}>
            Create invite link
          </Button>
        </form>
      )}
    </Dialog>
  )
}

function ManageDialog({ ctx, member, onClose }: { ctx: HubContext; member: Member; onClose: () => void }) {
  const { api } = ctx.platform
  const [done, setDone] = useState('')
  const patch = useAction(async (body: Record<string, unknown>, message: string) => {
    await api.patch(`/api/members/${member.id}`, body)
    setDone(message)
  })
  const reset = useAction(async () => {
    if (!window.confirm(`Reset two-factor sign-in for ${member.displayName}? They will be signed out everywhere, their phones removed, and they set it up again at their next sign-in.`)) return
    await api.post(`/api/members/${member.id}/reset-two-factor`)
    setDone(`Two-factor sign-in reset. ${member.displayName} sets it up again at the next sign-in.`)
  })
  const error = patch.error || reset.error
  return (
    <Dialog open title={`Manage ${member.displayName}`} onClose={onClose}>
      {done ? (
        <div className="stack">
          <Banner kind="success">{done}</Banner>
          <Button onClick={onClose}>Done</Button>
        </div>
      ) : (
        <div className="stack">
          <div className="manage-row">
            <div>
              <strong>Role</strong>
              <p className="muted">{member.role === 'admin' ? 'Parent: can invite people, manage accounts, and see Quick Info and Contacts.' : 'Member.'}</p>
            </div>
            <Button
              variant="secondary"
              busy={patch.busy}
              onClick={() =>
                void patch.run(
                  { role: member.role === 'admin' ? 'member' : 'admin' },
                  member.role === 'admin' ? `${member.displayName} is now a member.` : `${member.displayName} is now a parent.`,
                )
              }
            >
              {member.role === 'admin' ? 'Make member' : 'Make parent'}
            </Button>
          </div>
          <div className="manage-row">
            <div>
              <strong>Lost phone</strong>
              <p className="muted">Removes their authenticator and registered phones so they can set up again.</p>
            </div>
            <Button variant="secondary" busy={reset.busy} onClick={() => void reset.run()}>
              Reset 2FA
            </Button>
          </div>
          <div className="manage-row">
            <div>
              <strong>{member.disabled ? 'Account is turned off' : 'Turn off account'}</strong>
              <p className="muted">{member.disabled ? 'They cannot sign in.' : 'Signs them out everywhere and stops them signing in. Nothing is deleted.'}</p>
            </div>
            <Button
              variant={member.disabled ? 'secondary' : 'danger'}
              busy={patch.busy}
              onClick={() =>
                void patch.run(
                  { disabled: !member.disabled },
                  member.disabled ? `${member.displayName} can sign in again.` : `${member.displayName}’s account is turned off.`,
                )
              }
            >
              {member.disabled ? 'Turn on' : 'Turn off'}
            </Button>
          </div>
          {error && <Banner kind="error">{error}</Banner>}
        </div>
      )}
    </Dialog>
  )
}
