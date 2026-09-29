// Who is calling? The admin site sits behind cognito-at-edge, which stores the Cognito tokens in
// HttpOnly cookies on the admin domain. CloudFront forwards those cookies to this API, so we read
// the id token cookie, verify it against the user pool, and require the `admins` group. The API is
// also reachable on its raw execute-api URL, so this check must not rely on CloudFront at all.
import { CognitoJwtVerifier } from 'aws-jwt-verify'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'
import { ADMIN_GROUP, type Config } from './config.ts'

export type Actor = { username: string; email: string; groups: string[] }

export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** Parse `Cookie` values ("a=1; b=2") into a map. Later values win. */
export function parseCookies(cookies: string[] | undefined): Map<string, string> {
  const out = new Map<string, string>()
  for (const header of cookies ?? []) {
    for (const part of header.split(';')) {
      const i = part.indexOf('=')
      if (i <= 0) continue
      const k = part.slice(0, i).trim()
      const v = part.slice(i + 1).trim()
      try {
        out.set(k, decodeURIComponent(v))
      } catch {
        out.set(k, v)
      }
    }
  }
  return out
}

/** Locate the id token cognito-at-edge stored for the last authenticated user of `clientId`. */
export function findIdToken(cookies: Map<string, string>, clientId: string): string | null {
  const base = `CognitoIdentityServiceProvider.${clientId}`
  const user = cookies.get(`${base}.LastAuthUser`)
  if (user) {
    const t = cookies.get(`${base}.${user}.idToken`)
    if (t) return t
  }
  // Fall back to any idToken cookie for this client (LastAuthUser can be missing after a partial clear).
  for (const [k, v] of cookies) {
    if (k.startsWith(`${base}.`) && k.endsWith('.idToken') && v) return v
  }
  return null
}

const verifiers = new Map<string, ReturnType<typeof CognitoJwtVerifier.create>>()
function verifierFor(cfg: Config) {
  const key = `${cfg.userPoolId}/${cfg.clientId}`
  let v = verifiers.get(key)
  if (!v) {
    v = CognitoJwtVerifier.create({ userPoolId: cfg.userPoolId, clientId: cfg.clientId, tokenUse: 'id' })
    verifiers.set(key, v)
  }
  return v
}

/** Mutating requests must come from our own page: custom header + matching Origin (when sent). */
export function checkCsrf(event: APIGatewayProxyEventV2, cfg: Config): void {
  const method = event.requestContext.http.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return
  const h = lowerHeaders(event)
  if (h['x-requested-with'] !== 'SwagelokLabsAdmin') throw new HttpError(403, 'Missing X-Requested-With header.')
  const origin = h['origin']
  if (origin && origin !== cfg.siteOrigin && !cfg.devActor) throw new HttpError(403, `Origin ${origin} is not allowed.`)
}

export function lowerHeaders(event: APIGatewayProxyEventV2): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) out[k.toLowerCase()] = v
  return out
}

export async function authenticate(event: APIGatewayProxyEventV2, cfg: Config): Promise<Actor> {
  if (cfg.devActor) {
    return { username: 'dev', email: cfg.devActor, groups: [ADMIN_GROUP] }
  }
  const token = findIdToken(parseCookies(event.cookies), cfg.clientId)
  if (!token) throw new HttpError(401, 'Not signed in.')
  let payload
  try {
    payload = await verifierFor(cfg).verify(token)
  } catch {
    throw new HttpError(401, 'Session expired. Reload the page to sign in again.')
  }
  const groups = (payload['cognito:groups'] as string[] | undefined) ?? []
  const actor: Actor = {
    username: String(payload['cognito:username'] ?? payload.sub),
    email: String(payload.email ?? ''),
    groups,
  }
  if (!groups.includes(ADMIN_GROUP)) throw new HttpError(403, `${actor.email || actor.username} is not in the ${ADMIN_GROUP} group.`)
  return actor
}
