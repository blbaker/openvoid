#!/usr/bin/env bash
# End-to-end checks: build the example apps, run them the way each recipe runs them, and drive
# them over HTTP with scripts/smoke.mjs.
#
#   scripts/e2e.sh                      all scenarios
#   scripts/e2e.sh local dev            only some
#
# Scenarios
#   local    notes (SQLite) as a plain Node process, default backends (SQLite + files)
#   dev      notes under the Vite dev server
#   services notes-pg with PostgreSQL + Redis + S3 (needs scripts/services.sh up)
#   lambda   notes-pg packaged by the AWS Lambda Web Functions recipe, run under that contract:
#            read-only code dir, writable /tmp only, AWS_LAMBDA_HTTP_ENDPOINT, DynamoDB + S3 + PG
#   docker   notes built into the recipes/docker image, data on a volume, survives a restart
#   compose  notes-pg with recipes/docker/compose.full.yaml (PostgreSQL, Redis, SeaweedFS)
#   proxy    notes with OPENVOID_AUTH=proxy: identity headers count only with the shared secret
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# Extra scenarios live in scripts/e2e.d/<name>.sh, each defining scenario_<name>.
EXTRA_SCENARIOS=""
for extra in "$ROOT"/scripts/e2e.d/*.sh; do
  [ -e "$extra" ] || continue
  # shellcheck source=/dev/null
  source "$extra"
  EXTRA_SCENARIOS="$EXTRA_SCENARIOS $(basename "$extra" .sh)"
done
SCENARIOS=${*:-local dev services lambda docker compose proxy$EXTRA_SCENARIOS}
WORK=$(mktemp -d "${TMPDIR:-/tmp}/openvoid-e2e.XXXXXX")
PIDS=()
CONTAINERS=()
COMPOSE_DIRS=()
COMPOSE_PROJECTS=()
RESULTS=()

# Each scenario runs in its own subshell with `set -e`; this stops whatever it started.
stop_started() {
  for pid in "${PIDS[@]}"; do kill -TERM -- "-$pid" 2>/dev/null || true; done
  for c in "${CONTAINERS[@]}"; do docker rm -f "$c" >/dev/null 2>&1 || true; done
  for d in "${COMPOSE_DIRS[@]}"; do (cd "$d" && docker compose -f compose.full.yaml -p openvoid-e2e down -v >/dev/null 2>&1) || true; done
  # Entries are "<compose file>|<project name>".
  for entry in "${COMPOSE_PROJECTS[@]}"; do
    docker compose -f "${entry%%|*}" -p "${entry##*|}" down -v >/dev/null 2>&1 || true
  done
}
trap 'rm -rf "$WORK"' EXIT

# Start a command in its own process group so the whole tree can be stopped.
start_bg() {
  local logfile=$1
  shift
  setsid bash -c "$*" >"$logfile" 2>&1 &
  PIDS+=($!)
}

log() { printf '\n== %s\n' "$*"; }

wait_http() {
  local url=$1 seconds=${2:-30}
  for _ in $(seq 1 $((seconds * 4))); do
    if curl -sf -o /dev/null "$url"; then return 0; fi
    sleep 0.25
  done
  echo "timed out waiting for $url" >&2
  return 1
}

record() {
  local name=$1 status=$2
  RESULTS+=("$status  $name")
}

smoke() {
  node "$ROOT/scripts/smoke.mjs" "$1"
}

build_examples() {
  log "build @openvoid/node and the examples"
  (cd "$ROOT" && pnpm --filter @openvoid/node build >/dev/null)
  (cd "$ROOT" && pnpm --filter openvoid-example-notes run build >/dev/null)
  (cd "$ROOT" && pnpm --filter openvoid-example-notes-pg run build >/dev/null)
}

service_env() {
  eval "$("$ROOT/scripts/services.sh" env)"
}

# A fresh PostgreSQL database per scenario, so runs never see each other's tables.
fresh_database() {
  local name="e2e_$1_$$"
  docker exec "${OPENVOID_SERVICES_PREFIX:-openvoid-test}-pg" psql -q -U openvoid -d openvoid -c "DROP DATABASE IF EXISTS $name" -c "CREATE DATABASE $name" >/dev/null 2>&1
  echo "${OPENVOID_TEST_DATABASE_URL%/*}/$name"
}

scenario_local() {
  log "local: notes on Node with SQLite + files"
  local port=3401
  start_bg "$WORK/local.log" "cd '$ROOT/examples/notes' && OPENVOID_DATA_DIR='$WORK/local-data' APP_NAME='set by env' HOST=127.0.0.1 PORT=$port exec node dist/ssr/index.js"
  wait_http "http://127.0.0.1:$port/api/health"
  EXPECT_APP_NAME='set by env' smoke "http://127.0.0.1:$port"
}

scenario_dev() {
  log "dev: notes under the Vite dev server"
  local port=3402
  start_bg "$WORK/dev.log" "cd '$ROOT/examples/notes' && OPENVOID_DATA_DIR='$WORK/dev-data' exec pnpm exec vite --host 127.0.0.1 --port $port --strictPort"
  wait_http "http://127.0.0.1:$port/api/health" 60
  smoke "http://127.0.0.1:$port"
}

scenario_services() {
  log "services: notes-pg with PostgreSQL + Redis + S3"
  service_env
  local port=3403
  export DATABASE_URL=$(fresh_database services)
  export OPENVOID_KV="$OPENVOID_TEST_REDIS_URL?prefix=e2e:"
  export OPENVOID_STORAGE=s3://openvoid-e2e/services
  export OPENVOID_S3_FORCE_PATH_STYLE=1 AWS_ENDPOINT_URL_S3=$OPENVOID_TEST_S3_ENDPOINT
  node "$ROOT/scripts/ensure-infra.mjs"
  start_bg "$WORK/services.log" "cd '$ROOT/examples/notes-pg' && HOST=127.0.0.1 PORT=$port exec node dist/ssr/index.js"
  wait_http "http://127.0.0.1:$port/api/health"
  smoke "http://127.0.0.1:$port"
  unset DATABASE_URL OPENVOID_KV OPENVOID_STORAGE OPENVOID_S3_FORCE_PATH_STYLE AWS_ENDPOINT_URL_S3
}

scenario_lambda() {
  log "lambda: AWS Lambda Web Functions contract (read-only code, /tmp only, AWS_LAMBDA_HTTP_ENDPOINT)"
  service_env
  local out="$WORK/lambda" port=3404 name=openvoid-e2e-lambda
  "$ROOT/recipes/aws-lambda-web-functions/package.sh" "$ROOT/examples/notes-pg" "$out"
  OPENVOID_KV=dynamodb:openvoid-e2e AWS_ENDPOINT_URL_DYNAMODB=$OPENVOID_TEST_DYNAMODB_ENDPOINT \
    OPENVOID_STORAGE=s3://openvoid-e2e OPENVOID_S3_FORCE_PATH_STYLE=1 AWS_ENDPOINT_URL_S3=$OPENVOID_TEST_S3_ENDPOINT \
    node "$ROOT/scripts/ensure-infra.mjs"
  local database_url
  database_url=$(fresh_database lambda)
  local env_args=(
    -e DATABASE_URL="$database_url"
    -e OPENVOID_KV=dynamodb:openvoid-e2e -e AWS_ENDPOINT_URL_DYNAMODB="$OPENVOID_TEST_DYNAMODB_ENDPOINT"
    -e OPENVOID_STORAGE=s3://openvoid-e2e/lambda -e OPENVOID_S3_FORCE_PATH_STYLE=1 -e AWS_ENDPOINT_URL_S3="$OPENVOID_TEST_S3_ENDPOINT"
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION
  )
  local run_args=(--network host --read-only --tmpfs /tmp:rw,size=512m -v "$out:/var/task:ro" -w /var/task --user node)
  # Migrations run as a separate step (CI or your laptop), never inside Lambda's 10 s start window.
  docker run --rm "${run_args[@]}" "${env_args[@]}" node:24-slim node index.js migrate
  CONTAINERS+=($name)
  local started=$(date +%s%N)
  docker run -d --name $name "${run_args[@]}" "${env_args[@]}" \
    -e AWS_LAMBDA_HTTP_ENDPOINT=127.0.0.1:$port -e OPENVOID_MIGRATE=off node:24-slim node index.js >/dev/null
  wait_http "http://127.0.0.1:$port/api/health" 10
  echo "listening $(( ($(date +%s%N) - started) / 1000000 )) ms after container start (Lambda allows 10000 ms)"
  smoke "http://127.0.0.1:$port"
  docker stop -t 2 $name >/dev/null
  docker logs $name >"$WORK/lambda.log" 2>&1
  grep -q 'SIGTERM: closing' "$WORK/lambda.log"
  echo "PASS  SIGTERM handled"
}

scenario_docker() {
  log "docker: recipes/docker image with notes, data on a volume"
  local ctx="$WORK/docker-ctx" image=openvoid-e2e-notes name=openvoid-e2e-docker volume=openvoid-e2e-data port=3405
  mkdir -p "$ctx" && cp -R "$ROOT/examples/notes/dist" "$ctx/dist" && cp "$ROOT/recipes/docker/Dockerfile" "$ctx/"
  docker build -q -t $image "$ctx" >/dev/null
  docker volume rm -f $volume >/dev/null 2>&1 || true
  CONTAINERS+=($name)
  docker run -d --name $name -p 127.0.0.1:$port:3000 -v $volume:/data $image >/dev/null
  wait_http "http://127.0.0.1:$port/api/health"
  smoke "http://127.0.0.1:$port"
  curl -sf -X POST "http://127.0.0.1:$port/api/notes" -H 'content-type: application/json' -d '{"title":"survives restart"}' >/dev/null
  docker rm -f $name >/dev/null
  docker run -d --name $name -p 127.0.0.1:$port:3000 -v $volume:/data $image >/dev/null
  wait_http "http://127.0.0.1:$port/api/health"
  curl -sf "http://127.0.0.1:$port/api/notes" >"$WORK/notes.json"
  grep -q 'survives restart' "$WORK/notes.json"
  echo "PASS  data survived a container restart"
  docker rm -f $name >/dev/null
  docker volume rm -f $volume >/dev/null
}

scenario_compose() {
  log "compose: notes-pg with compose.full.yaml (PostgreSQL, Redis, SeaweedFS)"
  local ctx="$WORK/compose-ctx" port=3406
  mkdir -p "$ctx" && cp -R "$ROOT/examples/notes-pg/dist" "$ctx/dist"
  cp "$ROOT/recipes/docker/Dockerfile" "$ROOT/recipes/docker/compose.full.yaml" "$ctx/"
  sed -i "s/\"3000:3000\"/\"127.0.0.1:$port:3000\"/" "$ctx/compose.full.yaml"
  COMPOSE_DIRS+=("$ctx")
  (cd "$ctx" && docker compose -f compose.full.yaml -p openvoid-e2e up -d --build --quiet-pull >/dev/null 2>&1)
  wait_http "http://127.0.0.1:$port/api/health" 90
  smoke "http://127.0.0.1:$port"
}

scenario_proxy() {
  log "proxy: OPENVOID_AUTH=proxy with a shared secret"
  local port=3407 base="http://127.0.0.1:3407"
  start_bg "$WORK/proxy.log" "cd '$ROOT/examples/notes' && OPENVOID_DATA_DIR='$WORK/proxy-data' OPENVOID_AUTH=proxy OPENVOID_AUTH_PROXY_SECRET=e2e-secret HOST=127.0.0.1 PORT=$port exec node dist/ssr/index.js"
  wait_http "$base/api/health"
  smoke "$base"
  local who=(-H 'x-forwarded-user: doc' -H 'x-forwarded-email: doc@example.com' -H 'x-forwarded-groups: family,admins')
  test "$(curl -s -o /dev/null -w '%{http_code}' "${who[@]}" "$base/api/me")" = 401
  echo "PASS  identity headers without the secret are ignored"
  curl -sf "${who[@]}" -H 'x-openvoid-proxy-secret: e2e-secret' "$base/api/me" >"$WORK/me.json"
  grep -q '"id":"proxy:doc"' "$WORK/me.json" && grep -q '"groups":\["family","admins"\]' "$WORK/me.json"
  echo "PASS  /api/me returns the proxy user with the secret"
}

build_examples
for scenario in $SCENARIOS; do
  set +e
  ( set -e; trap stop_started EXIT; "scenario_$scenario" )
  status=$?
  set -e
  if [ $status -eq 0 ]; then record "$scenario" PASS; else record "$scenario" FAIL; fi
done

log "summary"
printf '%s\n' "${RESULTS[@]}"
! printf '%s\n' "${RESULTS[@]}" | grep -q '^FAIL'
