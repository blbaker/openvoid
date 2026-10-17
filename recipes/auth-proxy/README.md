# Recipe: Login proxy (oauth2-proxy, Authelia)

Run a login proxy in front of an OpenVoid app with `OPENVOID_AUTH=proxy`. The proxy signs
people in and sends who they are on every request in headers; the app never talks to an
identity provider itself and keeps no session of its own.

## When to pick this over `oidc` or `better-auth`

Pick `proxy` when you already run (or want to run) a login proxy in front of several
self-hosted apps and would rather configure sign-in once, at the proxy, than per app. It is the
natural fit if you are already using oauth2-proxy, Authelia, Pomerium or similar to gate other
services on the same box or cluster. Pick `oidc` or `better-auth` instead when this app is the
only thing that needs sign-in, when you want the app's own `/auth/login` and `/auth/session`
routes to work standalone (no proxy in front), or when you need a session that outlives a
single request without relying on the proxy being there on every call.

## The shared secret

A request only gets treated as signed in when it carries `X-OpenVoid-Proxy-Secret` matching
`OPENVOID_AUTH_PROXY_SECRET` (see `packages/node/src/auth/modes/proxy.ts`). Without that check,
anyone who can reach the app directly could set `X-Forwarded-User: admin` themselves and walk
right in; the proxy is the only thing that is supposed to be able to claim an identity, and the
secret is what makes the app able to tell the proxy's headers apart from a forged one.

That only works if the app genuinely can't be reached any other way. Both setups below never
publish the app's port to the host; the proxy is the only container that can reach it. If you
run this behind a load balancer or on a shared network, make sure of the same thing there, or
set `OPENVOID_AUTH_PROXY_TRUST=network` instead of a secret only when you are certain nothing
else on that network can reach the app (the secret is almost always the safer choice).

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENVOID_AUTH` | | Set to `proxy`. |
| `OPENVOID_AUTH_PROXY_PRESET` | `oauth2-proxy` | `oauth2-proxy`, `authelia` or `custom`. Picks the header names below. |
| `OPENVOID_AUTH_PROXY_SECRET` | | The proxy must send this in `X-OpenVoid-Proxy-Secret`. Required unless `_TRUST=network`. |
| `OPENVOID_AUTH_PROXY_TRUST` | | Set to `network` instead of a secret only if nothing but the proxy can reach the app. |
| `OPENVOID_AUTH_PROXY_LOGIN_URL` | the `returnTo` path | Where `GET /auth/login` sends people (it is already signed in by the time this runs; there is nothing to redirect to the proxy for). |
| `OPENVOID_AUTH_PROXY_LOGOUT_URL` | `/` | Where `POST /auth/logout` sends people, e.g. oauth2-proxy's `/oauth2/sign_out`. |
| `OPENVOID_AUTH_PROXY_HEADER_USER` / `_EMAIL` / `_NAME` / `_GROUPS` | from the preset | Override one header name without switching preset. |

`oauth2-proxy` preset headers: `X-Forwarded-User`, `X-Forwarded-Email`,
`X-Forwarded-Preferred-Username`, `X-Forwarded-Groups`. `authelia` preset headers: `Remote-User`,
`Remote-Email`, `Remote-Name`, `Remote-Groups`.

## Setup 1: oauth2-proxy + Dex

Files: `compose.oauth2-proxy.yaml`, `dev/oauth2-proxy.cfg`, `dev/oauth2-proxy-alpha-config.yaml`,
`dev/dex-config.yaml`.

[Dex](https://dexidp.io) stands in for a real OpenID Connect provider here. Copy
`compose.oauth2-proxy.yaml`, `recipes/docker/Dockerfile` and the `dev/` folder into your app's
root, build, set a real secret, then:

```sh
npm run build
export OPENVOID_AUTH_PROXY_SECRET=$(openssl rand -hex 32)
docker compose -f compose.oauth2-proxy.yaml up -d --build
open http://localhost:3440
```

`dev/dex-config.yaml` has one static user for trying this out: `doc@example.com` /
`doc-flux-capacitor-88`. For a real provider, replace the `dex` service with it and change
`dev/oauth2-proxy-alpha-config.yaml`'s `providers[0].oidcConfig.issuerURL` (and `clientID` /
`clientSecret`) to match; nothing else here needs to change.

`dev/dex-config.yaml` explains why the issuer hostname is `dex.localtest.me` and why its port
has to match the one published to the host: oauth2-proxy (inside Docker) and a browser (outside
Docker) both need to resolve the same issuer URL to reach the same Dex, and a Docker network
alias only changes the hostname Dex is reached at from inside the network, not the port.

Groups: Dex's local password connector (`enablePasswordDB` / `staticPasswords`) has no concept
of groups at all, so `X-Forwarded-Groups` always comes back empty with this setup, no matter
what scope is requested. If you need groups through oauth2-proxy, point it at Keycloak or
Authelia instead, both of which carry groups from their own user store and return them in the
`groups` claim; or use the Authelia setup below, which gets you groups directly.

oauth2-proxy's generic-OIDC "user" claim (`X-Forwarded-User`) is not the username or email; it
turns out to be whatever the provider puts in the ID token's `sub` claim, which for Dex is an
opaque, base64-encoded value. That becomes `AuthUser.subject` and the second half of
`AuthUser.id`. Use `X-Forwarded-Email` (`AuthUser.email`) for anything that needs to be
human-readable.

## Setup 2: Authelia + Caddy (forward-auth)

Files: `authelia/compose.authelia.yaml`, `authelia/Caddyfile`, `authelia/configuration.yml`,
`authelia/users_database.yml`.

[Authelia](https://www.authelia.com) sits beside [Caddy](https://caddyserver.com), which asks it
"is this request signed in?" on every request (`forward_auth`) and copies the answer into
headers Caddy then adds to the request it sends to the app, alongside the shared secret. Set
`OPENVOID_AUTH_PROXY_PRESET=authelia` on the app so it reads Authelia's header names.

Copy `authelia/compose.authelia.yaml`, `recipes/docker/Dockerfile` and the rest of the
`authelia/` folder into your app's root, build, set a real secret, then:

```sh
npm run build
export OPENVOID_AUTH_PROXY_SECRET=$(openssl rand -hex 32)
docker compose -f compose.authelia.yaml up -d --build
open https://app.localtest.me:3442
```

Authelia 4.38+ refuses to start unless its `session.cookies[].authelia_url` and
`default_redirection_url` are `https`, so Caddy terminates TLS with its own internal CA
(`tls internal` in the Caddyfile) rather than plain HTTP. That is fine for local use (the
browser will warn about the certificate once; curl needs `-k`) but is not a real certificate;
give Caddy a real one (or let it get one from an ACME CA for a real domain) for anything that
isn't local dev or CI.

`authelia/users_database.yml` has one user for trying this out: `marty` /
`marty-mcfly-1985`, in groups `family` and `admins`. A real deployment should use Authelia's
LDAP backend, or at least generate its own password hash
(`docker run --rm authelia/authelia:latest authelia crypto hash generate argon2 --password '...'`).

`authelia/Caddyfile` relies on `server.endpoints.authz.forward-auth` being registered with
Authelia's defaults (`implementation: 'ForwardAuth'`, headers mapped to `username`, `groups`,
`display_name`, `email`); override `authelia/configuration.yml`'s `server.endpoints.authz` if
you need different header names.

## Sign-out

`POST /auth/logout` redirects to `OPENVOID_AUTH_PROXY_LOGOUT_URL`, which has to be the proxy's
own sign-out route so the proxy actually drops its session; the app has no session to drop
itself. For oauth2-proxy that's `/oauth2/sign_out` (e.g.
`OPENVOID_AUTH_PROXY_LOGOUT_URL=http://localhost:3440/oauth2/sign_out`). Authelia's forward-auth
setup doesn't have an equivalent single route behind Caddy; point it at Authelia's own portal
sign-out (`.../logout`) on the `auth.*` host instead.

