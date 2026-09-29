# AGENTS.md — Swagelok Labs Admin

Project instructions for coding agents. Read this before changing anything.

## What this is
User management for the shared Cognito user pool (`us-east-1_65EMdls09`, hosted domain
`swageloklabs-auth`) that signs people into the swageloklabs.com sites: SSC Locator
(`C:\Users\bryan\source\ssc-locator`), SSC Expert Finder (`C:\Users\bryan\source\ssc-expert-finder`)
and Portfolio Planner (`C:\Users\bryan\source\swagelok-portfolio-planner`). Hosted at
https://admin.swageloklabs.com. Access to each site is a Cognito group (`app:locator`,
`app:sscexpert`, `app:portfolioplanner`); `admins` may use this app. Each site's own gate enforces
its group (Lambda@Edge for the two static sites, the FastAPI app for the Expert Finder).

## Layout
- `src/` — Vite + React 19 + TS + Tailwind v4 SPA. `App.tsx` (header, tabs), `pages/UsersPage.tsx`
  (table with per-site toggles, invite modal, actions menu), `pages/AuditPage.tsx`, `lib/api.ts`
  (fetch wrapper: same-origin cookies + `X-Requested-With: SwagelokLabsAdmin` CSRF header; reloads
  the page when the gate redirects), `components/ui.tsx`, `index.css` (brand tokens, same as locator).
- `api/` — Lambda (Node 20, ESM, esbuild-bundled). `src/handler.ts` routes, `src/auth.ts` (id-token
  cookie -> aws-jwt-verify -> require `admins`; CSRF check), `src/cognito.ts` (admin API wrapper +
  pure `diffGroups`), `src/audit.ts` (DynamoDB `pk=audit`, `sk=<iso>#<rand>`), `src/config.ts`
  (env vars + site list), `dev-server.mjs` (local HTTP wrapper; `ADMIN_DEV_ACTOR` bypasses tokens),
  `tests/` (`node --test`, TS directly).
- `deploy/aws/deploy.sh` — idempotent CLI provisioning: `status|infra|auth|groups|upload|all`.
  `cf-config.mjs` builds/patches the CloudFront config (S3 origin + `/api/*` -> HTTP API origin,
  Lambda@Edge on both). `edge-auth/` — cognito-at-edge authorizer with `admins` group check
  (`handler.js`, bundled by `build.mjs` with `__CONFIG__` injected). `hosted-ui.css` — copy of the
  pool-wide hosted UI branding (applied from ssc-locator's `auth.sh ui`).

## Conventions
- `npm run build` = `tsc -b` + `vite build`; `npm test` runs the API tests; `npm run build:api` bundles the Lambda.
- Keep `tsc -b` (web) and `api/node_modules/.bin/tsc -p api/tsconfig.json` clean.
- Every state-changing API route records an audit entry. Self-protection rules live in the handler:
  admins cannot disable/delete themselves or drop their own `admins` membership.
- Managed groups = site groups + `admins`; the API never touches other groups.
- No secrets in git. The edge nonce secret lives in SSM `/swagelok-labs-admin/edge-auth/nonce-secret`;
  the app client is public (no secret).
- Windows dev VM: Node at `C:\Users\bryan\tools\node`, AWS CLI v2 at `C:\Program Files\Amazon\AWSCLIV2`,
  run bash scripts via `C:\Users\bryan\tools\git\bin\bash.exe`. Under Git Bash use `MSYS_NO_PATHCONV=1`
  for aws.exe and `cygpath -m` for paths handed to node.exe. `npm install-scripts approve esbuild` after a fresh install.
- Commits: author Bryan Chaikin <bryan.chaikin@gmail.com>; `git add <files>` explicitly.

## AWS (account 496210974629, us-east-1)
- App client `labs-admin` (public, code flow, callback `https://admin.swageloklabs.com/parseauth`, logout `/`).
- S3 `swagelok-labs-admin-496210974629` (OAC) + CloudFront (alias admin.swageloklabs.com, `*.swageloklabs.com` cert) + Route 53 alias in `Z05265941PFZO4KDFMYZ8`.
- HTTP API `swagelok-labs-admin` -> Lambda `swagelok-labs-admin-api` (role `swagelok-labs-admin-api`: scoped cognito-idp admin actions on the pool + PutItem/Query on DynamoDB `swagelok-labs-admin-audit`).
- Lambda@Edge `swagelok-labs-admin-edge-auth` (role of the same name), versioned ARN on both CloudFront behaviours.
- The raw execute-api URL bypasses CloudFront, which is why the Lambda verifies the id token and CSRF header itself.
- Sign in with `aws login` (root); sessions expire after a few hours.

## Local development
```
# terminal 1 (real pool + audit table, acting as you, no tokens):
$env:ADMIN_DEV_ACTOR='bryan.chaikin@swagelok.com'; $env:USER_POOL_ID='us-east-1_65EMdls09'; $env:CLIENT_ID='<labs-admin client id>'; $env:AUDIT_TABLE='swagelok-labs-admin-audit'
npm --prefix api run dev
# terminal 2:
npm run dev      # http://localhost:5174 (proxies /api to :8788)
```
