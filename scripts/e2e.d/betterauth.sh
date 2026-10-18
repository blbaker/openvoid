# Extra e2e scenario: OPENVOID_AUTH=better-auth
#   scripts/e2e.sh betterauth
# Needs `scripts/e2e.d/README.md`'s helpers (log, wait_http, smoke, start_bg, service_env,
# fresh_database) from the sourcing scripts/e2e.sh.
scenario_betterauth() {
  log "betterauth: notes (SQLite) with OPENVOID_AUTH=better-auth"
  local port=3430 base="http://127.0.0.1:3430"
  local jar="$WORK/betterauth-cookies.txt"
  local secret=e2e-better-auth-secret-at-least-32-characters-long

  start_bg "$WORK/betterauth.log" \
    "cd '$ROOT/examples/notes' && OPENVOID_DATA_DIR='$WORK/betterauth-data' OPENVOID_AUTH=better-auth OPENVOID_PUBLIC_URL='$base' BETTER_AUTH_SECRET=$secret OPENVOID_AUTH_GOOGLE_CLIENT_ID=e2e-client-id OPENVOID_AUTH_GOOGLE_CLIENT_SECRET=e2e-client-secret HOST=127.0.0.1 PORT=$port exec node dist/ssr/index.js"
  wait_http "$base/api/health"
  smoke "$base"

  test "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/me")" = 401
  echo "PASS  anonymous /api/me is 401 before signing in"

  curl -sf -c "$jar" -X POST "$base/auth/sign-up/email" -H 'content-type: application/json' \
    -d '{"email":"doc@example.com","password":"sekrit123","name":"Doc"}' >"$WORK/betterauth-signup.json"
  grep -q '"email":"doc@example.com"' "$WORK/betterauth-signup.json"
  echo "PASS  sign-up created the user and started a session"

  curl -sf -b "$jar" "$base/api/me" >"$WORK/betterauth-me.json"
  grep -q '"email":"doc@example.com"' "$WORK/betterauth-me.json"
  grep -q '"provider":"local"' "$WORK/betterauth-me.json"
  echo "PASS  /api/me returns the signed-in user"

  local jar2="$WORK/betterauth-cookies2.txt"
  curl -sf -c "$jar2" -X POST "$base/auth/sign-in/email" -H 'content-type: application/json' \
    -d '{"email":"doc@example.com","password":"sekrit123"}' >"$WORK/betterauth-signin.json"
  grep -q '"email":"doc@example.com"' "$WORK/betterauth-signin.json"
  echo "PASS  sign-in works with the same credentials"

  test "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar2" "$base/auth/login/google?returnTo=/")" = 302
  echo "PASS  GET /auth/login/google redirects to start social sign-in"

  curl -sf -b "$jar" -X POST "$base/auth/logout" -o /dev/null
  test "$(curl -s -o /dev/null -w '%{http_code}' -b "$jar" "$base/api/me")" = 401
  echo "PASS  sign-out ends the session, /api/me is 401 again"

  betterauth_dex_leg "$secret"

  # Best effort: the same flow against notes-pg (PostgreSQL), when scripts/services.sh is up.
  if docker exec "${OPENVOID_SERVICES_PREFIX:-openvoid-test}-pg" pg_isready -U openvoid -d openvoid >/dev/null 2>&1; then
    log "betterauth: notes-pg (PostgreSQL) with OPENVOID_AUTH=better-auth"
    service_env
    local pgport=3431 pgbase="http://127.0.0.1:3431" pgjar="$WORK/betterauth-pg-cookies.txt"
    export DATABASE_URL=$(fresh_database betterauth)
    start_bg "$WORK/betterauth-pg.log" \
      "cd '$ROOT/examples/notes-pg' && OPENVOID_DATA_DIR='$WORK/betterauth-pg-data' OPENVOID_AUTH=better-auth OPENVOID_PUBLIC_URL='$pgbase' BETTER_AUTH_SECRET=$secret OPENVOID_AUTH_GOOGLE_CLIENT_ID=e2e-client-id OPENVOID_AUTH_GOOGLE_CLIENT_SECRET=e2e-client-secret HOST=127.0.0.1 PORT=$pgport exec node dist/ssr/index.js"
    wait_http "$pgbase/api/health"
    smoke "$pgbase"
    curl -sf -c "$pgjar" -X POST "$pgbase/auth/sign-up/email" -H 'content-type: application/json' \
      -d '{"email":"doc@example.com","password":"sekrit123","name":"Doc"}' >"$WORK/betterauth-pg-signup.json"
    grep -q '"email":"doc@example.com"' "$WORK/betterauth-pg-signup.json"
    curl -sf -b "$pgjar" "$pgbase/api/me" >"$WORK/betterauth-pg-me.json"
    grep -q '"email":"doc@example.com"' "$WORK/betterauth-pg-me.json"
    test "$(curl -s -o /dev/null -w '%{http_code}' -b "$pgjar" "$pgbase/auth/login/google?returnTo=/")" = 302
    curl -sf -b "$pgjar" -X POST "$pgbase/auth/logout" -o /dev/null
    test "$(curl -s -o /dev/null -w '%{http_code}' -b "$pgjar" "$pgbase/api/me")" = 401
    echo "PASS  same flow against notes-pg on PostgreSQL"
    unset DATABASE_URL
  else
    echo "SKIP  notes-pg (PostgreSQL): services not up (scripts/services.sh up)"
  fi
}

