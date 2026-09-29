// Client for the admin API. Cookies (set by the Cognito gate) authenticate us; the custom header
// is the CSRF token the API insists on for writes.
export type Site = { group: string; name: string; url: string }
export type AdminUser = {
  username: string
  email: string
  name: string
  status: string
  enabled: boolean
  created: string
  updated: string
  groups: string[]
}
export type Actor = { username: string; email: string; groups: string[]; adminGroup: string }
export type AuditEntry = { at: string; actor: string; action: string; target: string; details?: Record<string, unknown> }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    redirect: 'manual',
    headers: {
      'X-Requested-With': 'SwagelokLabsAdmin',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  // An opaque redirect means the Cognito gate wants us to sign in again: reload to let it.
  if (res.type === 'opaqueredirect' || res.status === 0) {
    window.location.reload()
    throw new ApiError(401, 'Signing in again…')
  }
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // HTML from the gate or an edge error page
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`
    if (res.status === 401) window.setTimeout(() => window.location.reload(), 1500)
    throw new ApiError(res.status, msg)
  }
  return data as T
}

export const api = {
  me: () => call<Actor>('GET', '/me'),
  sites: () => call<{ sites: Site[]; adminGroup: string }>('GET', '/sites'),
  users: () => call<{ users: AdminUser[] }>('GET', '/users').then((r) => r.users),
  invite: (email: string, name: string, groups: string[]) => call<{ user: AdminUser }>('POST', '/users', { email, name, groups }).then((r) => r.user),
  update: (username: string, patch: { name?: string; enabled?: boolean }) =>
    call<{ user: AdminUser }>('PATCH', `/users/${encodeURIComponent(username)}`, patch).then((r) => r.user),
  setGroups: (username: string, groups: string[]) =>
    call<{ user: AdminUser }>('PUT', `/users/${encodeURIComponent(username)}/groups`, { groups }).then((r) => r.user),
  action: (username: string, action: 'resend-invite' | 'reset-password' | 'reset-mfa' | 'sign-out') =>
    call<{ ok: true }>('POST', `/users/${encodeURIComponent(username)}/${action}`),
  remove: (username: string) => call<{ ok: true }>('DELETE', `/users/${encodeURIComponent(username)}`),
  audit: (limit = 100) => call<{ entries: AuditEntry[] }>('GET', `/audit?limit=${limit}`).then((r) => r.entries),
}
