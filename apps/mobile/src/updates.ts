/**
 * Keeps the Android app up to date from GitHub releases: checks when the
 * app starts and comes back to the foreground (at most every few hours),
 * shows a banner when a newer version exists, and on request downloads the
 * APK (AppUpdatePlugin.java) and opens Android's installer. Android only
 * installs it over this app if it is signed with the same release key.
 */
import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { UpdateInfo, Updates } from '@family-hub/ui'
import { apkUrl, isNewer, latestRelease, notesBetween, RELEASES_API, versionOf, type GithubRelease } from './release-notes.ts'

interface AppUpdatePlugin {
  download(options: { url: string }): Promise<void>
  install(): Promise<{ needsPermission: boolean }>
  addListener(event: 'progress', cb: (e: { percent: number }) => void): Promise<PluginListenerHandle>
}

const AppUpdate = registerPlugin<AppUpdatePlugin>('AppUpdate')

const CHECK_EVERY_MS = 6 * 60 * 60_000

export async function checkReleases(current: string, fetchImpl: typeof fetch = (i, init) => fetch(i, init)): Promise<UpdateInfo & { url?: string }> {
  try {
    const res = await fetchImpl(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
    const releases = (await res.json()) as unknown
    if (!Array.isArray(releases)) throw new Error('GitHub sent something unexpected')
    const latest = latestRelease(releases as GithubRelease[])
    const version = latest ? versionOf(latest) : ''
    if (!latest || !isNewer(version, current)) return { status: 'current' }
    const url = apkUrl(latest)
    if (!url) return { status: 'current' } // a release without an APK has nothing to install
    return { status: 'available', version, notes: notesBetween(releases as GithubRelease[], current, version), url }
  } catch (e) {
    return { status: 'error', message: `Could not check for updates: ${(e as Error).message}` }
  }
}

export function createUpdates(current: string): Updates & { maybeCheck(): void } {
  const listeners = new Set<() => void>()
  let lastCheck = 0
  let url: string | undefined
  let downloaded = false
  const store = {
    info: { status: 'idle' } as UpdateInfo,
    set(info: UpdateInfo) {
      store.info = info
      for (const l of listeners) l()
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    async check() {
      lastCheck = Date.now()
      store.set({ ...store.info, status: 'checking', message: undefined })
      const result = await checkReleases(current)
      url = result.url
      downloaded = false
      store.set({ status: result.status, version: result.version, notes: result.notes, message: result.message })
    },
    maybeCheck() {
      if (Date.now() - lastCheck > CHECK_EVERY_MS) void store.check()
    },
    async install() {
      if (!url) throw new Error('Check for updates first.')
      if (!downloaded) {
        const listener = await AppUpdate.addListener('progress', (e) => store.set({ ...store.info, progress: e.percent }))
        try {
          await AppUpdate.download({ url })
          downloaded = true
        } finally {
          await listener.remove()
          store.set({ ...store.info, progress: undefined })
        }
      }
      const { needsPermission } = await AppUpdate.install()
      if (needsPermission) {
        store.set({ ...store.info, message: 'Allow Family Hub to install apps in the settings that just opened, then tap Download and install again.' })
      }
    },
  }
  return store
}
