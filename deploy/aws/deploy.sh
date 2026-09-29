#!/usr/bin/env bash
# Provision and publish https://admin.swageloklabs.com (Swagelok Labs Admin).
#
#   deploy/aws/deploy.sh            # everything: infra, auth, groups, build, upload
#   deploy/aws/deploy.sh status     # read-only inventory
#   deploy/aws/deploy.sh infra      # app client, bucket, DynamoDB, API Lambda + HTTP API, edge Lambda, CloudFront, DNS
#   deploy/aws/deploy.sh auth       # rebuild + publish the Lambda@Edge authorizer and re-attach it
#   deploy/aws/deploy.sh groups     # create the Cognito groups and bootstrap the first admin
#   deploy/aws/deploy.sh upload     # build web + API, update Lambda code, sync S3, invalidate
#
# Idempotent: every step checks for its resource first. Needs an AWS CLI session in account
# 496210974629 (us-east-1) and Node on PATH. Run under Git Bash; from PowerShell:
#   & C:\Users\bryan\tools\git\bin\bash.exe C:/Users/bryan/source/swagelok-labs-admin/deploy/aws/deploy.sh <mode>
set -euo pipefail
export MSYS_NO_PATHCONV=1
export AWS_PAGER=""

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="${1:-all}"

ACCOUNT=496210974629
REGION=us-east-1
DOMAIN=admin.swageloklabs.com
SITE_NAME="Swagelok Labs Admin"
SITE_URL="https://${DOMAIN}"
ZONE_ID=Z05265941PFZO4KDFMYZ8
CERT_ARN=arn:aws:acm:us-east-1:${ACCOUNT}:certificate/699eaebc-603d-4c91-86fb-f9a4886e8508
CF_HOSTED_ZONE=Z2FDTNDATAQYW2

USER_POOL_ID=us-east-1_65EMdls09
USER_POOL_ARN="arn:aws:cognito-idp:${REGION}:${ACCOUNT}:userpool/${USER_POOL_ID}"
USER_POOL_DOMAIN="swageloklabs-auth.auth.${REGION}.amazoncognito.com"
CLIENT_NAME=labs-admin
PARSE_AUTH_PATH=/parseauth
REFRESH_DAYS=30

BUCKET=swagelok-labs-admin-${ACCOUNT}
OAC_NAME=swagelok-labs-admin-oac
TABLE=swagelok-labs-admin-audit
API_ROLE=swagelok-labs-admin-api
API_FUNCTION=swagelok-labs-admin-api
API_NAME=swagelok-labs-admin
EDGE_ROLE=swagelok-labs-admin-edge-auth
EDGE_FUNCTION=swagelok-labs-admin-edge-auth
NONCE_PARAM=/swagelok-labs-admin/edge-auth/nonce-secret

ADMIN_GROUP=admins
SITE_GROUPS=(app:locator app:sscexpert app:portfolioplanner)
BOOTSTRAP_ADMIN=bryan.chaikin@swagelok.com

