# Swagelok Labs Admin

User management for the sign-in pool shared by the swageloklabs.com sites (SSC Locator, SSC Expert
Finder, Portfolio Planner). Live at **https://admin.swageloklabs.com** for members of the `admins` group.

## What it does
- **Users:** invite by email (Cognito sends the temporary password), search, enable/disable, delete,
  re-send invitations, reset passwords, reset a lost authenticator (MFA), sign someone out everywhere.
- **Access:** one toggle per site. Sites map to Cognito groups (`app:locator`, `app:sscexpert`,
  `app:portfolioplanner`); each site's gate only lets members through. `admins` may use this app.
- **Audit trail:** every change, with who/what/when, in DynamoDB.

## How it works
Static React app on S3 + CloudFront, behind the same cognito-at-edge Lambda@Edge gate as the other
sites plus an `admins` check. `/api/*` is routed by CloudFront to an HTTP API + Lambda that verifies
the Cognito id token from the gate's cookie, requires `admins`, checks a CSRF header, then calls the
Cognito admin APIs and writes the audit entry.

## Develop
```bash
npm install && npm --prefix api install
npm test                      # API unit tests
npm --prefix api run dev      # local API on :8788 (needs ADMIN_DEV_ACTOR, USER_POOL_ID, CLIENT_ID, AUDIT_TABLE; uses your AWS creds)
npm run dev                   # web on :5174, proxies /api
```

## Deploy
```bash
deploy/aws/deploy.sh status
deploy/aws/deploy.sh          # infra + groups + build + upload (idempotent)
deploy/aws/deploy.sh upload   # code-only redeploy
```
From PowerShell on the dev VM: `& C:\Users\bryan\tools\git\bin\bash.exe C:/Users/bryan/source/swagelok-labs-admin/deploy/aws/deploy.sh <mode>`

`deploy.sh groups` creates the groups the first time and, for continuity, puts every existing user
into every site group and the bootstrap admin (`bryan.chaikin@swagelok.com`) into `admins`.
Enforcement in the other sites is switched on separately in their own repos.
