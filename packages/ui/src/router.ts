/**
 * A very small router. The web app uses real paths (so invite links look
 * like /invite/…); the Android app uses the hash, which works however the
 * app's files are served.
 */
import { useEffect, useState } from 'react'

export type RouteMode = 'path' | 'hash'

let mode: RouteMode = 'path'
const listeners = new Set<() => void>()

export function setRouteMode(m: RouteMode): void {
  mode = m
}

export function currentPath(): string {
  if (mode === 'hash') return window.location.hash.replace(/^#/, '') || '/'
  return window.location.pathname || '/'
}

/** The href for a link to `path`. */
export const href = (path: string) => (mode === 'hash' ? `#${path}` : path)

export function navigate(path: string, replace = false): void {
  if (path === currentPath()) return
  const url = mode === 'hash' ? `#${path}` : path
  if (replace) window.history.replaceState(null, '', url)
  else window.history.pushState(null, '', url)
  for (const l of listeners) l()
  window.scrollTo(0, 0)
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath)
  useEffect(() => {
    const update = () => setPath(currentPath())
    listeners.add(update)
    window.addEventListener('popstate', update)
    window.addEventListener('hashchange', update)
    return () => {
      listeners.delete(update)
      window.removeEventListener('popstate', update)
      window.removeEventListener('hashchange', update)
    }
  }, [])
  return path
}

/** Matches `/members/:id`-style patterns; returns the parameters or null. */
export function matchPath(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean)
  const got = path.split('/').filter(Boolean)
  if (want.length !== got.length) return null
  const params: Record<string, string> = {}
  for (let i = 0; i < want.length; i++) {
    if (want[i]!.startsWith(':')) params[want[i]!.slice(1)] = decodeURIComponent(got[i]!)
    else if (want[i] !== got[i]) return null
  }
  return params
}