## What was tested

oauth2-proxy + Dex is tested end to end by `scripts/e2e.sh proxyoauth`: it builds the real
images from `compose.oauth2-proxy.yaml`, then `scripts/proxyoauth-login.mjs` does a real sign-in
with plain `fetch` and a small cookie jar (manual redirects, no browser): anonymous `GET
/api/me` through the proxy, redirected to Dex, Dex's own password login form, POST credentials,
callback, and `/api/me` coming back as the Dex user with its email. It also proves that a
request straight to the app container (bypassing the proxy) with a forged
`X-Forwarded-User` header but no secret still gets 401. `smoke.mjs` is not run against this
scenario: it assumes most routes are reachable anonymously and only `/api/me` is gated, which
does not hold once oauth2-proxy sits in front of the whole app; a direct health check against
the app container stands in for it instead.

The Authelia + Caddy setup was run by hand the same way: built, brought up with `docker
compose`, signed in through Authelia's own JSON login API (`POST /api/firstfactor`, the same
endpoint its PAM and Home Assistant integrations use), and `/api/me` through Caddy came back as
`marty` with `email`, `name` and both groups, plus the same direct-to-the-app-container check
with a forged `Remote-User` header and no secret, which also came back 401. It is not wired into
`scripts/e2e.sh`: getting a browser-equivalent login through Authelia's portal (rather than its
JSON API) and a second container stack running at once would add real time to every e2e run for
a setup that, mechanically, protects the app exactly the same way setup 1 does. Treat it as
documented and manually verified, not covered by CI.
