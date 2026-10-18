# Recipe: Better Auth

`OPENVOID_AUTH=better-auth` signs people in with Better Auth: email and password, plus Google,
GitHub, or any OpenID Connect provider through Better Auth's `genericOAuth` plugin. Accounts and
sessions live in the app's own database, the same SQLite file or PostgreSQL database `void/db`
uses.

## When to pick this over oidc or proxy

Pick `better-auth` when the app needs its own sign-up form (email and password) or when you
want self-service account creation without standing up a separate identity provider. Pick
[`oidc`](../auth-oidc) when every user already has an account at an existing provider
(Authelia, Keycloak, Zitadel, Google Workspace, Entra) and the app should never hold a password.
Pick [`proxy`](../auth-proxy) when a login proxy in front of the app (oauth2-proxy, Authelia
forward-auth) already decided who the user is before the request reaches OpenVoid. All three
produce the same `AuthUser`, so switching modes later mostly means changing environment
variables.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENVOID_AUTH` | | Set to `better-auth`. |
| `OPENVOID_PUBLIC_URL` | | Required. The app's public origin, e.g. `https://notes.example.com`. Better Auth's `baseURL`; also where OAuth providers redirect back to. |
| `BETTER_AUTH_SECRET` | | Required. Signs and encrypts sessions and OAuth state. Generate with `openssl rand -base64 32`. Changing it signs everyone out. |
| `OPENVOID_AUTH_PATH` | `/auth` | URL prefix for every endpoint below (shared by all modes). |
| `OPENVOID_AUTH_SESSION_DAYS` | `30` | Session lifetime (shared by all modes). |
| `OPENVOID_AUTH_SECURE_COOKIES` | auto | `1` always sets `Secure` on Better Auth's cookies, `0` never. Auto follows the scheme of `OPENVOID_PUBLIC_URL`. |
| `OPENVOID_AUTH_EMAIL_PASSWORD` | `1` | Set to `0` to turn off email and password sign-up and sign-in, keeping only social/OIDC. |
| `OPENVOID_AUTH_GOOGLE_CLIENT_ID`, `OPENVOID_AUTH_GOOGLE_CLIENT_SECRET` | | Enables Google sign-in. Both or neither. |
| `OPENVOID_AUTH_GITHUB_CLIENT_ID`, `OPENVOID_AUTH_GITHUB_CLIENT_SECRET` | | Enables GitHub sign-in. Both or neither. |
| `OPENVOID_AUTH_OIDC_PROVIDERS` | | Comma-separated provider names, e.g. `family,work`. Each name becomes a `<basePath>/login/<name>` URL and Better Auth's `providerId`. |
| `OPENVOID_AUTH_OIDC_<NAME>_ISSUER` | | Required per provider. The OIDC issuer URL; discovery is fetched from `<issuer>/.well-known/openid-configuration`. |
| `OPENVOID_AUTH_OIDC_<NAME>_CLIENT_ID` | | Required per provider. |
| `OPENVOID_AUTH_OIDC_<NAME>_CLIENT_SECRET` | | Required per provider. |
| `OPENVOID_AUTH_OIDC_<NAME>_SCOPES` | `openid profile email` | Space- or comma-separated OAuth scopes requested at sign-in. |
| `OPENVOID_AUTH_OIDC_<NAME>_GROUPS_CLAIM` | `groups` | Claim in the ID token (or userinfo response) that holds the user's groups. |
| `DATABASE_URL` | | PostgreSQL apps only (`void.config.ts` sets `database: 'pg'`): same connection string `void/db` uses. Better Auth's tables live in the same database. |

`<NAME>` is the provider name uppercased with anything that isn't a letter or digit turned into
`_`, so `OPENVOID_AUTH_OIDC_PROVIDERS=family` reads `OPENVOID_AUTH_OIDC_FAMILY_ISSUER` and so on.

## HTTP endpoints

All under `OPENVOID_AUTH_PATH` (default `/auth`):

| Endpoint | Method | What it does |
| --- | --- | --- |
| `/auth/session` | GET | The signed-in user as JSON, or `{"user": null}`. Answered by OpenVoid's core before any mode sees the request. |
| `/auth/sign-up/email` | POST | `{email, password, name}`. Creates the user and signs them in (unless `OPENVOID_AUTH_EMAIL_PASSWORD=0`). |
| `/auth/sign-in/email` | POST | `{email, password}`. |
| `/auth/login/<provider>` | GET | Starts social or OIDC sign-in and redirects to the provider. `<provider>` is `google`, `github`, or one of the names in `OPENVOID_AUTH_OIDC_PROVIDERS`. Accepts `?returnTo=/path` (same-site paths only; anything else falls back to `/`). |
| `/auth/callback/<provider>` | GET | Where the provider redirects back to. Better Auth handles this; nothing to configure. |
| `/auth/logout` | POST | Signs out and clears the session cookie. |

