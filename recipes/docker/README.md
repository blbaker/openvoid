# Recipe: Docker

Run an OpenVoid app in a container. Two setups:

- `compose.yaml`: one container. SQLite for `void/db` and `void/kv`, files for `void/storage`,
  all on one volume. Good for small apps and home servers.
- `compose.full.yaml`: the app plus PostgreSQL (`void/db`), Redis (`void/kv`) and SeaweedFS
  (`void/storage` through the S3 API). Use it with an app whose `void.config.ts` sets
  `database: 'pg'`.

## Files

Copy into your app's root, next to `package.json`:

- `Dockerfile`
- `compose.yaml` or `compose.full.yaml`

The Dockerfile copies only the built `dist/` folder. Void bundles your routes, and OpenVoid
bundles its SQLite, Redis, DynamoDB and S3 clients, so the image installs a single runtime
package (`@hono/node-server`). The bundle is plain JavaScript, so a build made on x86_64 runs
in an arm64 image and the other way around.

## Steps

```sh
npm run build                      # vite build, with openvoid() in vite.config.ts
docker compose up -d --build       # or: docker compose -f compose.full.yaml up -d --build
curl http://localhost:3000/api/health
```

Migrations in `db/migrations` are bundled into the build and applied when the container
starts. Data lives in the `openvoid-data` volume (or the PostgreSQL, Redis and S3 volumes in the
full setup), so it survives `docker compose down` and image rebuilds. `docker compose down -v`
deletes it.

For the full setup, set a real password before the first start:

```sh
echo "POSTGRES_PASSWORD=$(openssl rand -hex 16)" > .env
```

To use Amazon S3 instead of SeaweedFS, remove the `s3` and `s3-bucket` services and the
`AWS_ENDPOINT_URL_S3` and `OPENVOID_S3_FORCE_PATH_STYLE` lines, set `OPENVOID_STORAGE` to your
bucket, and give the container AWS credentials.

## What was tested

`scripts/e2e.sh docker` builds the image from the `notes` example, runs the smoke test, writes a
note, replaces the container, and checks the note is still there. `scripts/e2e.sh compose` runs
`compose.full.yaml` with the `notes-pg` example and runs the smoke test against PostgreSQL,
Redis and SeaweedFS.
