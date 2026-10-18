# OpenVoid

Run [Void](https://github.com/voidzero-dev/void) apps on your own infrastructure. Keep writing
`void/db`, `void/kv` and `void/storage` the way the Void docs show, and choose what sits behind
them: SQLite, PostgreSQL, Redis, DynamoDB, S3, or plain files on disk.

Void is built for Cloudflare Workers. It already has a Node.js target, but on that target the
database, key-value and storage APIs are switched off. OpenVoid switches them back on with a Vite
plugin and a small Node server host. It does not fork or patch Void: it works with the `void`
package from npm.

Status: early. Phase 1 covers the APIs below, with tests against every backend and end-to-end
runs for each recipe. See [compatibility](#compatibility) for what is not supported yet.

## Quick start

Start from a Void app with `target: 'node'` in `void.config.ts`:

```ts
import { defineConfig } from 'void/config';

export default defineConfig({ target: 'node' });
```

Add OpenVoid in front of Void's plugin in `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import { voidPlugin } from 'void';
import { openvoid } from '@openvoid/node';

export default defineConfig({
  plugins: [openvoid(), voidPlugin()],
});
```

OpenVoid has to come first. Void's Node target rejects `void/db`, `void/kv` and `void/storage`
while it resolves imports, so OpenVoid resolves them before Void gets the chance.

Then build and run:

```sh
npm install @hono/node-server
npx vite build
node dist/ssr/index.js
```

With no configuration, data goes to `./.data`: SQLite for `void/db` and `void/kv`, files for
`void/storage`. Pending migrations from `db/migrations` run before the server starts listening.

`@openvoid/node` is not on npm yet. Until it is, use this repo as a workspace (see
`examples/`) or install it from a local checkout.

## Recipes

A recipe is a tested way to run an OpenVoid app on one platform: which backend each API maps
to, the files you copy, and the commands you run.

- [Docker](recipes/docker): one container with SQLite and a volume, or Compose with
  PostgreSQL, Redis and S3-compatible storage
- [AWS Lambda Web Functions](recipes/aws-lambda-web-functions): the new (October 2026) Lambda
  form factor that runs a normal HTTP server. PostgreSQL, DynamoDB and S3
- [Plain Node.js](recipes/node): a VM or bare server with systemd

Sign-in and permissions, for any of the platforms above (see [identity](docs/identity.md)):

- [Login proxy](recipes/auth-proxy): oauth2-proxy or Authelia in front of the app signs people
  in and passes who they are in headers
- [OIDC and GitHub](recipes/auth-oidc): OpenVoid signs people in itself through any OpenID
  Connect provider, plus GitHub
- [Better Auth](recipes/auth-better-auth): email and password, Google, GitHub or any OIDC
  provider, with accounts in the app's own database
- [OpenFGA](recipes/authz-openfga): relationship-based permissions on top of any sign-in mode

Each recipe is exercised by `scripts/e2e.sh`. The [recipes index](recipes/README.md) says
exactly what was tested and what was not.

## Configuration

Everything is set with environment variables, so the same build runs anywhere.

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | | PostgreSQL connection string. Required when `void.config.ts` sets `database: 'pg'`. |
| `OPENVOID_SQLITE` | `$OPENVOID_DATA_DIR/db.sqlite` | SQLite file for `void/db` when the app uses SQLite. |
| `OPENVOID_KV` | `sqlite:$OPENVOID_DATA_DIR/kv.sqlite` | `sqlite:<path>`, `redis://host:port[?prefix=app:]`, or `dynamodb:<table>[?namespace=app]` |
| `OPENVOID_STORAGE` | `file:$OPENVOID_DATA_DIR/storage` | `file:<dir>` or `s3://<bucket>[/prefix]` |
| `OPENVOID_S3_FORCE_PATH_STYLE` | | Set to `1` for S3-compatible servers that need path-style URLs. |
| `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL_DYNAMODB` | | Point the AWS SDK at a compatible service (SeaweedFS, MinIO, DynamoDB Local). |
| `OPENVOID_DATA_DIR` | `./.data` | Base directory for the local defaults. |
| `OPENVOID_MIGRATE` | `on-start` | `on-start` applies pending migrations before listening. `off` skips them. |
| `OPENVOID_PG_POOL_MAX` | `10` | PostgreSQL pool size per process. |
| `HOST`, `PORT` | `0.0.0.0`, `3000` | Listen address. `AWS_LAMBDA_HTTP_ENDPOINT` wins when Lambda sets it. |

AWS credentials and region come from the standard AWS SDK chain: environment variables, a
profile, or an IAM role. Sign-in settings (`OPENVOID_AUTH` and the rest) are in
[identity](docs/identity.md) and each sign-in recipe.

To apply migrations without starting the server, for example from CI before a deploy:

```sh
node dist/ssr/index.js migrate
```

Migrations are the `.sql` files in `db/migrations`, bundled into the build. OpenVoid records
them in Void's own `_void_migrations` table, so `void db migrate` and OpenVoid agree on what
has run. On PostgreSQL an advisory lock keeps two instances from migrating at once.

## Compatibility

Works on Node.js with OpenVoid:

- `void/db` with SQLite or PostgreSQL, including the `@schema` alias
- `void/kv`: get, put with TTL, expiration and metadata, delete, list with prefix and cursor
- `void/storage`: put, get with byte ranges, head, delete, list with prefix, delimiter and
  cursor, http and custom metadata
- `void/env`, including an `env.ts` schema with defaults
- Sign-in, through `@openvoid/node/auth` instead of `void/auth`: `requireAuth`, `getUser` and
  `getSession` with the same names, backed by a login proxy, OpenID Connect or Better Auth.
  Permissions through OpenFGA. See [identity](docs/identity.md).
- `vite dev` with the same backends as the built server

Everything else Void's Node target supports is left alone. The examples only exercise API
routes, so pages and SSG have not been tested with OpenVoid yet.

Not supported yet:

- `void/auth` itself and `auth` from `void/client`. Void stops the build when a Node app imports
  them, before any plugin runs. Import from `@openvoid/node/auth` instead; for a browser client,
  the Better Auth recipe shows Better Auth's own.
- `void/ai`, `void/sandbox`, queues, cron triggers, Durable Objects, `void/live` and WebSocket
  routes. These stay Cloudflare-only for now.
- MySQL. Void supports it; OpenVoid does not wire it up yet.
- R2 multipart uploads and conditional requests (`onlyIf`). They throw a clear error instead
  of being ignored.
- S3 lowercases custom metadata keys. R2 keeps their case.

## How it works

Void's runtime reads its bindings (`env.DB`, `env.KV`, `env.STORAGE` and plain variables) from
an `AsyncLocalStorage` it keeps on `globalThis` under a registered symbol. OpenVoid's server
runs every request inside that same storage with its own bindings, so Void's unmodified runtime
code finds them. The plugin does three more things at build time:

- resolves `void/kv`, `void/storage`, `void/env` to Void's real runtime modules
- generates `void/db` for the chosen dialect (drizzle over a D1-compatible SQLite binding, or
  over a `pg` pool)
- replaces Void's generated Node entry with one that runs migrations, listens, and shuts down
  cleanly on `SIGTERM`

The bindings implement the Cloudflare API surface that Void calls. `packages/node/test`
runs one behaviour suite against every backend, and `test/void-contract.test.ts` fails if a
Void release changes the env seam OpenVoid relies on.

## Development

Requires Node.js 24.21 or newer (Void's minimum), pnpm, and Docker for the service-backed
tests.

```sh
pnpm install
pnpm typecheck
pnpm test                          # SQLite and filesystem backends only
scripts/services.sh up             # Redis, SeaweedFS (S3), DynamoDB Local, PostgreSQL
eval "$(scripts/services.sh env)"
pnpm test                          # every backend
bash scripts/e2e.sh                # build the examples and run every recipe scenario
scripts/services.sh down
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a backend or a recipe.

## License

MIT. OpenVoid is not affiliated with Cloudflare or VoidZero. Void is MIT-licensed by
Cloudflare, Inc.; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
