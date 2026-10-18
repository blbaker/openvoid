#!/usr/bin/env bash
# openfga: OpenFGA authorization on top of proxy identity (examples/notes).
#
# OpenFGA has no identity provider of its own, so this reuses `proxy` mode (see scenario_proxy in
# scripts/e2e.sh) to sign users in with request headers; OPENVOID_FGA_SYNC_GROUPS=1 mirrors the
# proxy's groups header into OpenFGA group membership (via examples/notes/routes/api/docs/_fga.ts,
# since proxy mode has no sign-in event for `onSignIn` to hook — see recipes/authz-openfga).
scenario_openfga() {
  log "openfga: OpenFGA authorization (examples/notes, proxy identity)"
  local fga_port=46280 port=3420 base="http://127.0.0.1:3420" fga_name=openvoid-e2e-fga

  docker rm -f "$fga_name" >/dev/null 2>&1 || true
  docker run -d --name "$fga_name" -p "127.0.0.1:$fga_port:8080" openfga/openfga:v1.22.0 run >/dev/null
  CONTAINERS+=("$fga_name")
  wait_http "http://127.0.0.1:$fga_port/healthz" 30

  start_bg "$WORK/openfga.log" "cd '$ROOT/examples/notes' && \
    OPENVOID_DATA_DIR='$WORK/openfga-data' \
    OPENVOID_AUTH=proxy OPENVOID_AUTH_PROXY_SECRET=e2e-secret \
    OPENVOID_FGA_URL=http://127.0.0.1:$fga_port OPENVOID_FGA_STORE=openvoid-e2e OPENVOID_FGA_SYNC_GROUPS=1 \
    HOST=127.0.0.1 PORT=$port exec node dist/ssr/index.js"
  wait_http "$base/api/health" 30
  smoke "$base"

  local secret=(-H 'x-openvoid-proxy-secret: e2e-secret')
  local alice=("${secret[@]}" -H 'x-forwarded-user: alice')
  local bob=("${secret[@]}" -H 'x-forwarded-user: bob')
  local bob_family=("${secret[@]}" -H 'x-forwarded-user: bob' -H 'x-forwarded-groups: family')

  test "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$base/api/docs/report" -H 'content-type: application/json' -d '{"body":"v1"}')" = 401
  echo "PASS  anonymous cannot create a doc"

  curl -sf "${alice[@]}" -X PUT "$base/api/docs/report" -H 'content-type: application/json' -d '{"body":"v1 by alice"}' >/dev/null
  echo "PASS  alice creates doc:report and becomes its owner"

  curl -sf "${alice[@]}" "$base/api/docs/report" >"$WORK/report.json"
  grep -q 'v1 by alice' "$WORK/report.json"
  echo "PASS  alice reads her own doc"

  test "$(curl -s -o /dev/null -w '%{http_code}' "${bob[@]}" "$base/api/docs/report")" = 403
  echo "PASS  bob (no relation to the doc) gets 403"

  test "$(curl -s -o /dev/null -w '%{http_code}' "$base/api/docs/report")" = 401
  echo "PASS  anonymous gets 401"

  curl -sf "${alice[@]}" -X POST "$base/api/docs/report/share" -H 'content-type: application/json' -d '{"group":"family"}' >/dev/null
  echo "PASS  alice shares doc:report with group family"

  curl -sf "${bob_family[@]}" "$base/api/docs/report" >"$WORK/report-bob.json"
  grep -q 'v1 by alice' "$WORK/report-bob.json"
  echo "PASS  bob (member of family) can now read the doc"

  test "$(curl -s -o /dev/null -w '%{http_code}' "${bob_family[@]}" -X PUT "$base/api/docs/report" -H 'content-type: application/json' -d '{"body":"bob edits"}')" = 403
  echo "PASS  bob (shared viewer only) still cannot write the doc"
}
