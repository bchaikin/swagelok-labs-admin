// Bundle src/handler.js + cognito-at-edge + aws-jwt-verify into dist/index.js and zip it for Lambda@Edge.
// Configuration is baked in via esbuild `define` from environment variables (deploy.sh sets them):
//   EDGE_REGION, EDGE_USER_POOL_ID, EDGE_USER_POOL_DOMAIN, EDGE_CLIENT_ID, EDGE_CLIENT_SECRET (optional),
//   EDGE_NONCE_SECRET, EDGE_SITE_URL, EDGE_SITE_NAME, EDGE_REQUIRED_GROUP, EDGE_COOKIE_DAYS (default 30)
import { build } from 'esbuild'
import { mkdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'

const here = path.dirname(fileURLToPath(import.meta.url))
const dist = path.join(here, 'dist')

const need = (k) => {
  const v = process.env[k]
  if (!v) throw new Error(`missing env ${k}`)
  return v
}
const config = {
  region: need('EDGE_REGION'),
  userPoolId: need('EDGE_USER_POOL_ID'),
  userPoolDomain: need('EDGE_USER_POOL_DOMAIN'),
  clientId: need('EDGE_CLIENT_ID'),
  clientSecret: process.env.EDGE_CLIENT_SECRET || '',
  nonceSecret: need('EDGE_NONCE_SECRET'),
  siteUrl: need('EDGE_SITE_URL'),
  siteName: process.env.EDGE_SITE_NAME || 'this site',
  requiredGroup: process.env.EDGE_REQUIRED_GROUP || '',
  cookieDays: Number(process.env.EDGE_COOKIE_DAYS || 30),
  parseAuthPath: '/parseauth',
  logoutPath: '/signout',
}

rmSync(dist, { recursive: true, force: true })
mkdirSync(dist, { recursive: true })

await build({
  entryPoints: [path.join(here, 'src', 'handler.js')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: path.join(dist, 'index.js'),
  define: { __CONFIG__: JSON.stringify(config) },
  minify: false,
  sourcemap: false,
  logLevel: 'warning',
})

const zip = new AdmZip()
zip.addLocalFile(path.join(dist, 'index.js'))
const zipPath = path.join(dist, 'edge-auth.zip')
zip.writeZip(zipPath)
console.log(`built ${path.relative(process.cwd(), zipPath)} (${(statSync(zipPath).size / 1024).toFixed(0)} KB) for client ${config.clientId}, group ${config.requiredGroup || '(none)'}`)
