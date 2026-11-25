/**
 * The signed-in hub: a sidebar on wide screens, a bottom bar on phones, and
 * the page for the current path.
 */
import { Download, Home, LogOut, Settings as SettingsIcon, Users } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { SessionInfo, User } from './api.ts'
import { initials } from './format.ts'
import { MODULES } from './modules.ts'
import { ComingSoon } from './pages/ComingSoon.tsx'
import { FilesPage } from './pages/Files.tsx'
import { QuickInfoPage } from './pages/QuickInfo.tsx'
import { ContactsPage } from './pages/Contacts.tsx'
import { CalendarPage } from './calendar/CalendarPage.tsx'
import { HealthPage } from './health/HealthPage.tsx'
import { MoneyPage } from './money/MoneyPage.tsx'
import { HomeCarePage } from './home/HomeCarePage.tsx'
import { SchoolPage } from './school/SchoolPage.tsx'
import { WishlistsPage } from './wishlists/WishlistsPage.tsx'
import { GiftPlanner } from './wishlists/GiftPlanner.tsx'
import { EmergencyPage } from './emergency/EmergencyPage.tsx'
import { refreshPack } from './emergency/refresh.ts'
import { HomePage } from './pages/Home.tsx'
import { MembersPage } from './pages/Members.tsx'
import { SettingsPage } from './pages/Settings.tsx'
import type { Platform, Updates } from './platform.ts'
import { href, navigate, usePath } from './router.ts'
import { vault } from './vault/store.ts'
import { Banner, Button } from './ui.tsx'
import { refreshPush, turnOff } from './notify/push.ts'

export interface HubContext {
  platform: Platform
  user: User
  familyName: string
  setFamilyName: (name: string) => void
  setUser: (user: User) => void
  signOut: () => void
  /** Parents only: whether a parent has confirmed the server key is in a password manager (null while loading or for members). */
  serverKeySaved: boolean | null
  setServerKeySaved: (saved: boolean) => void
}

function NavLink({ to, icon, label, path }: { to: string; icon: ReactNode; label: string; path: string }) {
  const active = to === '/' ? path === '/' : path === to || path.startsWith(`${to}/`)
  return (
    <a
      href={href(to)}
      className={`nav-link ${active ? 'active' : ''}`}
      aria-current={active ? 'page' : undefined}
      onClick={(e) => {
        e.preventDefault()
        navigate(to)
      }}
    >
      {icon}
      <span>{label}</span>
    </a>
  )
}

function useUpdates(updates: Updates | undefined) {
  return useSyncExternalStore(
    (cb) => updates?.subscribe(cb) ?? (() => undefined),
    () => updates?.info,
  )
}

