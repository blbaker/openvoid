# Identity in OpenVoid

Void's own sign-in (`void/auth`, and `auth` from `void/client`) is Cloudflare-only: Void stops
the build when any file imports them on a Node target. OpenVoid provides sign-in under its own
import path with the same function names, so moving an app over means changing one import.

```ts
import { requireAuth, getUser, getSession } from '@openvoid/node/auth';

export const GET = defineHandler(() => {
  const user = requireAuth(); // 401 when nobody is signed in
  return { id: user.id, groups: user.groups };
});
```

## Modes

Pick one with `OPENVOID_AUTH`. Every mode produces the same `AuthUser`:

```ts
type AuthUser = {
  id: string;          // "<provider>:<subject>", stable per provider
  provider: string;    // "google", "github", "authelia", "proxy", ...
  subject: string;     // the provider's id for the user
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  image: string | null;
  groups: string[];    // from the provider's groups claim or the proxy's groups header
};
```

| `OPENVOID_AUTH` | Who signs people in | Where accounts live | Recipe |
| --- | --- | --- | --- |
| `oidc` | OpenVoid, using any OpenID Connect provider (Authelia, Keycloak, Zitadel, Dex, Cognito, Google, Entra) plus GitHub's OAuth | At the provider | [auth-oidc](../recipes/auth-oidc) |
| `better-auth` | OpenVoid, using Better Auth: email and password, plus Google, GitHub or any OIDC provider | In the app's database | [auth-better-auth](../recipes/auth-better-auth) |
| `proxy` | A login proxy in front of the app (oauth2-proxy, Authelia forward-auth) | At the proxy's provider | [auth-proxy](../recipes/auth-proxy) |

`oidc` and `better-auth` keep a session per browser. `oidc` stores sessions in OpenVoid's KV
binding (SQLite, Redis or DynamoDB), keyed by a SHA-256 of the cookie value. `better-auth` uses
its own session table. `proxy` keeps no session; the proxy sends the user on every request.

Every mode owns the URLs under `OPENVOID_AUTH_PATH` (default `/auth`):

- `GET /auth/session`: the current user as JSON, or `{ "user": null }`
- `GET /auth/login` and `GET /auth/login/<provider>?returnTo=/path`: start sign-in
- `POST /auth/logout`: sign out

`returnTo` only accepts paths on the same site.

## Authorization with OpenFGA

Set `OPENVOID_FGA_URL` and OpenVoid connects to [OpenFGA](https://openfga.dev) for
relationship-based permissions. See [authz-openfga](../recipes/authz-openfga).

- The app's model lives in `fga/model.fga` and is bundled at build time. `migrate` creates the
  store if needed and writes the model when it changed.
- Users are `user:<id>` in OpenFGA, using the same id as `AuthUser.id`.
- With `OPENVOID_FGA_SYNC_GROUPS=1`, each sign-in mirrors the user's groups into OpenFGA as
  `group:<name>#member` relations, so groups managed at the identity provider can grant access.

## Settings shared by all modes

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENVOID_AUTH` | | `oidc`, `better-auth` or `proxy`. Unset: nobody is signed in. |
| `OPENVOID_AUTH_PATH` | `/auth` | URL prefix for the sign-in routes. |
| `OPENVOID_AUTH_COOKIE` | `openvoid_session` | Session cookie name (`oidc`). |
| `OPENVOID_AUTH_SESSION_DAYS` | `30` | Session lifetime. |
| `OPENVOID_AUTH_SECURE_COOKIES` | auto | `1` always sets `Secure`, `0` never. Auto follows the request scheme and `X-Forwarded-Proto`. |

Mode-specific settings are in each recipe.
