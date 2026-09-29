// CloudFront distribution config for admin.swageloklabs.com: S3 site + /api/* -> API Gateway, both
// behind the Lambda@Edge authorizer. Used by deploy.sh (no jq on the dev VM).
//
//   node cf-config.mjs build  <out.json> <params.json>             full config for create-distribution
//   node cf-config.mjs patch  <in-out.json> <params.json>          update an existing DistributionConfig in place
//
// params.json: { domain, bucketDomain, oacId, apiDomain, certArn, edgeArn, comment }
import { readFileSync, writeFileSync } from 'node:fs'

const [mode, file, paramsFile] = process.argv.slice(2)
const p = JSON.parse(readFileSync(paramsFile, 'utf8'))

const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6'
const CACHING_DISABLED = '4135ea2d-6df8-44a3-9df3-4b5a84be39ad'
const ALL_VIEWER_EXCEPT_HOST = 'b689b0a8-53d0-40ab-baf2-68738e2966ac'
const SECURITY_HEADERS = '67f7725c-6f97-4210-82d7-5512b31e9d03'

const edge = { Quantity: 1, Items: [{ EventType: 'viewer-request', LambdaFunctionARN: p.edgeArn, IncludeBody: false }] }
const s3Origin = {
  Id: 's3-site',
  DomainName: p.bucketDomain,
  OriginPath: '',
  CustomHeaders: { Quantity: 0 },
  OriginAccessControlId: p.oacId,
  S3OriginConfig: { OriginAccessIdentity: '' },
}
const apiOrigin = {
  Id: 'api',
  DomainName: p.apiDomain,
  OriginPath: '',
  CustomHeaders: { Quantity: 0 },
  CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: 'https-only', OriginSslProtocols: { Quantity: 1, Items: ['TLSv1.2'] } },
}
const methodsAll = { Quantity: 7, Items: ['GET', 'HEAD', 'OPTIONS', 'PUT', 'POST', 'PATCH', 'DELETE'], CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } }
const methodsRead = { Quantity: 2, Items: ['GET', 'HEAD'], CachedMethods: { Quantity: 2, Items: ['GET', 'HEAD'] } }

const apiBehavior = {
  PathPattern: '/api/*',
  TargetOriginId: 'api',
  ViewerProtocolPolicy: 'https-only',
  Compress: true,
  AllowedMethods: methodsAll,
  CachePolicyId: CACHING_DISABLED,
  OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST,
  LambdaFunctionAssociations: edge,
  FunctionAssociations: { Quantity: 0 },
  SmoothStreaming: false,
  FieldLevelEncryptionId: '',
}
const defaultBehavior = {
  TargetOriginId: 's3-site',
  ViewerProtocolPolicy: 'redirect-to-https',
  Compress: true,
  AllowedMethods: methodsRead,
  CachePolicyId: CACHING_OPTIMIZED,
  ResponseHeadersPolicyId: SECURITY_HEADERS,
  LambdaFunctionAssociations: edge,
  FunctionAssociations: { Quantity: 0 },
  SmoothStreaming: false,
  FieldLevelEncryptionId: '',
}

if (mode === 'build') {
  const cfg = {
    CallerReference: `labs-admin-${Date.now()}`,
    Comment: p.comment,
    Enabled: true,
    Aliases: { Quantity: 1, Items: [p.domain] },
    DefaultRootObject: 'index.html',
    HttpVersion: 'http2and3',
    IsIPV6Enabled: true,
    PriceClass: 'PriceClass_All',
    Origins: { Quantity: 2, Items: [s3Origin, apiOrigin] },
    DefaultCacheBehavior: defaultBehavior,
    CacheBehaviors: { Quantity: 1, Items: [apiBehavior] },
    CustomErrorResponses: {
      Quantity: 2,
      Items: [
        { ErrorCode: 403, ResponsePagePath: '/index.html', ResponseCode: '200', ErrorCachingMinTTL: 10 },
        { ErrorCode: 404, ResponsePagePath: '/index.html', ResponseCode: '200', ErrorCachingMinTTL: 10 },
      ],
    },
    ViewerCertificate: { ACMCertificateArn: p.certArn, SSLSupportMethod: 'sni-only', MinimumProtocolVersion: 'TLSv1.2_2021' },
  }
  writeFileSync(file, JSON.stringify(cfg))
} else if (mode === 'patch') {
  const cfg = JSON.parse(readFileSync(file, 'utf8'))
  cfg.Origins = { Quantity: 2, Items: [s3Origin, apiOrigin] }
  cfg.DefaultCacheBehavior = { ...cfg.DefaultCacheBehavior, ...defaultBehavior }
  cfg.CacheBehaviors = { Quantity: 1, Items: [apiBehavior] }
  writeFileSync(file, JSON.stringify(cfg))
} else {
  console.error('usage: cf-config.mjs build|patch <file> <params.json>')
  process.exit(2)
}
