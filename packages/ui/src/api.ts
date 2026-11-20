/**
 * Talks to the Family Hub server. In a browser the session is an HttpOnly
 * cookie the page never sees; in the Android app it is a bearer token held
 * only in memory.
 */

export class ApiError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

export type Stage = 'totp' | 'enroll' | 'device' | 'full'

export interface User {
  id: string
  username: string
  displayName: string
  role: 'admin' | 'member'
}

export interface SessionInfo {
  stage: Stage
  transport: 'cookie' | 'bearer'
  expiresAt: number
  user: User
  familyName: string
}

/** What a sign-in step answers: the next stage, and for the app a new token. */
export interface StepResult {
  stage: Stage
  token?: string
  expiresAt: number
  recoveryCodes?: string[]
  recoveryCodesLeft?: number
}

export interface ApiOptions {
  /** Server address; '' for the page's own server. */
  baseUrl: string
  /** 'app' for the Android app (bearer tokens), 'web' for a browser (cookies). */
  client: 'web' | 'app'
}

export class Api {
  baseUrl: string
  client: 'web' | 'app'
  /** The app's session token, only ever in memory. */
  token = ''
  /** Called when the server says the session is gone (expired, signed out elsewhere). */
  onSignedOut: (() => void) | null = null

  constructor(opts: ApiOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.client = opts.client
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'X-Requested-With': 'family-hub', Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.client === 'app' && this.token) headers.Authorization = `Bearer ${this.token}`
    let res: Response
    try {
      res = await fetch(this.baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: this.client === 'web' ? 'same-origin' : 'omit',
        cache: 'no-store',
      })
    } catch {
      throw new ApiError(0, 'offline', 'Could not reach Family Hub. Check your connection.')
    }
    const text = await res.text()
    let data: unknown = undefined
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        throw new ApiError(res.status, 'bad_response', 'The server sent something unexpected.')
      }
    }
    if (!res.ok) {
      const err = (data ?? {}) as { error?: string; message?: string }
      const error = new ApiError(res.status, err.error ?? 'error', err.message ?? `Request failed (${res.status}).`)
      if (res.status === 401 && path !== '/api/auth/login' && !path.startsWith('/api/auth/totp')) this.onSignedOut?.()
      throw error
    }
    const result = data as T
    const token = (result as { token?: unknown } | undefined)?.token
    if (this.client === 'app' && typeof token === 'string' && path.startsWith('/api/') && !path.startsWith('/api/invites')) {
      this.token = token
    }
    return result
  }

  get = <T>(path: string) => this.request<T>('GET', path)
  post = <T>(path: string, body: unknown = {}) => this.request<T>('POST', path, body)
  patch = <T>(path: string, body: unknown = {}) => this.request<T>('PATCH', path, body)
  del = <T>(path: string) => this.request<T>('DELETE', path)

  // ---- signing in ----------------------------------------------------------------

  setupState = () => this.get<{ needed: boolean; familyName: string }>('/api/setup')
  session = () => this.get<SessionInfo>('/api/auth/session')
  setup = (body: { familyName: string; username: string; displayName: string; password: string }) =>
    this.post<StepResult>('/api/setup', { ...body, client: this.client })
  login = (username: string, password: string) => this.post<StepResult>('/api/auth/login', { username, password, client: this.client })
  totp = (code: string) => this.post<StepResult>('/api/auth/totp', { code })
  recovery = (recoveryCode: string) => this.post<StepResult>('/api/auth/totp', { recoveryCode })
  totpOffer = () => this.post<{ secret: string; otpauthUrl: string }>('/api/auth/totp/setup')
  totpConfirm = (code: string) => this.post<StepResult>('/api/auth/totp/confirm', { code })
  invite = (token: string) => this.get<{ displayName: string; familyName: string }>(`/api/invites/redeem/${encodeURIComponent(token)}`)
  acceptInvite = (token: string, body: { username: string; displayName: string; password: string }) =>
    this.post<StepResult>(`/api/invites/redeem/${encodeURIComponent(token)}`, { ...body, client: this.client })

  async logout(): Promise<void> {
    try {
      await this.post('/api/auth/logout')
    } finally {
      this.token = ''
    }
  }
}