aws() { command aws --region "$REGION" --output text "$@" | tr -d '\r'; }
awsjson() { command aws --region "$REGION" --output json "$@" | tr -d '\r'; }
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
log() { printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

require_login() {
  local who
  who=$(aws sts get-caller-identity --query Account 2>/dev/null || true)
  [[ "$who" == "$ACCOUNT" ]] || { echo "Not signed in to account $ACCOUNT (got '${who:-none}'). Run: aws login" >&2; exit 1; }
}

# ---------------------------------------------------------------- Cognito ----
find_client() {
  aws cognito-idp list-user-pool-clients --user-pool-id "$USER_POOL_ID" --max-results 60 \
    --query "UserPoolClients[?ClientName=='${CLIENT_NAME}'].ClientId | [0]" | sed 's/^None$//'
}
ensure_client() {
  log "Cognito app client '${CLIENT_NAME}'"
  CLIENT_ID=$(find_client)
  if [[ -n "$CLIENT_ID" ]]; then echo "exists: $CLIENT_ID"; return; fi
  # Public client (no secret): cognito-at-edge uses PKCE, and the API verifies id tokens by pool + client id.
  CLIENT_ID=$(aws cognito-idp create-user-pool-client --user-pool-id "$USER_POOL_ID" --client-name "$CLIENT_NAME" \
    --no-generate-secret --supported-identity-providers COGNITO \
    --callback-urls "${SITE_URL}${PARSE_AUTH_PATH}" --logout-urls "${SITE_URL}/" \
    --allowed-o-auth-flows code --allowed-o-auth-scopes openid email profile --allowed-o-auth-flows-user-pool-client \
    --prevent-user-existence-errors ENABLED --refresh-token-validity "$REFRESH_DAYS" --token-validity-units RefreshToken=days \
    --explicit-auth-flows ALLOW_REFRESH_TOKEN_AUTH --query UserPoolClient.ClientId)
  echo "created: $CLIENT_ID"
}

ensure_nonce_secret() {
  log "Nonce signing secret (SSM ${NONCE_PARAM})"
  if NONCE_SECRET=$(aws ssm get-parameter --name "$NONCE_PARAM" --with-decryption --query Parameter.Value 2>/dev/null) && [[ -n "$NONCE_SECRET" ]]; then
    echo "exists"
  else
    NONCE_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    aws ssm put-parameter --name "$NONCE_PARAM" --type SecureString --value "$NONCE_SECRET" --description "cognito-at-edge nonce secret for ${DOMAIN}" >/dev/null
    echo "created"
  fi
}

ensure_groups() {
  log "Cognito groups"
  local existing g created=()
  existing=$(aws cognito-idp list-groups --user-pool-id "$USER_POOL_ID" --query "Groups[].GroupName")
  for g in "$ADMIN_GROUP" "${SITE_GROUPS[@]}"; do
    if grep -qw -- "$g" <<<"$existing"; then echo "exists: $g"; continue; fi
    local desc="Members may open ${g#app:}.swageloklabs.com"
    [[ "$g" == "$ADMIN_GROUP" ]] && desc="May use ${SITE_NAME} (${DOMAIN})"
    aws cognito-idp create-group --user-pool-id "$USER_POOL_ID" --group-name "$g" --description "$desc" --query Group.GroupName
    created+=("$g")
    echo "created: $g"
  done
  # Continuity: when a site group is brand new, everyone already in the pool keeps their access.
  if ((${#created[@]})); then
    local users u
    users=$(aws cognito-idp list-users --user-pool-id "$USER_POOL_ID" --query "Users[].Username")
    for g in "${created[@]}"; do
      [[ "$g" == "$ADMIN_GROUP" ]] && continue
      for u in $users; do
        aws cognito-idp admin-add-user-to-group --user-pool-id "$USER_POOL_ID" --username "$u" --group-name "$g"
      done
      echo "added all $(wc -w <<<"$users") existing users to $g"
    done
  fi
  log "Bootstrap admin ${BOOTSTRAP_ADMIN}"
  local sub
  sub=$(aws cognito-idp admin-get-user --user-pool-id "$USER_POOL_ID" --username "$BOOTSTRAP_ADMIN" --query Username 2>/dev/null || true)
  if [[ -z "$sub" ]]; then echo "user not found in pool; skipping"; return; fi
  for g in "$ADMIN_GROUP" "${SITE_GROUPS[@]}"; do
    aws cognito-idp admin-add-user-to-group --user-pool-id "$USER_POOL_ID" --username "$sub" --group-name "$g"
  done
  echo "in groups: $(aws cognito-idp admin-list-groups-for-user --user-pool-id "$USER_POOL_ID" --username "$sub" --query "Groups[].GroupName" | tr '\t' ' ')"
}

# --------------------------------------------------------------------- S3 ----
ensure_bucket() {
  log "S3 bucket $BUCKET"
  if command aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1; then echo "exists"; else
    command aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null; echo "created"; fi
  command aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  command aws s3api put-bucket-encryption --bucket "$BUCKET" \
    --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
}

# --------------------------------------------------------------- DynamoDB ----
ensure_table() {
  log "DynamoDB table $TABLE"
  if aws dynamodb describe-table --table-name "$TABLE" --query Table.TableStatus >/dev/null 2>&1; then echo "exists"; return; fi
  aws dynamodb create-table --table-name "$TABLE" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
    --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE --query TableDescription.TableStatus
  aws dynamodb wait table-exists --table-name "$TABLE"
  echo "created"
}

# -------------------------------------------------------------- API Lambda ----
ensure_api_role() {
  log "IAM role $API_ROLE"
  if API_ROLE_ARN=$(aws iam get-role --role-name "$API_ROLE" --query Role.Arn 2>/dev/null); then echo "exists: $API_ROLE_ARN"; else
    API_ROLE_ARN=$(aws iam create-role --role-name "$API_ROLE" --description "Swagelok Labs Admin API" \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' --query Role.Arn)
    aws iam attach-role-policy --role-name "$API_ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    echo "created: $API_ROLE_ARN (waiting for IAM propagation)"; NEW_ROLE=1; fi
  aws iam put-role-policy --role-name "$API_ROLE" --policy-name admin-api --policy-document "{
    \"Version\":\"2012-10-17\",\"Statement\":[
      {\"Effect\":\"Allow\",\"Action\":[\"cognito-idp:ListUsers\",\"cognito-idp:ListGroups\",\"cognito-idp:ListUsersInGroup\",\"cognito-idp:CreateGroup\",
        \"cognito-idp:AdminGetUser\",\"cognito-idp:AdminCreateUser\",\"cognito-idp:AdminDeleteUser\",\"cognito-idp:AdminEnableUser\",\"cognito-idp:AdminDisableUser\",
        \"cognito-idp:AdminResetUserPassword\",\"cognito-idp:AdminSetUserMFAPreference\",\"cognito-idp:AdminUserGlobalSignOut\",\"cognito-idp:AdminUpdateUserAttributes\",
        \"cognito-idp:AdminAddUserToGroup\",\"cognito-idp:AdminRemoveUserFromGroup\",\"cognito-idp:AdminListGroupsForUser\"],
       \"Resource\":\"${USER_POOL_ARN}\"},
      {\"Effect\":\"Allow\",\"Action\":[\"dynamodb:PutItem\",\"dynamodb:Query\"],\"Resource\":\"arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE}\"}]}"
  [[ "${NEW_ROLE:-}" == 1 ]] && sleep 12 || true
}

build_api() {
  log "Build API"
  ( cd "$ROOT/api" && { [[ -d node_modules ]] || npm install --no-audit --no-fund; } && node build.mjs )
  API_ZIP="$ROOT/api/dist/api.zip"
}

ensure_api_lambda() {
  log "Lambda $API_FUNCTION"
  local zipfile="fileb://$(winpath "$API_ZIP")"
  local env="Variables={USER_POOL_ID=${USER_POOL_ID},CLIENT_ID=${CLIENT_ID},AUDIT_TABLE=${TABLE},SITE_ORIGIN=${SITE_URL}}"
  if aws lambda get-function --function-name "$API_FUNCTION" --query Configuration.FunctionArn >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$API_FUNCTION" --zip-file "$zipfile" --query LastUpdateStatus
    aws lambda wait function-updated --function-name "$API_FUNCTION"
    aws lambda update-function-configuration --function-name "$API_FUNCTION" --environment "$env" --timeout 25 --memory-size 256 --query LastUpdateStatus
  else
    local tries=0
    until aws lambda create-function --function-name "$API_FUNCTION" --runtime nodejs20.x --handler index.handler --role "$API_ROLE_ARN" \
        --zip-file "$zipfile" --timeout 25 --memory-size 256 --environment "$env" --description "Swagelok Labs Admin API" --query FunctionArn; do
      tries=$((tries + 1)); [[ $tries -lt 6 ]] || { echo "create-function keeps failing" >&2; exit 1; }
      echo "retrying create-function (IAM propagation)…"; sleep 10
    done
  fi
  aws lambda wait function-updated --function-name "$API_FUNCTION"
  API_LAMBDA_ARN=$(aws lambda get-function --function-name "$API_FUNCTION" --query Configuration.FunctionArn)
}

ensure_http_api() {
  log "HTTP API $API_NAME"
  API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]" | sed 's/^None$//')
  if [[ -n "$API_ID" ]]; then echo "exists: $API_ID"; else
    API_ID=$(aws apigatewayv2 create-api --name "$API_NAME" --protocol-type HTTP --target "$API_LAMBDA_ARN" \
      --description "Swagelok Labs Admin API (behind CloudFront ${DOMAIN})" --query ApiId)
    echo "created: $API_ID"; fi
  aws lambda add-permission --function-name "$API_FUNCTION" --statement-id "apigw-${API_ID}" --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:${REGION}:${ACCOUNT}:${API_ID}/*" >/dev/null 2>&1 || true
  API_ENDPOINT=$(aws apigatewayv2 get-api --api-id "$API_ID" --query ApiEndpoint)
  API_DOMAIN=${API_ENDPOINT#https://}
  echo "endpoint: $API_ENDPOINT"
}

# ------------------------------------------------------------- Edge Lambda ----
build_edge() {
  log "Build Lambda@Edge authorizer"
  ( cd "$ROOT/deploy/aws/edge-auth" && { [[ -d node_modules ]] || npm install --no-audit --no-fund; } &&
    EDGE_REGION="$REGION" EDGE_USER_POOL_ID="$USER_POOL_ID" EDGE_USER_POOL_DOMAIN="$USER_POOL_DOMAIN" EDGE_CLIENT_ID="$CLIENT_ID" \
    EDGE_NONCE_SECRET="$NONCE_SECRET" EDGE_SITE_URL="$SITE_URL" EDGE_SITE_NAME="$SITE_NAME" EDGE_REQUIRED_GROUP="$ADMIN_GROUP" \
    EDGE_COOKIE_DAYS="$REFRESH_DAYS" node build.mjs )
  EDGE_ZIP="$ROOT/deploy/aws/edge-auth/dist/edge-auth.zip"
}

ensure_edge_role() {
  log "IAM role $EDGE_ROLE"
  if EDGE_ROLE_ARN=$(aws iam get-role --role-name "$EDGE_ROLE" --query Role.Arn 2>/dev/null); then echo "exists: $EDGE_ROLE_ARN"; else
    EDGE_ROLE_ARN=$(aws iam create-role --role-name "$EDGE_ROLE" --description "Lambda@Edge authorizer for ${DOMAIN}" \
      --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":["lambda.amazonaws.com","edgelambda.amazonaws.com"]},"Action":"sts:AssumeRole"}]}' --query Role.Arn)
    aws iam attach-role-policy --role-name "$EDGE_ROLE" --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    echo "created: $EDGE_ROLE_ARN (waiting for IAM propagation)"; sleep 12; fi
}

ensure_edge_lambda() {
  log "Lambda $EDGE_FUNCTION (us-east-1, Lambda@Edge)"
  local zipfile="fileb://$(winpath "$EDGE_ZIP")"
  if aws lambda get-function --function-name "$EDGE_FUNCTION" --query Configuration.FunctionArn >/dev/null 2>&1; then
    aws lambda update-function-code --function-name "$EDGE_FUNCTION" --zip-file "$zipfile" --query LastUpdateStatus
  else
    local tries=0
    until aws lambda create-function --function-name "$EDGE_FUNCTION" --runtime nodejs20.x --handler index.handler --role "$EDGE_ROLE_ARN" \
        --zip-file "$zipfile" --timeout 5 --memory-size 128 --description "cognito-at-edge + admins group gate for ${DOMAIN}" --query FunctionArn; do
      tries=$((tries + 1)); [[ $tries -lt 6 ]] || { echo "create-function keeps failing" >&2; exit 1; }
      echo "retrying create-function (IAM propagation)…"; sleep 10
    done
  fi
  aws lambda wait function-updated --function-name "$EDGE_FUNCTION"
  EDGE_VERSION_ARN=$(aws lambda publish-version --function-name "$EDGE_FUNCTION" --query FunctionArn)
  echo "published: $EDGE_VERSION_ARN"
}

# -------------------------------------------------------------- CloudFront ----
find_distribution() {
  awsjson cloudfront list-distributions --query "DistributionList.Items[?contains(Aliases.Items, '${DOMAIN}')].Id | [0]" 2>/dev/null | tr -d '"' | sed 's/^null$//'
}
ensure_oac() {
  local id
  id=$(awsjson cloudfront list-origin-access-controls --query "OriginAccessControlList.Items[?Name=='${OAC_NAME}'].Id | [0]" | tr -d '"' | sed 's/^null$//')
  if [[ -z "$id" ]]; then
    id=$(awsjson cloudfront create-origin-access-control --origin-access-control-config \
      "{\"Name\":\"${OAC_NAME}\",\"Description\":\"S3 access for ${SITE_NAME}\",\"SigningProtocol\":\"sigv4\",\"SigningBehavior\":\"always\",\"OriginAccessControlOriginType\":\"s3\"}" \
      --query OriginAccessControl.Id | tr -d '"')
  fi
  echo "$id"
}
write_params() {
  PARAMS="$ROOT/deploy/aws/.cf-params.json"
  cat > "$PARAMS" <<JSON
{"domain":"${DOMAIN}","bucketDomain":"${BUCKET}.s3.${REGION}.amazonaws.com","oacId":"$(ensure_oac)","apiDomain":"${API_DOMAIN}","certArn":"${CERT_ARN}","edgeArn":"${EDGE_VERSION_ARN}","comment":"${SITE_NAME} (${DOMAIN})"}
JSON
}
ensure_distribution() {
  log "CloudFront distribution for $DOMAIN"
  write_params
  local cfg="$ROOT/deploy/aws/.cf-config.json"
  DIST_ID=$(find_distribution)
  if [[ -z "$DIST_ID" ]]; then
    node "$(winpath "$ROOT/deploy/aws/cf-config.mjs")" build "$(winpath "$cfg")" "$(winpath "$PARAMS")"
    DIST_ID=$(awsjson cloudfront create-distribution --distribution-config "file://$(winpath "$cfg")" --query Distribution.Id | tr -d '"')
    echo "created: $DIST_ID"
  else
    local etag
    awsjson cloudfront get-distribution-config --id "$DIST_ID" > "$cfg"
    etag=$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).ETag)" "$(winpath "$cfg")")
    node -e "const fs=require('fs');const f=process.argv[1];fs.writeFileSync(f,JSON.stringify(JSON.parse(fs.readFileSync(f,'utf8')).DistributionConfig))" "$(winpath "$cfg")"
    node "$(winpath "$ROOT/deploy/aws/cf-config.mjs")" patch "$(winpath "$cfg")" "$(winpath "$PARAMS")"
    aws cloudfront update-distribution --id "$DIST_ID" --if-match "$etag" --distribution-config "file://$(winpath "$cfg")" --query Distribution.Status
    echo "updated: $DIST_ID"
  fi
  rm -f "$cfg" "$PARAMS"
  DIST_DOMAIN=$(aws cloudfront get-distribution --id "$DIST_ID" --query Distribution.DomainName)
  command aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"AllowCloudFrontRead\",\"Effect\":\"Allow\",
    \"Principal\":{\"Service\":\"cloudfront.amazonaws.com\"},\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::${BUCKET}/*\",
    \"Condition\":{\"StringEquals\":{\"AWS:SourceArn\":\"arn:aws:cloudfront::${ACCOUNT}:distribution/${DIST_ID}\"}}}]}"
}

ensure_dns() {
  log "Route 53 $DOMAIN -> $DIST_DOMAIN"
  local current
  current=$(aws route53 list-resource-record-sets --hosted-zone-id "$ZONE_ID" --query "ResourceRecordSets[?Name=='${DOMAIN}.' && Type=='A'].AliasTarget.DNSName | [0]" 2>/dev/null || true)
  if [[ "$current" == "${DIST_DOMAIN}." ]]; then echo "up to date"; return; fi
  aws route53 change-resource-record-sets --hosted-zone-id "$ZONE_ID" --change-batch "{\"Changes\":[
    {\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"${DOMAIN}\",\"Type\":\"A\",\"AliasTarget\":{\"HostedZoneId\":\"${CF_HOSTED_ZONE}\",\"DNSName\":\"${DIST_DOMAIN}\",\"EvaluateTargetHealth\":false}}},
    {\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"${DOMAIN}\",\"Type\":\"AAAA\",\"AliasTarget\":{\"HostedZoneId\":\"${CF_HOSTED_ZONE}\",\"DNSName\":\"${DIST_DOMAIN}\",\"EvaluateTargetHealth\":false}}}]}" --query ChangeInfo.Status
}

# ------------------------------------------------------------------ Web ----
build_web() {
  log "Build web"
  ( cd "$ROOT" && { [[ -d node_modules ]] || npm install --no-audit --no-fund; } && npm run build )
}
upload_web() {
  log "Upload to s3://$BUCKET"
  ( cd "$ROOT" &&
    command aws s3 sync dist/assets "s3://${BUCKET}/assets" --delete --cache-control "public,max-age=31536000,immutable" &&
    command aws s3 sync dist "s3://${BUCKET}" --delete --exclude "assets/*" --cache-control "public,max-age=0,must-revalidate" )
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" --query Invalidation.Status
}

# ---------------------------------------------------------------- Modes ----
status() {
  require_login
  log "Status"
  echo "app client:    $(find_client || echo missing)"
  echo "bucket:        $(command aws s3api head-bucket --bucket "$BUCKET" >/dev/null 2>&1 && echo present || echo missing)"
  echo "table:         $(aws dynamodb describe-table --table-name "$TABLE" --query Table.TableStatus 2>/dev/null || echo missing)"
  echo "api lambda:    $(aws lambda get-function --function-name "$API_FUNCTION" --query Configuration.FunctionArn 2>/dev/null || echo missing)"
  echo "http api:      $(aws apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiEndpoint | [0]" 2>/dev/null || echo missing)"
  echo "edge lambda:   $(aws lambda get-function --function-name "$EDGE_FUNCTION" --query Configuration.FunctionArn 2>/dev/null || echo missing)"
  local id; id=$(find_distribution)
  echo "distribution:  ${id:-missing} $( [[ -n "$id" ]] && aws cloudfront get-distribution --id "$id" --query "Distribution.[Status,DomainName]" | tr '\t' ' ')"
  echo "groups:        $(aws cognito-idp list-groups --user-pool-id "$USER_POOL_ID" --query "Groups[].GroupName" | tr '\t' ' ')"
  echo "url:           ${SITE_URL}/"
}

infra() {
  ensure_client; ensure_nonce_secret; ensure_bucket; ensure_table
  ensure_api_role; build_api; ensure_api_lambda; ensure_http_api
  ensure_edge_role; build_edge; ensure_edge_lambda
  ensure_distribution; ensure_dns
}
auth() {
  ensure_client; ensure_nonce_secret; ensure_edge_role; build_edge; ensure_edge_lambda
  API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='${API_NAME}'].ApiId | [0]"); API_DOMAIN=$(aws apigatewayv2 get-api --api-id "$API_ID" --query ApiEndpoint); API_DOMAIN=${API_DOMAIN#https://}
  ensure_distribution
}
upload() {
  ensure_client; DIST_ID=$(find_distribution); [[ -n "$DIST_ID" ]] || { echo "no distribution; run infra first" >&2; exit 1; }
  ensure_api_role; build_api; ensure_api_lambda; build_web; upload_web
}

case "$MODE" in
  status) status ;;
  infra)  require_login; infra ;;
  auth)   require_login; auth ;;
  groups) require_login; ensure_groups ;;
  upload) require_login; upload ;;
  all)    require_login; infra; ensure_groups; build_web; upload_web
          echo; echo "Done: ${SITE_URL}/ (CloudFront takes a few minutes on first deploy)" ;;
  *) echo "usage: $0 [all|status|infra|auth|groups|upload]" >&2; exit 2 ;;
esac
