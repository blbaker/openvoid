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
