# Recipe: Authorization with OpenFGA

OpenVoid's sign-in modes (`oidc`, `better-auth`, `proxy`) answer "who is this". They say nothing
about what that person is allowed to do. [OpenFGA](https://openfga.dev) answers that second
question: relationship-based authorization, the same approach Google uses internally (the
[Zanzibar paper](https://research.google/pubs/pub48190/)) and that Okta now ships as a managed
service (Okta FGA, formerly Auth0 FGA).

Instead of scattering `if (user.role === 'admin')` checks through route handlers, you write an
authorization model once (who can be an `owner`, `editor`, `viewer` of a `doc`, and so on),
store relationships as tuples ("alice is owner of doc:roadmap"), and ask OpenFGA "can alice view
doc:roadmap" wherever your app needs the answer.

`@openvoid/node/fga` wires this into OpenVoid: your app's `fga/model.fga` is bundled at build
time and written to the OpenFGA store on every migrate, and `check`, `requirePermission`,
`listObjects`, `grant` and `revoke` are the API routes use at request time.

## What you get

- A model file (`fga/model.fga`) that travels with your app and gets applied automatically,
  the same way `db/migrations` does.
- `requirePermission(relation, object)`: one line in a route that returns 401 for an anonymous
  request and 403 for a signed-in one that is not allowed, otherwise falls through.
- `check`, `listObjects`, `grant`, `revoke`, `writeTuples`, `deleteTuples` for everything else:
  showing or hiding UI, listing what a user can see, sharing an object, writing relationships in
  bulk.
- Group sync: mirror the groups your identity provider already knows about (an OIDC `groups`
  claim, an LDAP/Authelia group, a proxy header) into OpenFGA, so sharing with a team is one
  tuple instead of one per member.

## Env vars

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENVOID_FGA_URL` | | OpenFGA API URL, e.g. `http://localhost:8080` or `https://api.us1.fga.dev`. Required; OpenFGA support is off when unset. |
| `OPENVOID_FGA_STORE` | `openvoid` | Store name. `migrate` creates it if missing and looks it up by this name otherwise. |
| `OPENVOID_FGA_STORE_ID` | | Use this exact store id instead of looking one up by name. Skips store creation entirely. |
| `OPENVOID_FGA_MODEL_ID` | latest | Pin a specific authorization model version instead of OpenFGA's latest. Normally left unset. |
| `OPENVOID_FGA_API_TOKEN` | | Pre-shared key credential (self-hosted OpenFGA with `--authn-method=preshared`). |
| `OPENVOID_FGA_CLIENT_ID` | | Client credentials flow (Okta FGA, or a self-hosted OpenFGA with an OIDC-based credential wrapper in front). Needs the three below too. |
| `OPENVOID_FGA_CLIENT_SECRET` | | Client secret for the client credentials flow. |
| `OPENVOID_FGA_API_TOKEN_ISSUER` | | Token issuer for the client credentials flow (Okta FGA: `auth.fga.dev`). |
| `OPENVOID_FGA_API_AUDIENCE` | | Token audience for the client credentials flow (Okta FGA: `https://api.<jurisdiction>.fga.dev/`, trailing slash). |
| `OPENVOID_FGA_SYNC_GROUPS` | | Set to `1` to mirror `AuthUser.groups` into `group:<name>#member` tuples on every sign-in. |

Set `OPENVOID_FGA_API_TOKEN` or the four `OPENVOID_FGA_CLIENT_*` variables, not both. With
neither set, the client makes unauthenticated requests: fine for local development against a
container on your own machine, not for anything reachable by anyone else.

## Writing `fga/model.fga`

Put a model in your app's source root, next to `db/` (`examples/notes/fga/model.fga` is a
working one):

```
model
  schema 1.1

type user

type group
  relations
    define member: [user]

type doc
  relations
    define owner: [user]
    define editor: [user] or owner
    define viewer: [user, group#member] or editor
```

This reads as: anyone who is `owner` of a doc is also its `editor`, and anyone who is `editor`
is also its `viewer`. A `doc` can also give `viewer` directly to a `group`'s members
(`group#member`), which is what the sharing endpoint in the example below uses.

Learn the DSL from [OpenFGA's modeling guide](https://openfga.dev/docs/modeling/getting-started);
the [OpenFGA VS Code extension](https://marketplace.visualstudio.com/items?itemName=openfga.openfga-vscode)
gives you syntax highlighting and inline validation while you write it, and the
[Playground](https://openfga.dev/docs/getting-started/setup-openfga/playground) lets you test a
model's tuples before wiring up routes.

`migrateFga` (called automatically by `migrate`, the same step that applies `db/migrations`)
finds or creates the store, converts the DSL to OpenFGA's JSON model, and writes a new model
version only when the DSL actually changed from the latest stored version. Running it twice in a
row with no changes writes nothing.

## Using `check`, `requirePermission` and `grant` in routes

```ts
import { defineHandler } from 'void';
import { kv } from 'void/kv';
import { requireAuth } from '@openvoid/node/auth';
import { grant, requirePermission } from '@openvoid/node/fga';

export const GET = defineHandler(async (c) => {
  const id = c.req.param('id');
  await requirePermission('viewer', `doc:${id}`); // 401 anonymous, 403 denied
  return await kv.get(`doc:${id}`);
});

export const PUT = defineHandler(async (c) => {
  const id = c.req.param('id');
  const object = `doc:${id}`;
  const existing = await kv.get(object);
  if (existing === null) {
    requireAuth(); // anyone signed in may create a doc
  } else {
    await requirePermission('editor', object);
  }
  const body = await c.req.json();
  await kv.put(object, body);
  if (existing === null) await grant('owner', object); // the creator becomes the owner
  return body;
});
```

`examples/notes/routes/api/docs/[id].ts` and `[id]/share.ts` are the full version of this,
including sharing a doc with a group.

The full runtime API, all imported from `@openvoid/node/fga`:

| Function | Does |
| --- | --- |
| `check(relation, object, opts?)` | `true`/`false`. Defaults `opts.user` to the signed-in user (`getUser()`); anonymous and no `opts.user` always returns `false` without calling OpenFGA. |
| `requirePermission(relation, object)` | Throws `AuthHttpError(401)` anonymous, `AuthHttpError(403)` denied. Void's router turns both into the matching HTTP response. |
| `listObjects(type, relation, opts?)` | Every `type:id` the user has `relation` to. Anonymous: always `[]`. |
| `grant(relation, object, opts?)` / `revoke(...)` | Add/remove one tuple for the signed-in user, or `opts.user`. |
| `writeTuples(tuples)` / `deleteTuples(tuples)` | Passthrough to OpenFGA's write/delete: `{ user, relation, object }[]`, where `user` is anything OpenFGA accepts as a user reference, including a userset like `"group:family#member"`. |
| `fgaUser(user)` | `"user:<id>"` for an `AuthUser` or a raw `AuthUser.id` string. What `check`/`grant`/... use internally for `opts.user`; useful when you build tuples for `writeTuples` by hand. |

`opts.user` on `check`/`listObjects`/`grant`/`revoke` accepts an `AuthUser` or a raw
`AuthUser.id` string (`"<provider>:<subject>"`), and is resolved through `fgaUser()`. Tuples
passed to `writeTuples`/`deleteTuples` are not: their `user` field is whatever string you write,
so a userset like `"group:family#member"` goes in directly.

### A note on OpenFGA's identifier rules

OpenFGA accepts almost any non-whitespace string as an object or user id, except three
characters it reserves for its own syntax: `:`, `#` and `*` (confirmed by trial and error, see
[openfga/openfga.dev#883](https://github.com/openfga/openfga.dev/issues/883); OpenFGA does not
publish a formal grammar for this). `AuthUser.id` is `"<provider>:<subject>"`, and the subject
comes straight from the identity provider (an OIDC `sub` claim, a GitHub user id, a proxy
header), so it can contain any of those characters, or whitespace, or non-ASCII text.
`packages/node/src/fga/ids.ts` encodes every `AuthUser.id` before using it as an OpenFGA id:
each byte outside `[A-Za-z0-9.-]` becomes `_XX` (lowercase hex), so `_` itself is always escaped
too and decoding is unambiguous. `fgaUser()` applies this automatically. Group names are not
run through this encoder (the model above uses `group:<name>` literally, and so does group
sync); keep group names to safe identifier characters, or validate them yourself before writing
a tuple, the way `examples/notes/routes/api/docs/[id]/share.ts` does.

## Group sync with identity providers

Every OpenVoid identity mode resolves to the same `AuthUser`, including a `groups` array (an
OIDC `groups` claim, a proxy's groups header, and so on; see
[docs/identity.md](../../docs/identity.md)). Set `OPENVOID_FGA_SYNC_GROUPS=1` and `onSignIn`
reads the user's current `group:<name>#member` tuples, then writes and deletes tuples so they
match `user.groups` exactly. It is idempotent: running it again with the same groups changes
nothing.

`onSignIn` runs automatically for modes that have an actual sign-in event: `oidc` (after the
callback) and `better-auth` (after email/password or social sign-in). **`proxy` mode has no
sign-in event** (the proxy presents identity fresh on every request; see
[docs/identity.md](../../docs/identity.md#modes)), so nothing calls `onSignIn` for you there. If
you use `proxy` mode with group sync, call it yourself, early in a request, before any
permission check:

```ts
import { getUser } from '@openvoid/node/auth';
import { onSignIn } from '@openvoid/node/fga';

const user = getUser();
if (user) await onSignIn(user, process.env);
```

`examples/notes/routes/api/docs/_fga.ts` is exactly this, imported by the doc routes (files
starting with `_` are not routes; see the "Environment-only routes" note and the paragraph above
it in Void's own `docs/guide/server-routing.md`, installed with the `void` package).
Calling it costs one OpenFGA read per request (plus writes only when membership actually
changed), which is fine for an example; a busier app might instead do this once per cache TTL, or
switch to `oidc`/`better-auth` so it happens once per sign-in instead of once per request.

## Running OpenFGA with Docker Compose

`compose.yaml` in this folder runs OpenFGA with its own PostgreSQL datastore (OpenFGA also
supports MySQL and SQLite; see
[Configuring OpenFGA](https://openfga.dev/docs/getting-started/setup-openfga/configure-openfga)).
The `fga-migrate` service runs `openfga migrate` and exits; `fga` waits for it
(`condition: service_completed_successfully`) before starting, the same pattern
`recipes/docker/compose.full.yaml` uses for the app's own migrations.

Both services use the same pinned image, `openfga/openfga:v1.22.0`, the version OpenVoid's tests
run against. `openfga migrate` writes the schema that `openfga run` expects, so upgrade them
together: change both `image:` lines, then `docker compose up -d` runs the new version's
migration before the server starts.

```sh
cp recipes/authz-openfga/compose.yaml .
docker compose -f compose.yaml up -d
curl http://localhost:8080/healthz
```

Set these in your app:

```sh
OPENVOID_FGA_URL=http://localhost:8080
# or, inside the same compose network: OPENVOID_FGA_URL=http://fga:8080
```

For pre-shared key auth (recommended for anything beyond local development), set
`FGA_PRESHARED_KEY` before starting Compose and pass the same value to your app:

```sh
FGA_PRESHARED_KEY=$(openssl rand -hex 32) docker compose -f compose.yaml up -d
# app: OPENVOID_FGA_API_TOKEN=<the same value>
```

To run OpenFGA directly instead of through Compose:

```sh
docker run -p 8080:8080 -p 8081:8081 -p 3000:3000 openfga/openfga:v1.22.0 run
```

Port 8080 serves the HTTP API OpenVoid talks to, 8081 the gRPC API (unused here), and 3000 the
[Playground](https://openfga.dev/docs/getting-started/setup-openfga/playground), useful for
exploring a model and its tuples by hand; do not expose it outside development.

## Using Okta FGA (managed)

[Okta FGA](https://fga.dev) (formerly Auth0 FGA) is a hosted OpenFGA. No server to run:

1. Create an account and a store at the [FGA dashboard](https://dashboard.fga.dev). Note the
   jurisdiction you pick (`us1`, `eu1` or `au1`): it decides where your authorization data lives
   and is part of the API URL.
2. In the store's **Settings** page, click **Create Client**, select the permissions the client
   needs, and save the **Store ID**, **Client ID** and **Client Secret** it gives you (the
   secret is shown once).
3. Set:

```sh
OPENVOID_FGA_URL=https://api.<jurisdiction>.fga.dev     # e.g. https://api.us1.fga.dev, no trailing slash
OPENVOID_FGA_STORE_ID=<store id from the dashboard>
OPENVOID_FGA_CLIENT_ID=<client id>
OPENVOID_FGA_CLIENT_SECRET=<client secret>
OPENVOID_FGA_API_TOKEN_ISSUER=auth.fga.dev
OPENVOID_FGA_API_AUDIENCE=https://api.<jurisdiction>.fga.dev/   # same host, trailing slash
```

`OPENVOID_FGA_STORE_ID` skips the by-name store lookup entirely (Okta FGA creates the store for
you in the dashboard, so there is nothing for `migrate` to create); `migrate` still writes
`fga/model.fga` into it, the same as self-hosted OpenFGA.

See [Auth0/Okta FGA's own docs](https://docs.fga.dev/getting-started) if any of these values
move; `fga.dev`'s branding has changed hands (Auth0 to Okta) more than once.

## Notes for AWS

OpenFGA is not an AWS service, so there is no managed offering to point at directly. Two
realistic options:

- **Okta FGA** (above): no infrastructure to run, works the same from AWS as anywhere else.
- **Self-hosted on a container service** (ECS, EKS, or a single EC2/Lightsail instance running
  the Compose file above): give OpenFGA an RDS PostgreSQL datastore instead of the
  `fga-postgres` container, keep it on a private subnet reachable only by your app (OpenFGA's
  own API has no network-level access control beyond its authentication, so do not expose it
  publicly without pre-shared key or OIDC auth in front), and set `OPENVOID_FGA_URL` to its
  internal address.

## What was tested

`packages/node/test/fga.test.ts` runs against a real `openfga/openfga` container (memory
datastore) when `OPENVOID_TEST_FGA_URL` is set: `migrate` creating a store and model and being
idempotent, a changed model writing a new version, `check`/`listObjects`/`grant`/`revoke`,
`requirePermission`'s 401/403/pass, group sync adding and removing memberships and a
group-based grant, and the id-encoding round trip. `scripts/e2e.sh openfga` builds the `notes`
example, runs it with `OPENVOID_AUTH=proxy` in front of a real OpenFGA container, and drives it
over HTTP: alice creates a doc and reads it back, bob is denied with no relation to the doc,
anonymous is denied outright, alice shares the doc with group `family`, bob (sent with a
`family` groups header) can then read it, and still cannot write it.

Checked by hand, not by the automated suite: `compose.yaml` with `openfga/openfga:v1.22.0`
(brought up with `docker compose up -d`, confirmed PostgreSQL reports healthy, `fga-migrate`
completes and logs `migration done`, `/healthz` on the `fga` service returns
`{"status":"SERVING"}`, and `fga.test.ts` passes against it on the PostgreSQL datastore), and
pre-shared key authentication (`OPENVOID_FGA_API_TOKEN` against a container started with
`--authn-method=preshared`: `migrateFga`, `grant` and `check` all worked through it, and a
request with no or the wrong token got a 401 from OpenFGA itself). Okta FGA (client credentials)
was checked against OpenFGA's and Okta FGA's own documentation, not run live: there is no
free/test Okta FGA account in this environment, and the client code path for client credentials
is otherwise identical to the pre-shared-key path that was verified.