# genericOAuth against a real OIDC provider: Dex with its mockCallback connector, which signs in
# a fixed user (kilgore@kilgore.trout, groups ["authors"]) without a login form, so curl can
# drive the whole authorization-code flow: discovery, PKCE, nonce, token exchange, ID token check.
betterauth_dex_leg() {
  local secret=$1
  local image=ghcr.io/dexidp/dex:v2.45.1
  local name="${OPENVOID_SERVICES_PREFIX:-openvoid-test}-e2e-dex"
  local dexport=${OPENVOID_E2E_DEX_PORT:-45556} port=3432
  local base="http://127.0.0.1:$port" issuer="http://127.0.0.1:$dexport/dex"
  if ! docker image inspect "$image" >/dev/null 2>&1 && ! docker pull -q "$image" >/dev/null 2>&1; then
    echo "SKIP  OIDC through Dex: $image not available"
    return 0
  fi
  log "betterauth: notes with an OIDC provider (Dex) through genericOAuth"
  cat >"$WORK/dex.yaml" <<EOF
issuer: $issuer
storage:
  type: memory
web:
  http: 0.0.0.0:5556
oauth2:
  skipApprovalScreen: true
staticClients:
  - id: openvoid-e2e
    secret: openvoid-e2e-secret
    name: OpenVoid e2e
    redirectURIs: ["$base/auth/callback/dex"]
connectors:
  - type: mockCallback
    id: mock
    name: Mock
EOF
  chmod 644 "$WORK/dex.yaml"
  docker rm -f "$name" >/dev/null 2>&1 || true
  CONTAINERS+=("$name")
  docker run -d --name "$name" -p "127.0.0.1:$dexport:5556" -v "$WORK/dex.yaml:/etc/dex/openvoid.yaml:ro" \
    "$image" dex serve /etc/dex/openvoid.yaml >/dev/null
  wait_http "$issuer/.well-known/openid-configuration" 30

  start_bg "$WORK/betterauth-dex.log" \
    "cd '$ROOT/examples/notes' && OPENVOID_DATA_DIR='$WORK/betterauth-dex-data' OPENVOID_AUTH=better-auth OPENVOID_PUBLIC_URL='$base' BETTER_AUTH_SECRET=$secret OPENVOID_AUTH_OIDC_PROVIDERS=dex OPENVOID_AUTH_OIDC_DEX_ISSUER='$issuer' OPENVOID_AUTH_OIDC_DEX_CLIENT_ID=openvoid-e2e OPENVOID_AUTH_OIDC_DEX_CLIENT_SECRET=openvoid-e2e-secret OPENVOID_AUTH_OIDC_DEX_SCOPES='openid profile email groups' HOST=127.0.0.1 PORT=$port exec node dist/ssr/index.js"
  wait_http "$base/api/health"

  local jar="$WORK/betterauth-dex-cookies.txt"
  # -L follows app -> Dex authorize -> mock connector -> app callback -> returnTo (/api/me).
  curl -sfL -c "$jar" -b "$jar" "$base/auth/login/dex?returnTo=/api/me" >"$WORK/betterauth-dex-me.json"
  cat "$WORK/betterauth-dex-me.json"; echo
  grep -q '"id":"dex:' "$WORK/betterauth-dex-me.json"
  grep -q '"provider":"dex"' "$WORK/betterauth-dex-me.json"
  grep -q '"email":"kilgore@kilgore.trout"' "$WORK/betterauth-dex-me.json"
  echo "PASS  OIDC sign-in through Dex lands on returnTo with a dex:<subject> user"
  grep -q '"groups":\["authors"\]' "$WORK/betterauth-dex-me.json"
  echo "PASS  groups come from the provider's groups claim"

  # A second sign-in for the same account updates it instead of creating a new user.
  local jar2="$WORK/betterauth-dex-cookies2.txt"
  curl -sfL -c "$jar2" -b "$jar2" "$base/auth/login/dex?returnTo=/api/me" >"$WORK/betterauth-dex-me2.json"
  test "$(grep -o '"id":"[^"]*"' "$WORK/betterauth-dex-me.json")" = "$(grep -o '"id":"[^"]*"' "$WORK/betterauth-dex-me2.json")"
  grep -q '"groups":\["authors"\]' "$WORK/betterauth-dex-me2.json"
  echo "PASS  signing in again keeps the same id and groups"
}
