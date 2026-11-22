/** Dates and other things shown to people. */

export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatDateTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000)
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  return formatDate(ms)
}

/** "Chrome on Windows" from a user-agent string; good enough for a sessions list. */
export function describeAgent(ua: string): string {
  if (!ua) return 'Unknown browser'
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser'
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return os ? `${browser} on ${os}` : browser
}

/** Morning, afternoon or evening. */
export function greeting(date = new Date()): string {
  const h = date.getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || '?'

/** Plain-language names for the security events in the activity list. */
export const EVENT_NAMES: Record<string, string> = {
  setup: 'Family Hub set up',
  'login.success': 'Signed in',
  'login.password_failed': 'Wrong password entered',
  'login.code_failed': 'Wrong code entered',
  'login.code_reused': 'A used code was tried again',
  'login.recovery_failed': 'Wrong recovery code entered',
  'login.recovery_code_used': 'Signed in with a recovery code',
  'login.locked': 'Sign-in locked after too many tries',
  logout: 'Signed out',
  'two_factor.enabled': 'Two-factor sign-in set up',
  'two_factor.setup_failed': 'Wrong code during two-factor set-up',
  'two_factor.reset_by_admin': 'Two-factor sign-in reset by a parent',
  'recovery_codes.replaced': 'New recovery codes made',
  'password.changed': 'Password changed',
  'password.change_failed': 'Wrong current password when changing it',
  'device.added': 'Phone registered',
  'device.removed': 'Phone removed',
  'device.unlocked': 'Phone unlocked',
  'device.unlock_failed': 'Phone unlock refused',
  'session.ended': 'A session was signed out',
  'member.invited': 'Invited someone',
  'member.invite_cancelled': 'Cancelled an invite',
  'member.joined': 'Joined the family',
  'member.updated': 'Changed a member',
  'member.two_factor_reset': 'Reset a member’s two-factor sign-in',
  'family.renamed': 'Renamed the family',
  'server_key.revealed': 'Showed the server key',
  'server_key.reveal_failed': 'Wrong code when showing the server key',
  'server_key.saved': 'Confirmed the server key is saved',
}
