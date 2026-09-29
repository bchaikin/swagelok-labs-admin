// Lambda@Edge (viewer-request) authorizer for admin.swageloklabs.com.
//
// Same pattern as locator.swageloklabs.com (cognito-at-edge against the shared swageloklabs user
// pool, deep links preserved via a return cookie) plus a group check: only members of the
// `admins` group may load the admin site. Lambda@Edge has no environment variables, so
// `__CONFIG__` is injected at bundle time by build.mjs.
const { Authenticator } = require('cognito-at-edge')
const { CognitoJwtVerifier } = require('aws-jwt-verify')

const cfg = __CONFIG__
const RETURN_COOKIE = 'ssc_return'
const REQUIRED_GROUP = cfg.requiredGroup || null

const authenticator = new Authenticator({
  region: cfg.region,
  userPoolId: cfg.userPoolId,
  userPoolAppId: cfg.clientId,
  ...(cfg.clientSecret ? { userPoolAppSecret: cfg.clientSecret } : {}),
  userPoolDomain: cfg.userPoolDomain,
  cookieExpirationDays: cfg.cookieDays,
  httpOnly: true,
  sameSite: 'Lax',
  parseAuthPath: cfg.parseAuthPath,
  cookiePath: '/',
  logoutConfiguration: {
    logoutUri: cfg.logoutPath,
    logoutRedirectUri: `https://${cfg.userPoolDomain}/logout?client_id=${encodeURIComponent(cfg.clientId)}&logout_uri=${encodeURIComponent(`${cfg.siteUrl}/`)}`,
  },
  csrfProtection: { nonceSigningSecret: cfg.nonceSecret },
  logLevel: 'warn',
})

const verifier = CognitoJwtVerifier.create({ userPoolId: cfg.userPoolId, clientId: cfg.clientId, tokenUse: 'id' })

function readCookies(request) {
  const out = new Map()
  for (const h of request.headers.cookie || []) {
    for (const part of h.value.split(';')) {
      const i = part.indexOf('=')
      if (i <= 0) continue
      out.set(part.slice(0, i).trim(), part.slice(i + 1).trim())
    }
  }
  return out
}

function addSetCookie(response, value) {
  response.headers = response.headers || {}
  response.headers['set-cookie'] = [...(response.headers['set-cookie'] || []), { key: 'Set-Cookie', value }]
}

function safeReturnPath(p) {
  return typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') && !p.startsWith('/\\') ? p : null
}

/** Groups from the id-token cookie the library just verified (re-verified here for safety). */
async function groupsOf(request) {
  const cookies = readCookies(request)
  const base = `CognitoIdentityServiceProvider.${cfg.clientId}`
  const user = cookies.get(`${base}.LastAuthUser`)
  const token = user ? cookies.get(`${base}.${user}.idToken`) : null
  if (!token) return []
  try {
    const payload = await verifier.verify(token)
    return payload['cognito:groups'] || []
  } catch {
    return []
  }
}

function forbidden(email) {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>No access</title>
<style>body{font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;color:#36424a;background:#f4f5f6;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border:1px solid #c4c7c8;border-radius:16px;padding:32px 36px;max-width:520px;box-shadow:0 4px 16px rgba(0,0,0,.08)}
h1{color:#004d9e;font-size:20px;margin:0 0 8px}p{margin:8px 0;font-size:15px;line-height:1.5}a{color:#004d9e}</style></head>
<body><div class="card"><h1>You don't have access to ${cfg.siteName}</h1>
<p>${email ? `You are signed in as <strong>${email}</strong>, but that account` : 'Your account'} isn't in the <code>${REQUIRED_GROUP}</code> group.</p>
<p>Ask an administrator to grant you access, then <a href="/">try again</a>. Or <a href="${cfg.logoutPath}">sign out</a> and use another account.</p></div></body></html>`
  return {
    status: '403',
    statusDescription: 'Forbidden',
    headers: {
      'content-type': [{ key: 'Content-Type', value: 'text/html; charset=utf-8' }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    },
    body,
  }
}

exports.handler = async (event) => {
  const request = event.Records[0].cf.request
  const host = request.headers.host[0].value
  if (!request.headers.cookie) request.headers.cookie = []
  const response = await authenticator.handle(event)

  if (response === request) {
    // Authenticated. Enforce the site's group unless this is a sign-out.
    if (REQUIRED_GROUP && request.uri !== cfg.logoutPath) {
      const cookies = readCookies(request)
      const base = `CognitoIdentityServiceProvider.${cfg.clientId}`
      const user = cookies.get(`${base}.LastAuthUser`)
      const groups = await groupsOf(request)
      if (!groups.includes(REQUIRED_GROUP)) return forbidden(user && user.includes('@') ? user : '')
    }
    return request
  }

  const location = response.headers && response.headers.location && response.headers.location[0] ? response.headers.location[0].value : ''

  if (location.startsWith(`https://${cfg.userPoolDomain}/authorize`) && request.uri !== cfg.parseAuthPath) {
    const wanted = request.uri + (request.querystring ? `?${request.querystring}` : '')
    addSetCookie(response, `${RETURN_COOKIE}=${encodeURIComponent(wanted)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`)
    return response
  }

  const cameBackWithCode = request.uri === cfg.parseAuthPath && /(^|&)code=/.test(request.querystring || '')
  if (cameBackWithCode && response.status === '302' && location) {
    const back = safeReturnPath(decodeURIComponent(readCookies(request).get(RETURN_COOKIE) || '')) || '/'
    response.headers.location = [{ key: 'Location', value: `https://${host}${back}` }]
    addSetCookie(response, `${RETURN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`)
  }
  return response
}
