# Extra e2e scenario: oauth2-proxy + Dex signing a real user in through the real proxy. See
# recipes/auth-proxy/README.md for the recipe this proves and scripts/e2e.d/README.md for the
# helpers used here ($ROOT, $WORK, log, wait_http, COMPOSE_PROJECTS).
scenario_proxyoauth() {
  log "proxyoauth: oauth2-proxy + Dex signing in through the real proxy"
  local ctx="$WORK/proxyoauth-ctx" port=3440 project=openvoid-d-proxy
  local secret="openvoid-e2e-proxyoauth-secret-$$"
  local recipe="$ROOT/recipes/auth-proxy"

  mkdir -p "$ctx"
  cp -R "$ROOT/examples/notes/dist" "$ctx/dist"
  cp "$ROOT/recipes/docker/Dockerfile" "$ctx/"
  cp "$recipe/compose.oauth2-proxy.yaml" "$ctx/"
  cp -R "$recipe/dev" "$ctx/dev"

  COMPOSE_PROJECTS+=("$ctx/compose.oauth2-proxy.yaml|$project")
  (cd "$ctx" && OPENVOID_AUTH_PROXY_SECRET="$secret" \
    docker compose -f compose.oauth2-proxy.yaml -p "$project" up -d --build --quiet-pull >/dev/null 2>&1)
  wait_http "http://127.0.0.1:$port/ping" 60

  # Signs in through Dex for real: GET /api/me (anonymous) -> redirected through oauth2-proxy to
  # Dex -> Dex's password login form -> POST credentials -> callback -> /api/me as the Dex user.
  # Must be "localhost", not "127.0.0.1": oauth2-proxy's configured redirect_url uses that exact
  # host, and the CSRF cookie oauth2-proxy sets on the first request is bound to it too.
  node "$ROOT/scripts/proxyoauth-login.mjs" "http://localhost:$port" doc@example.com doc-flux-capacitor-88

  local app_container
  app_container=$(cd "$ctx" && docker compose -f compose.oauth2-proxy.yaml -p "$project" ps -q app)

  # smoke.mjs assumes every route but /api/me is reachable anonymously; that does not hold once
  # oauth2-proxy sits in front of the whole app (every path needs a session), so it is skipped
  # here for direct checks against the app container instead, which only oauth2-proxy and this
  # docker exec can reach (compose.oauth2-proxy.yaml does not publish the app).
  local status
  status=$(docker exec "$app_container" node -e "
fetch('http://localhost:3000/api/health').then((r) => { process.stdout.write(String(r.status)); });
")
  test "$status" = "200"
  echo "PASS  the app container behind the proxy is healthy"

  # The whole point of the shared secret: forged identity headers without it must not work, even
  # talking to the app directly.
  status=$(docker exec "$app_container" node -e "
fetch('http://localhost:3000/api/me', { headers: { 'x-forwarded-user': 'evil', 'x-forwarded-email': 'evil@example.com' } })
  .then((r) => { process.stdout.write(String(r.status)); });
")
  test "$status" = "401"
  echo "PASS  forged identity headers without the shared secret are still anonymous at the app"
}
