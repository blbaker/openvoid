#!/usr/bin/env bash
# Start or stop the backing services the test suites and the e2e script use, on loopback only.
#   scripts/services.sh up     start Redis, SeaweedFS (S3), DynamoDB Local, PostgreSQL and OpenFGA; print env vars
#   scripts/services.sh down   remove them
#   scripts/services.sh env    print the env vars only
set -euo pipefail

PREFIX=${OPENVOID_SERVICES_PREFIX:-openvoid-test}
REDIS_PORT=${OPENVOID_REDIS_PORT:-56379}
S3_PORT=${OPENVOID_S3_PORT:-58333}
DYNAMO_PORT=${OPENVOID_DYNAMO_PORT:-58000}
PG_PORT=${OPENVOID_PG_PORT:-55432}
FGA_PORT=${OPENVOID_FGA_PORT:-58080}

print_env() {
  cat <<EOF
export OPENVOID_TEST_REDIS_URL=redis://127.0.0.1:${REDIS_PORT}
export OPENVOID_TEST_S3_ENDPOINT=http://127.0.0.1:${S3_PORT}
export OPENVOID_TEST_DYNAMODB_ENDPOINT=http://127.0.0.1:${DYNAMO_PORT}
export OPENVOID_TEST_FGA_URL=http://127.0.0.1:${FGA_PORT}
export OPENVOID_TEST_DATABASE_URL=postgres://openvoid:openvoid@127.0.0.1:${PG_PORT}/openvoid
export AWS_ACCESS_KEY_ID=openvoid
export AWS_SECRET_ACCESS_KEY=openvoid-secret
export AWS_REGION=us-east-1
export OPENVOID_SERVICES_PREFIX=${PREFIX}
EOF
}

wait_for() {
  local name=$1 cmd=$2
  for _ in $(seq 1 60); do
    if eval "$cmd" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "service $name did not become ready" >&2
  docker logs "$PREFIX-$name" 2>&1 | tail -20 >&2
  return 1
}

case "${1:-}" in
  up)
    docker run -d --rm --name $PREFIX-redis -p 127.0.0.1:$REDIS_PORT:6379 redis:7-alpine >/dev/null
    # SeaweedFS speaks the S3 API (MinIO no longer publishes public images).
    docker run -d --rm --name $PREFIX-s3 -p 127.0.0.1:$S3_PORT:8333 chrislusf/seaweedfs server -s3 -dir=/data >/dev/null
    docker run -d --rm --name $PREFIX-dynamo -p 127.0.0.1:$DYNAMO_PORT:8000 amazon/dynamodb-local -jar DynamoDBLocal.jar -inMemory >/dev/null
    docker run -d --rm --name $PREFIX-pg -p 127.0.0.1:$PG_PORT:5432 \
      -e POSTGRES_USER=openvoid -e POSTGRES_PASSWORD=openvoid -e POSTGRES_DB=openvoid postgres:17-alpine >/dev/null
    # OpenFGA in memory, for packages/node/test/fga.test.ts (pinned: CI must not float to :latest).
    docker run -d --rm --name $PREFIX-fga -p 127.0.0.1:$FGA_PORT:8080 openfga/openfga:v1.22.0 run >/dev/null
    wait_for redis "docker exec $PREFIX-redis redis-cli ping"
    wait_for s3 "curl -s -o /dev/null http://127.0.0.1:$S3_PORT/"
    wait_for dynamo "curl -s http://127.0.0.1:$DYNAMO_PORT"
    wait_for pg "docker exec $PREFIX-pg pg_isready -U openvoid -d openvoid"
    wait_for fga "curl -sf http://127.0.0.1:$FGA_PORT/healthz"
    print_env
    ;;
  down)
    docker rm -f $PREFIX-redis $PREFIX-s3 $PREFIX-dynamo $PREFIX-pg $PREFIX-fga >/dev/null 2>&1 || true
    ;;
  env)
    print_env
    ;;
  *)
    echo "usage: $0 up|down|env" >&2
    exit 2
    ;;
esac
