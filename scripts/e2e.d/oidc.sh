# oidc: notes with OPENVOID_AUTH=oidc, signed in for real through a Dex container (no browser,
# no mocking of the identity provider side). Host ports 3410 for the app, 55560 for Dex.
scenario_oidc() {
  log "oidc: notes with OPENVOID_AUTH=oidc against a real Dex container"
  local port=3410 dex_port=55560
  local base="http://127.0.0.1:$port"
  local issuer="http://127.0.0.1:$dex_port/dex"

  docker rm -f openvoid-a-dex >/dev/null 2>&1 || true
  CONTAINERS+=(openvoid-a-dex)
  docker run -d --name openvoid-a-dex -p "127.0.0.1:$dex_port:5556" \
    -v "$ROOT/recipes/auth-oidc/dev/config.yaml:/etc/dex/config.yaml:ro" \
    ghcr.io/dexidp/dex:v2.45.1 dex serve /etc/dex/config.yaml >/dev/null
  wait_http "$issuer/.well-known/openid-configuration" 30

  start_bg "$WORK/oidc.log" "cd '$ROOT/examples/notes' && OPENVOID_DATA_DIR='$WORK/oidc-data' OPENVOID_PUBLIC_URL='$base' OPENVOID_AUTH=oidc OPENVOID_AUTH_OIDC_ALLOW_HTTP=1 OPENVOID_AUTH_OIDC_PROVIDERS=family OPENVOID_AUTH_OIDC_FAMILY_ISSUER='$issuer' OPENVOID_AUTH_OIDC_FAMILY_CLIENT_ID=openvoid-dev OPENVOID_AUTH_OIDC_FAMILY_CLIENT_SECRET=openvoid-dev-secret HOST=127.0.0.1 PORT=$port exec node dist/ssr/index.js"
  wait_http "$base/api/health"
  smoke "$base"

  test "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/me")" = 401
  echo "PASS  anonymous /api/me is 401 before sign-in"

  local cookie
  cookie=$(node "$ROOT/scripts/oidc-login.mjs" "$base" family doc@example.com password /api/me)
  echo "PASS  signed in through Dex's real login form (no browser, no mocking)"

  curl -sf -H "Cookie: $cookie" "$base/api/me" >"$WORK/me.json"
  grep -q '"provider":"family"' "$WORK/me.json"
  grep -q '"email":"doc@example.com"' "$WORK/me.json"
  echo "PASS  /api/me returns the Dex user"

  curl -sf -H "Cookie: $cookie" "$base/auth/session" >"$WORK/session.json"
  grep -q '"emailVerified":true' "$WORK/session.json"
  echo "PASS  /auth/session reflects the signed-in user"

  test "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "Cookie: $cookie" -H 'Origin: https://evil.test' "$base/auth/logout")" = 403
  echo "PASS  cross-site sign-out is rejected"

  curl -sf -X POST -H "Cookie: $cookie" -H "Origin: $base" "$base/auth/logout" >"$WORK/logout.json"
  grep -q '"ok":true' "$WORK/logout.json"
  echo "PASS  signed out"

  test "$(curl -s -o /dev/null -w '%{http_code}' -H "Cookie: $cookie" "$base/api/me")" = 401
  echo "PASS  /api/me is 401 again after sign-out"
}
