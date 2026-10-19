# Contributing

Thanks for helping. Issues and pull requests are welcome, especially new recipes and backends.

## Setup

You need Node.js 24.21 or newer, pnpm (the version in `package.json`), and Docker.

```sh
pnpm install
pnpm typecheck
scripts/services.sh up
eval "$(scripts/services.sh env)"
pnpm test
bash scripts/e2e.sh
scripts/services.sh down
```

`scripts/services.sh up` starts Redis, SeaweedFS (for S3), DynamoDB Local, PostgreSQL and
OpenFGA on loopback ports. Without it, `pnpm test` still runs the SQLite and filesystem
backends and skips the rest.

## Layout

- `packages/node`: the `@blbaker/openvoid` package. `src/plugin.ts` is the Vite plugin,
  `src/server.ts` the production entry, `src/bindings/` the backends.
- `examples/notes` and `examples/notes-pg`: small Void apps that use every supported API.
- `recipes/`: one folder per platform.
- `scripts/e2e.sh`: builds the examples and runs each recipe scenario.

## Adding a backend

Backends implement the Cloudflare binding API that Void calls (`KVNamespace` for `void/kv`,
`R2Bucket` for `void/storage`). Add the class under `packages/node/src/bindings/`, wire its URL
scheme in `src/env.ts`, and add it to the factory list in the matching conformance test
(`test/kv.conformance.test.ts` or `test/r2.conformance.test.ts`). The shared suite is the
definition of "works". If a backend can't match a behaviour, make it throw a clear error rather
than silently doing something different.

## Adding a recipe

See [recipes/README.md](recipes/README.md#adding-a-recipe).

## Pull requests

- One change per pull request, with tests that fail without it.
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- In the description, list what you checked and how, and anything you were unsure about.

## Releases

Maintainers publish to npm from CI with trusted publishing. See [RELEASING.md](RELEASING.md).
