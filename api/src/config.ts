// Runtime configuration for the API Lambda. Everything comes from environment variables set by
// deploy/aws/deploy.sh (or by dev-server.mjs locally).

export type Site = { group: string; name: string; url: string }

export const ADMIN_GROUP = 'admins'

/** Sites whose access is controlled by a Cognito group. Order = display order. */
export const DEFAULT_SITES: Site[] = [
  { group: 'app:locator', name: 'SSC Locator', url: 'https://locator.swageloklabs.com' },
  { group: 'app:sscexpert', name: 'SSC Expert Finder', url: 'https://sscexpert.swageloklabs.com' },
  { group: 'app:portfolioplanner', name: 'Portfolio Planner', url: 'https://portfolioplanner.swageloklabs.com' },
  { group: 'app:markets', name: 'Market Atlas', url: 'https://markets.swageloklabs.com' },
]

function need(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`Missing environment variable ${name}`)
  return v
}

export function loadConfig() {
  return {
    region: process.env.AWS_REGION || 'us-east-1',
    userPoolId: need('USER_POOL_ID'),
    /** App client whose id tokens the admin site sets as cookies (the admin site's own client). */
    clientId: need('CLIENT_ID'),
    auditTable: need('AUDIT_TABLE'),
    /** Origin allowed to make state-changing calls, e.g. https://admin.swageloklabs.com */
    siteOrigin: need('SITE_ORIGIN'),
    sites: (process.env.SITES_JSON ? (JSON.parse(process.env.SITES_JSON) as Site[]) : DEFAULT_SITES),
    /** Development only: act as this email without a token. Never set on the Lambda. */
    devActor: process.env.ADMIN_DEV_ACTOR || null,
  }
}

export type Config = ReturnType<typeof loadConfig>
