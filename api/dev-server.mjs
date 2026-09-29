// Local API for `npm run dev`: wraps the Lambda handler in a plain HTTP server on :8788 and, via
// ADMIN_DEV_ACTOR, skips token verification so you can work without the CloudFront/Cognito front.
// It still talks to the REAL user pool and audit table with your local AWS credentials.
//
//   ADMIN_DEV_ACTOR=you@swagelok.com USER_POOL_ID=... CLIENT_ID=... AUDIT_TABLE=... node dev-server.mjs
import { createServer } from 'node:http'
import { handler } from './src/handler.ts'

const PORT = Number(process.env.PORT || 8788)
process.env.SITE_ORIGIN ||= `http://localhost:5173`
if (!process.env.ADMIN_DEV_ACTOR) {
  console.error('Set ADMIN_DEV_ACTOR=<your email> (and USER_POOL_ID, CLIENT_ID, AUDIT_TABLE).')
  process.exit(1)
}

createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const event = {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    queryStringParameters: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : v])),
    cookies: req.headers.cookie ? [req.headers.cookie] : [],
    requestContext: { http: { method: req.method, path: url.pathname } },
    body: chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined,
    isBase64Encoded: false,
  }
  const out = await handler(event)
  res.writeHead(out.statusCode ?? 200, out.headers ?? {})
  res.end(out.body ?? '')
}).listen(PORT, () => console.log(`admin api dev server on http://localhost:${PORT} acting as ${process.env.ADMIN_DEV_ACTOR}`))