export function Shell({ platform, session, onSignOut }: { platform: Platform; session: SessionInfo; onSignOut: () => void }) {
  const path = usePath()
  const [user, setUser] = useState(session.user)
  const [familyName, setFamilyName] = useState(session.familyName)
  const [lowCodes, setLowCodes] = useState<number | null>(null)
  const [emergency, setEmergency] = useState<{ active: boolean; kind: string | null } | null>(null)
  const [serverKeySaved, setServerKeySaved] = useState<boolean | null>(null)
  const update = useUpdates(platform.updates)

  // Parents are reminded until one of them has saved the server key.
  useEffect(() => {
    if (user.role !== 'admin') return
    platform.api.get<{ saved: boolean }>('/api/server-key').then(
      (k) => setServerKeySaved(k.saved),
      () => undefined,
    )
  }, [platform.api, user.role])

  useEffect(() => {
    platform.api.get<{ recoveryCodesLeft: number }>('/api/account').then(
      (a) => setLowCodes(a.recoveryCodesLeft <= 3 ? a.recoveryCodesLeft : null),
      () => undefined,
    )
  }, [platform.api])

  // A release of the emergency pack under way is shown to parents on every page (checked when the page changes).
  useEffect(() => {
    if (user.role !== 'admin') return
    platform.api.get<{ active: boolean; kind: string | null }>('/api/emergency/status').then(setEmergency, () => undefined)
  }, [platform.api, user.role, path])

  // Whenever a parent opens the family vault, the emergency pack is remade here if it is due (at most daily).
  useEffect(() => {
    if (user.role !== 'admin') return
    const check = () => {
      if (vault.unlocked) void refreshPack(platform.api, user.displayName).catch(() => undefined)
    }
    check()
    return vault.subscribe(check)
  }, [platform.api, user.role, user.displayName])

  // If this device already has notifications on, make sure the server has its current address.
  // A phone also checks for due reminders whenever the app is opened.
  useEffect(() => {
    void refreshPush(platform).catch(() => undefined)
    void platform.push?.checkNow?.().catch(() => undefined)
  }, [platform])

  const signOut = () => {
    vault.lock()
    // A browser that is signed out stops getting this person's notifications.
    // (A phone keeps its own until it is removed: its push address belongs to the phone.)
    const off = platform.kind === 'web' ? turnOff(platform).catch(() => undefined) : Promise.resolve()
    void off
      .then(() => platform.api.logout())
      .finally(() => {
        navigate('/', true)
        onSignOut()
      })
  }
  const ctx: HubContext = { platform, user, familyName, setFamilyName, setUser, signOut, serverKeySaved, setServerKeySaved }
  const ready = MODULES.filter((m) => m.status !== 'planned' && (!m.parentsOnly || user.role === 'admin'))

  let page: ReactNode
  const module = MODULES.find((m) => path === m.path || path.startsWith(`${m.path}/`))
  if (path === '/') page = <HomePage ctx={ctx} />
  else if (path === '/files' || path.startsWith('/files/')) page = <FilesPage ctx={ctx} />
  else if (path === '/info') page = <QuickInfoPage ctx={ctx} />
  else if (path === '/contacts') page = <ContactsPage ctx={ctx} />
  else if (path === '/calendar') page = <CalendarPage ctx={ctx} />
  else if (path === '/money') page = <MoneyPage ctx={ctx} />
  else if (path === '/home-care') page = <HomeCarePage ctx={ctx} />
  else if (path === '/school') page = <SchoolPage ctx={ctx} />
  else if (path === '/wishlists') page = <WishlistsPage ctx={ctx} />
  else if (path === '/gifts') page = <GiftPlanner ctx={ctx} />
  else if (path === '/emergency') page = <EmergencyPage ctx={ctx} />
  else if (path === '/health' || path.startsWith('/health/episodes/')) page = <HealthPage ctx={ctx} episodeId={path.startsWith('/health/episodes/') ? decodeURIComponent(path.slice('/health/episodes/'.length)) : null} />
  else if (module) page = <ComingSoon module={module} />
  else if (path === '/family') page = <MembersPage ctx={ctx} />
  else if (path === '/settings') page = <SettingsPage ctx={ctx} />
  else
    page = (
      <div className="empty">
        <h1>Page not found</h1>
        <Button onClick={() => navigate('/')}>Go home</Button>
      </div>
    )

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden>
            <Home size={18} />
          </span>
          <span className="brand-text">
            Family Hub
            <small>{familyName}</small>
          </span>
        </div>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" path={path} icon={<Home size={18} aria-hidden />} label="Home" />
          {ready.map((m) => (
            <NavLink key={m.id} to={m.path} path={path} icon={<m.icon size={18} aria-hidden />} label={m.name} />
          ))}
          <div className="nav-divider" />
          <NavLink to="/family" path={path} icon={<Users size={18} aria-hidden />} label="Family" />
          <NavLink to="/settings" path={path} icon={<SettingsIcon size={18} aria-hidden />} label="Settings" />
        </nav>
        <div className="sidebar-user">
          <span className="avatar" aria-hidden>
            {initials(user.displayName)}
          </span>
          <span className="sidebar-user-name">
            {user.displayName}
            <small>{user.role === 'admin' ? 'Parent' : 'Member'}</small>
          </span>
          <button className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
            <LogOut size={18} />
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="brand">
            <span className="brand-mark" aria-hidden>
              <Home size={16} />
            </span>
            <span className="brand-text">{familyName}</span>
          </div>
          <button className="avatar" onClick={() => navigate('/settings')} aria-label="Settings">
            {initials(user.displayName)}
          </button>
        </header>
        <div className="content">
          {update?.status === 'available' && platform.updates && (
            <Banner kind="info">
              <div className="row-between">
                <span>Family Hub {update.version} is ready to install.</span>
                <Button variant="secondary" icon={<Download size={16} aria-hidden />} onClick={() => navigate('/settings')}>
                  See what’s new
                </Button>
              </div>
            </Banner>
          )}
          {serverKeySaved === false && path !== '/settings' && (
            <Banner kind="warning">
              <div className="row-between">
                <span>
                  <strong>Save the server key to your password manager.</strong> Without it, a backup of Family Hub cannot be restored.
                </span>
                <Button variant="secondary" onClick={() => navigate('/settings')}>
                  Save it now
                </Button>
              </div>
            </Banner>
          )}
          {emergency?.active && path !== '/emergency' && (
            <Banner kind="error">
              {emergency.kind === 'request' ? 'Someone has asked for the emergency pack.' : 'The hub is checking that you are all right.'}{' '}
              <a href={href('/emergency')} onClick={(e) => (e.preventDefault(), navigate('/emergency'))}>
                Open In case of emergency
              </a>{' '}
              to see it, and cancel it if all is well.
            </Banner>
          )}
          {lowCodes !== null && (
            <Banner kind="warning" onClose={() => setLowCodes(null)}>
              You have {lowCodes} recovery code{lowCodes === 1 ? '' : 's'} left. Make new ones in{' '}
              <a href={href('/settings')} onClick={(e) => (e.preventDefault(), navigate('/settings'))}>
                Settings
              </a>
              .
            </Banner>
          )}
          {page}
        </div>
      </div>

      <nav className="bottom-nav" aria-label="Main">
        <NavLink to="/" path={path} icon={<Home size={20} aria-hidden />} label="Home" />
        {ready.slice(0, 2).map((m) => (
          <NavLink key={m.id} to={m.path} path={path} icon={<m.icon size={20} aria-hidden />} label={m.name} />
        ))}
        <NavLink to="/family" path={path} icon={<Users size={20} aria-hidden />} label="Family" />
        <NavLink to="/settings" path={path} icon={<SettingsIcon size={20} aria-hidden />} label="Settings" />
      </nav>
    </div>
  )
}
