/**
 * What changed between the installed version and the newest release, read
 * from the project's GitHub releases list, and that release's APK.
 */

export const REPO = 'deanbirnie/family-hub'
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=30`
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
/** The only place an update is ever downloaded from (the native side checks this too). */
export const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`

/** The parts of a GitHub release this reads. Everything is checked, as it comes from the network. */
export interface GithubRelease {
  tag_name?: unknown
  html_url?: unknown
  body?: unknown
  draft?: unknown
  prerelease?: unknown
  assets?: { name?: unknown; browser_download_url?: unknown }[]
}

/** Compares plain x.y.z versions; anything else (a development build) counts as oldest. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null)
  const a = parse(candidate)
  const b = parse(current)
  if (!a) return false
  if (!b) return true
  for (let i = 0; i < 3; i++) if (a[i]! !== b[i]!) return a[i]! > b[i]!
  return false
}

export const versionOf = (release: GithubRelease) => (typeof release.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '')

const published = (r: GithubRelease) => r.draft !== true && r.prerelease !== true && /^\d+\.\d+\.\d+$/.test(versionOf(r))

export function latestRelease(releases: GithubRelease[]): GithubRelease | undefined {
  return releases.filter(published).reduce<GithubRelease | undefined>((best, r) => (!best || isNewer(versionOf(r), versionOf(best)) ? r : best), undefined)
}

/**
 * The bullet points under a release's "What's Changed" heading (GitHub's
 * generated notes), without the "by @someone in <link>" endings. Plain text only.
 */
export function parseChanges(body: unknown): string[] {
  if (typeof body !== 'string') return []
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex((l) => /^#+\s*What'?s Changed/i.test(l.trim()))
  if (start < 0) return []
  const changes: string[] = []
  for (const line of lines.slice(start + 1)) {
    const t = line.trim()
    if (/^#/.test(t) || /^\*\*Full Changelog/i.test(t)) break
    const m = /^[*-]\s+(.*)$/.exec(t)
    if (!m) continue
    const text = m[1]!
      .replace(/\s+by @[\w-]+(\[bot\])?\s+in\s+\S+\s*$/, '')
      .replace(/\s+in\s+https?:\/\/\S+\s*$/, '')
      .trim()
    if (text) changes.push(text.slice(0, 200))
  }
  return changes
}

/** Notes for every published release after `current`, up to `latest`, newest first. */
export function notesBetween(releases: GithubRelease[], current: string, latest: string): { version: string; changes: string[] }[] {
  return releases
    .filter(published)
    .filter((r) => isNewer(versionOf(r), current) && !isNewer(versionOf(r), latest))
    .sort((a, b) => (isNewer(versionOf(a), versionOf(b)) ? -1 : 1))
    .map((r) => ({ version: versionOf(r), changes: parseChanges(r.body) }))
}

/** The APK attached to a release, if it is where releases put it. */
export function apkUrl(release: GithubRelease): string | undefined {
  const version = versionOf(release)
  const asset = release.assets?.find((a) => a.name === `family-hub-${version}.apk`)
  const url = asset?.browser_download_url
  return typeof url === 'string' && url.startsWith(DOWNLOAD_PREFIX) ? url : undefined
}
