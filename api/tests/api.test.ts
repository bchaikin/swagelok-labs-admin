import { test } from 'node:test'
import assert from 'node:assert/strict'
import { diffGroups } from '../src/cognito.ts'
import { checkCsrf, findIdToken, parseCookies, HttpError } from '../src/auth.ts'
import type { APIGatewayProxyEventV2 } from 'aws-lambda'

test('diffGroups only touches managed groups and sorts output', () => {
  const managed = ['app:a', 'app:b', 'admins']
  assert.deepEqual(diffGroups(['app:a', 'legacy'], ['app:b', 'admins'], managed), { added: ['admins', 'app:b'], removed: ['app:a'] })
  assert.deepEqual(diffGroups(['app:a'], ['app:a'], managed), { added: [], removed: [] })
  assert.deepEqual(diffGroups([], ['not-managed'], managed), { added: [], removed: [] })
})

test('parseCookies handles multiple headers, encoded values and stray semicolons', () => {
  const c = parseCookies(['a=1; b=hello%20world;', 'c=x=y'])
  assert.equal(c.get('a'), '1')
  assert.equal(c.get('b'), 'hello world')
  assert.equal(c.get('c'), 'x=y')
})

test('findIdToken prefers LastAuthUser and falls back to any idToken for the client', () => {
  const base = 'CognitoIdentityServiceProvider.client1'
  const c = parseCookies([`${base}.LastAuthUser=bob; ${base}.bob.idToken=T1; ${base}.alice.idToken=T2`])
  assert.equal(findIdToken(c, 'client1'), 'T1')
  const noLast = parseCookies([`${base}.alice.idToken=T2`])
  assert.equal(findIdToken(noLast, 'client1'), 'T2')
  assert.equal(findIdToken(noLast, 'other'), null)
})

const ev = (method: string, headers: Record<string, string>): APIGatewayProxyEventV2 =>
  ({ requestContext: { http: { method } }, headers } as unknown as APIGatewayProxyEventV2)
const cfg = { siteOrigin: 'https://admin.swageloklabs.com', devActor: null } as Parameters<typeof checkCsrf>[1]

test('checkCsrf lets GETs through and requires the custom header + matching origin for writes', () => {
  assert.doesNotThrow(() => checkCsrf(ev('GET', {}), cfg))
  assert.throws(() => checkCsrf(ev('POST', {}), cfg), (e: unknown) => e instanceof HttpError && e.status === 403)
  assert.throws(() => checkCsrf(ev('POST', { 'X-Requested-With': 'SwagelokLabsAdmin', Origin: 'https://evil.example' }), cfg), HttpError)
  assert.doesNotThrow(() => checkCsrf(ev('POST', { 'x-requested-with': 'SwagelokLabsAdmin', origin: 'https://admin.swageloklabs.com' }), cfg))
  assert.doesNotThrow(() => checkCsrf(ev('DELETE', { 'x-requested-with': 'SwagelokLabsAdmin' }), cfg))
})