Better Auth's other endpoints (`/auth/change-password`, `/auth/update-user`,
`/auth/list-sessions`, ...) are reachable under `OPENVOID_AUTH_PATH` too; see
[Better Auth's docs](https://www.better-auth.com/docs) for the full list. This mode configures no
email sender, so password reset (`/auth/request-password-reset`) and email verification don't
work. A user who forgets their password needs an admin, or a social or OIDC account linked to
the same email. `defineHandler` routes in the app use `requireAuth()`, `getUser()` and
`getSession()` from `@blbaker/openvoid/auth` exactly like the other modes; see
[docs/identity.md](../../docs/identity.md).

## Using Better Auth's browser client

Void's own client (`auth` from `void/client`) cannot be used: Void blocks it on every target
except Cloudflare, and OpenVoid does not turn it back on for identity (see docs/identity.md for
why). Use Better Auth's own client instead, pointed at the same base path:

```ts
// lib/auth-client.ts
import { createAuthClient } from 'better-auth/client';

export const authClient = createAuthClient({
  baseURL: import.meta.env.VITE_PUBLIC_URL, // or window.location.origin
  basePath: '/auth', // match OPENVOID_AUTH_PATH
});
```

```ts
await authClient.signUp.email({ email, password, name });
await authClient.signIn.email({ email, password });
await authClient.signIn.social({ provider: 'google', callbackURL: '/notes' });
await authClient.signOut();
const { data: session } = await authClient.getSession();
```

Social and OIDC sign-in can also be started with a plain link, no JavaScript needed:
`<a href="/auth/login/google?returnTo=/notes">Sign in with Google</a>`.

## Provider setup

### Google

1. [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials →
   Create OAuth client ID → Web application.
2. Authorized redirect URI: `${OPENVOID_PUBLIC_URL}/auth/callback/google` (use the exact
   `OPENVOID_AUTH_PATH`, default `/auth`).
3. Set `OPENVOID_AUTH_GOOGLE_CLIENT_ID` and `OPENVOID_AUTH_GOOGLE_CLIENT_SECRET`.

### GitHub

1. GitHub → Settings → Developer settings → OAuth Apps → New OAuth App.
2. Authorization callback URL: `${OPENVOID_PUBLIC_URL}/auth/callback/github`.
3. Set `OPENVOID_AUTH_GITHUB_CLIENT_ID` and `OPENVOID_AUTH_GITHUB_CLIENT_SECRET`.

### Any OIDC provider (Authelia, Keycloak, Zitadel, ...)

1. Register a confidential OAuth/OIDC client at the provider.
2. Redirect URI: `${OPENVOID_PUBLIC_URL}/auth/callback/<name>`, where `<name>` is whatever you
   put in `OPENVOID_AUTH_OIDC_PROVIDERS`.
3. Request at least the `openid`, `profile` and `email` scopes, plus whatever makes the
   provider send groups. Dex and Authelia use a `groups` scope; others need a claim mapper on
   the client. If groups come back empty, check `OPENVOID_AUTH_OIDC_<NAME>_SCOPES` and
   `_GROUPS_CLAIM` against the provider's docs.
4. Set `OPENVOID_AUTH_OIDC_<NAME>_ISSUER`, `_CLIENT_ID` and `_CLIENT_SECRET`.

Groups from the configured claim land in `AuthUser.groups`. Email and password users get
`groups: []`.

The OIDC provider is treated as the source of truth: on every sign-in, OpenVoid rewrites the
user's name, email, image and groups from what the provider sends. Removing someone from a
group at the provider takes effect the next time they sign in. Until then their current session
keeps the old groups, so keep `OPENVOID_AUTH_SESSION_DAYS` short if that gap matters. This
applies to OIDC providers only. Google and GitHub accounts keep whatever the user set locally.

## Database tables and migrations

Better Auth adds its own tables (`user`, `session`, `account`, `verification`) to the app's
database, next to the app's own tables from `db/migrations`. It migrates them with its own
migration API (`getMigrations`/`runMigrations` from `better-auth/db/migration`), not with
`db/migrations/*.sql`; there is nothing to add there. `mode.migrate()` runs them, the same way
every mode's tables get created: on `node dist/ssr/index.js migrate`, on normal server start
(`OPENVOID_MIGRATE=on-start`, the default), and in the Vite dev server. Running it again is a
no-op.

The `user` table carries one extra column, `groups`, a JSON-encoded array of group names. Only
an OIDC sign-in writes it. A request that tries to set `groups` itself (`/auth/sign-up/email`,
`/auth/update-user`) is refused with a 400, so users cannot give themselves groups.

### Where accounts live

- SQLite apps: the same SQLite file as `void/db` (`env.DB`, the D1-compatible binding), so one
  `.backup` captures the app's data and its accounts together.
- PostgreSQL apps: `DATABASE_URL`, the same database as `void/db`.

### Identity id scheme

`AuthUser.id` is `local:<id>` for a user with no linked social or OIDC account, using Better
Auth's own user id. A user who has signed in with Google, GitHub or an OIDC provider gets
`<providerId>:<accountId>` instead, using their oldest linked external account: the provider's
own id for them, which does not change if they later also set a password or their local profile
changes. `AuthUser.subject` is that same id without the provider prefix.

## What was tested

- Unit tests (`packages/node/test/auth-better-auth.test.ts`): on SQLite, in a temporary
  directory, `migrate()` run twice is a no-op; sign-up, sign-in, `/auth/session`,
  `requireAuth()` inside `wrap()`, sign-out, a wrong password being rejected, email+password
  turned off with `OPENVOID_AUTH_EMAIL_PASSWORD=0`, a misconfigured setup (missing
  `OPENVOID_PUBLIC_URL`/`BETTER_AUTH_SECRET`, a lone Google client id) throwing a clear error,
  `GET /auth/login/google` redirecting to Google's real authorization endpoint with the right
  `client_id` and `redirect_uri`, and `ctx.hooks.onSignIn` firing once per new session. The
  same flow runs again on PostgreSQL when `OPENVOID_TEST_DATABASE_URL` is set, each run in its
  own schema.
- OIDC unit tests (`auth-better-auth-oidc.test.ts`): a fake OIDC provider inside the test
  process (discovery, JWKS, RS256-signed ID tokens), driven the way a browser would. Covers a
  full sign-in through the callback, the groups claim mapped into `AuthUser.groups`, groups
  refreshed on the next sign-in after the provider removes one, a callback without the state
  cookie being refused, and `groups` in a sign-up or update-user body being refused. No Docker
  needed.
- Session settings (`auth-better-auth-cookies.test.ts`): the session cookie from a real sign-up
  has `Max-Age` from `OPENVOID_AUTH_SESSION_DAYS` (30 days by default). `Secure` follows
  `OPENVOID_PUBLIC_URL`, or is forced with `OPENVOID_AUTH_SECURE_COOKIES`.
- End-to-end (`scripts/e2e.sh betterauth`): the built `notes` example run as a plain Node
  process with `OPENVOID_AUTH=better-auth`, driven over real HTTP with `curl` and a cookie jar:
  sign-up, `/api/me` showing the signed-in user, a social sign-in redirect, sign-out, and
  `/api/me` back to 401, with the full Void smoke test (`scripts/smoke.mjs`) alongside.
  - OIDC against a real provider: [Dex](https://dexidp.io) (`ghcr.io/dexidp/dex:v2.45.1`) in a
    container with its mock connector. `curl -L` follows the whole authorization-code flow
    (discovery, PKCE, nonce, token exchange, ID token verification). It lands on `returnTo`
    with a `dex:<subject>` user whose groups come from Dex's `groups` claim. Signing in again
    keeps the same id. This leg is skipped with a message if the Dex image can't be pulled.
  - PostgreSQL: the same email+password flow against `notes-pg` when `scripts/services.sh up`
    has been run first. Without it this leg is skipped with a message and the run still passes.
- The production build was checked to bundle `better-auth` and its dependencies into
  `dist/ssr/index.js`: the only bare import left in the bundle is `@hono/node-server`, the same
  as every other mode.

### Not tested

- Authelia, Keycloak and Zitadel specifically. Dex and the in-process provider exercise the
  standard OIDC flow these share. What differs per provider is which scope and claim carry
  groups; check `_SCOPES` and `_GROUPS_CLAIM` against your provider's docs.
- Real Google and GitHub OAuth apps (client credentials, consent screen, token exchange). The
  redirect and the state cookie are covered with fake credentials. The token exchange runs
  through the same Better Auth callback that the OIDC tests exercise.
- Better Auth's session cookie cache, rate limiting, and its other optional features. This mode
  turns none of them on.
- Resolving `AuthUser` for a session does one extra query (the user's linked accounts) to work
  out the id scheme above. For a very high-traffic app this is worth caching; it was not
  measured here.
