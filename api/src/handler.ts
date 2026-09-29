// HTTP API (API Gateway v2) Lambda handler. Routes:
//   GET    /api/me                              who am I
//   GET    /api/sites                           managed sites (group -> name/url)
//   GET    /api/users                           all users with groups
//   POST   /api/users                           { email, name?, groups? }   invite
//   GET    /api/users/{u}                       one user
//   PATCH  /api/users/{u}                       { name? , enabled? }
//   PUT    /api/users/{u}/groups                { groups: [...] }           set managed groups
//   POST   /api/users/{u}/resend-invite
//   POST   /api/users/{u}/reset-password
//   POST   /api/users/{u}/reset-mfa
//   POST   /api/users/{u}/sign-out
//   DELETE /api/users/{u}
//   GET    /api/audit?limit=100
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda'
import { Audit } from './audit.ts'
import { HttpError, authenticate, checkCsrf, type Actor } from './auth.ts'
import { Cognito } from './cognito.ts'
import { ADMIN_GROUP, loadConfig, type Config } from './config.ts'

type Deps = { cfg: Config; cognito: Cognito; audit: Audit }
let deps: Deps | null = null
function getDeps(): Deps {
  if (!deps) {
    const cfg = loadConfig()
    deps = { cfg, cognito: new Cognito(cfg.region, cfg.userPoolId), audit: new Audit(cfg.region, cfg.auditTable) }
  }
  return deps
}

const json = (status: number, body: unknown): APIGatewayProxyResultV2 => ({
  statusCode: status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
})

function managedGroups(cfg: Config): string[] {
  return [...cfg.sites.map((s) => s.group), ADMIN_GROUP]
}

function parseBody<T>(event: APIGatewayProxyEventV2): T {
  if (!event.body) return {} as T
  try {
    return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) as T
  } catch {
    throw new HttpError(400, 'Body must be JSON.')
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export async function route(event: APIGatewayProxyEventV2, d: Deps, actor: Actor): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method.toUpperCase()
  const path = event.rawPath.replace(/^\/api(?=\/|$)/, '').replace(/\/+$/, '') || '/'
  const seg = path.split('/').filter(Boolean)
  const { cfg, cognito, audit } = d

  if (method === 'GET' && path === '/me') return json(200, { ...actor, adminGroup: ADMIN_GROUP })
  if (method === 'GET' && path === '/sites') return json(200, { sites: cfg.sites, adminGroup: ADMIN_GROUP })
  if (method === 'GET' && path === '/audit') {
    const limit = Number(event.queryStringParameters?.limit ?? 100)
    return json(200, { entries: await audit.recent(Number.isFinite(limit) ? limit : 100) })
  }

  if (seg[0] === 'users') {
    if (seg.length === 1 && method === 'GET') return json(200, { users: await cognito.listUsers() })

    if (seg.length === 1 && method === 'POST') {
      const body = parseBody<{ email?: string; name?: string; groups?: string[] }>(event)
      const email = (body.email ?? '').trim().toLowerCase()
      if (!EMAIL_RE.test(email)) throw new HttpError(400, 'A valid email address is required.')
      const username = await cognito.createUser(email, body.name?.trim() || undefined)
      const wanted = (body.groups ?? []).filter((g) => managedGroups(cfg).includes(g))
      const { added } = await cognito.setGroups(username, [], wanted, managedGroups(cfg))
      await audit.record({ actor: actor.email, action: 'user.invite', target: email, details: { name: body.name, groups: added } })
      return json(201, { user: await cognito.getUser(username) })
    }

    const username = decodeURIComponent(seg[1] ?? '')
    if (!username) throw new HttpError(404, 'Not found.')
    const self = username === actor.username || username.toLowerCase() === actor.email.toLowerCase()

    if (seg.length === 2 && method === 'GET') return json(200, { user: await cognito.getUser(username) })

    if (seg.length === 2 && method === 'PATCH') {
      const body = parseBody<{ name?: string; enabled?: boolean }>(event)
      const changes: Record<string, unknown> = {}
      if (typeof body.name === 'string') {
        await cognito.updateName(username, body.name.trim())
        changes.name = body.name.trim()
      }
      if (typeof body.enabled === 'boolean') {
        if (self && !body.enabled) throw new HttpError(400, 'You cannot disable your own account.')
        await cognito.setEnabled(username, body.enabled)
        changes.enabled = body.enabled
      }
      if (Object.keys(changes).length) await audit.record({ actor: actor.email, action: 'user.update', target: username, details: changes })
      return json(200, { user: await cognito.getUser(username) })
    }

    if (seg.length === 2 && method === 'DELETE') {
      if (self) throw new HttpError(400, 'You cannot delete your own account.')
      const before = await cognito.getUser(username)
      await cognito.deleteUser(username)
      await audit.record({ actor: actor.email, action: 'user.delete', target: before.email || username, details: { groups: before.groups } })
      return json(200, { ok: true })
    }

    if (seg.length === 3 && method === 'PUT' && seg[2] === 'groups') {
      const body = parseBody<{ groups?: string[] }>(event)
      if (!Array.isArray(body.groups)) throw new HttpError(400, '`groups` must be an array.')
      const current = (await cognito.getUser(username)).groups
      if (self && current.includes(ADMIN_GROUP) && !body.groups.includes(ADMIN_GROUP)) {
        throw new HttpError(400, 'You cannot remove yourself from the admins group.')
      }
      const { added, removed } = await cognito.setGroups(username, current, body.groups, managedGroups(cfg))
      if (added.length || removed.length) await audit.record({ actor: actor.email, action: 'user.groups', target: username, details: { added, removed } })
      return json(200, { user: await cognito.getUser(username) })
    }

    if (seg.length === 3 && method === 'POST') {
      const action = seg[2]
      const target = username
      switch (action) {
        case 'resend-invite':
          await cognito.resendInvite(username)
          await audit.record({ actor: actor.email, action: 'user.resend-invite', target })
          return json(200, { ok: true })
        case 'reset-password':
          await cognito.resetPassword(username)
          await audit.record({ actor: actor.email, action: 'user.reset-password', target })
          return json(200, { ok: true })
        case 'reset-mfa':
          await cognito.resetMfa(username)
          await audit.record({ actor: actor.email, action: 'user.reset-mfa', target })
          return json(200, { ok: true })
        case 'sign-out':
          await cognito.globalSignOut(username)
          await audit.record({ actor: actor.email, action: 'user.sign-out', target })
          return json(200, { ok: true })
      }
    }
  }
  throw new HttpError(404, `No route for ${method} ${path}.`)
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  try {
    const d = getDeps()
    checkCsrf(event, d.cfg)
    const actor = await authenticate(event, d.cfg)
    return await route(event, d, actor)
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message })
    const err = e as { name?: string; message?: string }
    // Cognito service errors are safe and useful to surface (UsernameExistsException, ...).
    if (err.name && /Exception$/.test(err.name)) return json(400, { error: `${err.name}: ${err.message ?? ''}`.trim() })
    console.error('unhandled', e)
    return json(500, { error: 'Internal error.' })
  }
}
