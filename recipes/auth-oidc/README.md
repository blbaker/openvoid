# Recipe: OIDC and GitHub sign-in

`OPENVOID_AUTH=oidc` is OpenVoid's own sign-in: OpenID Connect (any provider that speaks it:
Authelia, Keycloak, Zitadel, Dex, Cognito, Entra...) plus GitHub's OAuth, several providers at
once if you want. No Cloudflare account, no third-party auth service.

Authorization Code flow with PKCE (S256) for every OIDC provider, `state` and `nonce` checked on
every callback, the ID token validated through `openid-client`. GitHub has no ID token, so it's
plain OAuth 2: the user comes from `api.github.com`. Sessions live in OpenVoid's KV binding, the
same as every other `OPENVOID_AUTH` mode; see [docs/identity.md](../../docs/identity.md) for the
shared session and `AuthUser` shape.

## What you get

- `GET /auth/login`: one provider configured, redirects straight to it; more than one, shows a
  plain HTML picker.
- `GET /auth/login/<name>?returnTo=/path`: start sign-in with one named provider.
- `GET /auth/callback/<name>`: where the provider sends the browser back. Registered as the
  redirect URI with the provider; never guess this from the request, it always matches
  `OPENVOID_PUBLIC_URL`.
- `POST /auth/logout`: clears the session. Rejects cross-site requests (checked against
  `Origin`/`Sec-Fetch-Site`, not just the cookie). Optionally redirects through the provider's own
  RP-initiated logout first.
- `GET /auth/session`: handled by OpenVoid's core for every mode, not this recipe.

A sign-in in progress (the PKCE verifier, `nonce`, which provider, `returnTo`) is stored in KV for
10 minutes and deleted the moment the callback reads it, bound to the browser by a short-lived
`HttpOnly` cookie. A callback whose cookie doesn't match its `state` query parameter is rejected.

## Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENVOID_PUBLIC_URL` | | **Required.** The externally reachable base URL of this app, e.g. `https://notes.example.com`. Redirect URIs are always `${OPENVOID_PUBLIC_URL}${OPENVOID_AUTH_PATH}/callback/<name>`. |
| `OPENVOID_AUTH_OIDC_PROVIDERS` | | **Required.** Comma-separated provider names, e.g. `family,google,github`. Each name becomes a URL segment and an env var prefix. |
| `OPENVOID_AUTH_OIDC_<NAME>_TYPE` | `oidc` | `oidc` or `github`. |
| `OPENVOID_AUTH_OIDC_<NAME>_ISSUER` | | `oidc` only. The provider's discovery issuer, e.g. `https://auth.example.com`. OpenVoid fetches `<issuer>/.well-known/openid-configuration`. |
| `OPENVOID_AUTH_OIDC_<NAME>_CLIENT_ID` | | Required for every provider. |
| `OPENVOID_AUTH_OIDC_<NAME>_CLIENT_SECRET` | | Required for every provider. |
| `OPENVOID_AUTH_OIDC_<NAME>_SCOPES` | `openid email profile` (`read:user user:email` for `github`) | Space- or comma-separated. |
| `OPENVOID_AUTH_OIDC_<NAME>_LABEL` | the provider name, capitalized (`GitHub` for `github`) | Shown on the sign-in picker. HTML-escaped. |
| `OPENVOID_AUTH_OIDC_<NAME>_GROUPS_CLAIM` | `groups` | Which claim (ID token or userinfo) holds the user's groups. Accepts a JSON array or a comma-separated string. `github` always has an empty group list. |
| `OPENVOID_AUTH_OIDC_<NAME>_GITHUB_URL` | `https://github.com` | `github` only. Lets a test point this at a local mock instead of github.com. |
| `OPENVOID_AUTH_OIDC_<NAME>_GITHUB_API_URL` | `https://api.github.com` | `github` only. Same, for the user/emails lookups. |
| `OPENVOID_AUTH_OIDC_ALLOW_HTTP` | unset | Set to `1` to allow a plain-`http` issuer. Only for local development providers (Dex) that don't terminate TLS themselves; never set this against a real deployment. |
| `OPENVOID_AUTH_OIDC_LOGOUT` | unset | A provider name. On sign-out, if the signed-in user came from that provider and it advertises `end_session_endpoint`, `/auth/logout`'s response includes a `redirectTo` URL for RP-initiated logout at the provider. |

Plus the settings every mode shares (`OPENVOID_AUTH_PATH`, `OPENVOID_AUTH_COOKIE`,
`OPENVOID_AUTH_SESSION_DAYS`, `OPENVOID_AUTH_SECURE_COOKIES`), see
[docs/identity.md](../../docs/identity.md).

`<NAME>` is the provider name, upper-cased, with every character that isn't a letter or digit
turned into `_`. A provider named `family` reads `OPENVOID_AUTH_OIDC_FAMILY_CLIENT_ID`; a
provider named `my-idp` reads `OPENVOID_AUTH_OIDC_MY_IDP_CLIENT_ID`.

## Provider setup

Every provider needs the same two things from you: a redirect URI to register
(`${OPENVOID_PUBLIC_URL}${OPENVOID_AUTH_PATH}/callback/<name>`, `/auth/callback/<name>` with the
default path) and a client ID and secret to put in `OPENVOID_AUTH_OIDC_<NAME>_CLIENT_ID` and
`_CLIENT_SECRET`.

### Authelia

Add a client under `identity_providers.oidc.clients` in Authelia's `configuration.yml`:

```yaml
identity_providers:
  oidc:
    clients:
      - client_id: "openvoid"
        client_name: "OpenVoid"
        client_secret: "$pbkdf2-sha512$..." # authelia crypto hash generate pbkdf2 --variant sha512
        public: false
        authorization_policy: "two_factor"
        redirect_uris:
          - "https://notes.example.com/auth/callback/family"
        scopes: ["openid", "profile", "email", "groups"]
        grant_types: ["authorization_code", "refresh_token"]
        response_types: ["code"]
```

```
OPENVOID_AUTH_OIDC_FAMILY_ISSUER=https://auth.example.com
OPENVOID_AUTH_OIDC_FAMILY_CLIENT_ID=openvoid
OPENVOID_AUTH_OIDC_FAMILY_CLIENT_SECRET=<the plaintext secret you hashed above>
```

Issuer is Authelia's own public URL. Groups show up in the `groups` claim once the client's
`scopes` list includes `groups`; recent Authelia versions (4.38+) may also need a
`claims_policy` that lists `groups` under `id_token` and references it from the client (see
Authelia's [OpenID Connect claims docs](https://www.authelia.com/integration/openid-connect/openid-connect-1.0-claims/)
if `groups` only shows up from the userinfo endpoint and not the ID token).

### Keycloak

Create a confidential client (**Clients** → **Create client**, OpenID Connect, client
authentication on, standard flow only), set **Valid redirect URIs** to the callback URL, and copy
the secret from the **Credentials** tab.

```
OPENVOID_AUTH_OIDC_FAMILY_ISSUER=https://keycloak.example.com/realms/family
OPENVOID_AUTH_OIDC_FAMILY_CLIENT_ID=openvoid
OPENVOID_AUTH_OIDC_FAMILY_CLIENT_SECRET=<from the Credentials tab>
```

The issuer is `https://<host>/realms/<realm>`; check it against the `issuer` field at
`https://<host>/realms/<realm>/.well-known/openid-configuration`.

Keycloak does not put group membership in any token by default. Add a **Group Membership**
protocol mapper (Client scopes → the client's dedicated scope → Mappers → Add mapper → By
configuration): Token Claim Name `groups`, Full group path off, add to ID token, access token
and userinfo all on.

### Zitadel

Create a Web application in a Zitadel project, add the callback URL as a redirect URI, and use
**Authorization Code** with PKCE.

```
OPENVOID_AUTH_OIDC_FAMILY_ISSUER=https://your-instance.zitadel.cloud
OPENVOID_AUTH_OIDC_FAMILY_CLIENT_ID=<application client id>
OPENVOID_AUTH_OIDC_FAMILY_CLIENT_SECRET=<application client secret>
```

Issuer is the instance domain (cloud: `https://<instance>.zitadel.cloud`; self-hosted: your own
domain). Zitadel has no plain `groups` claim: project authorizations show up under
`urn:zitadel:iam:org:project:roles` (or a project-scoped variant of that URN). Either point
`OPENVOID_AUTH_OIDC_FAMILY_GROUPS_CLAIM` at that URN (the value is an object keyed by role name,
not an array, so this mode's array/comma-string parsing will not read it directly), or add a
Zitadel [Action](https://zitadel.com/docs/apis/openidoauth/claims#custom-claims) that flattens
roles into a plain `groups` array claim and point `_GROUPS_CLAIM` at that claim's name instead.

### Dex

Dex is the self-hosted provider this recipe is tested against end to end; see
[dev/config.yaml](dev/config.yaml) for a complete, working example (one static client, one
static password user, `skipApprovalScreen: true`).

```
OPENVOID_AUTH_OIDC_ALLOW_HTTP=1   # unless Dex sits behind TLS
OPENVOID_AUTH_OIDC_FAMILY_ISSUER=http://dex.internal:5556/dex
OPENVOID_AUTH_OIDC_FAMILY_CLIENT_ID=openvoid-dev
OPENVOID_AUTH_OIDC_FAMILY_CLIENT_SECRET=openvoid-dev-secret
```

Register the client in Dex's config under `staticClients`, with `redirectURIs` listing the exact
callback URL. Dex's LDAP and most SSO connectors can carry real group membership into Dex (see
Dex's connector docs); its `staticPasswords` test fixture cannot, by design, so `groups` is empty
when signing in with a static password even if you add a `groups:` list to the user entry.

### Google

In the Google Cloud Console, create an OAuth client (**APIs & Services** → **Credentials** →
**Create OAuth client ID**, type **Web application**), and add the callback URL under
**Authorized redirect URIs**. Google requires `https` redirect URIs except on `localhost`.

```
OPENVOID_AUTH_OIDC_GOOGLE_ISSUER=https://accounts.google.com
OPENVOID_AUTH_OIDC_GOOGLE_CLIENT_ID=<client id>.apps.googleusercontent.com
OPENVOID_AUTH_OIDC_GOOGLE_CLIENT_SECRET=<client secret>
```

Google's consumer OIDC has no `groups` claim; `groups` will always be empty for `google` sign-ins
here. (Google Workspace group membership is only reachable through the separate Admin SDK
Directory API with domain-wide delegation, which this mode does not implement.)

### GitHub

GitHub has no OpenID Connect, so `_TYPE=github` is plain OAuth 2: this mode calls
`https://github.com/login/oauth/authorize` and `/access_token`, then
`https://api.github.com/user` and `/user/emails` for the primary verified email. This is the path
tested end to end in `packages/node/test/auth-oidc.test.ts`, against an in-test mock server
standing in for both hosts.

Create an OAuth App at **Settings** → **Developer settings** → **OAuth Apps** → **New OAuth App**,
and set **Authorization callback URL** to the callback URL.

```
OPENVOID_AUTH_OIDC_GITHUB_TYPE=github
OPENVOID_AUTH_OIDC_GITHUB_CLIENT_ID=<client id>
OPENVOID_AUTH_OIDC_GITHUB_CLIENT_SECRET=<client secret>
```

GitHub's classic OAuth Apps don't support PKCE; this mode relies on `state` plus the transaction
cookie for CSRF protection here, the same as it does for every provider. `groups` is always
empty: GitHub's OAuth API has no concept of groups.

### Microsoft Entra ID

Register an app (**Entra admin center** → **App registrations** → **New registration**), add the
callback URL as a **Web** redirect URI, and create a client secret under **Certificates &
secrets**.

```
OPENVOID_AUTH_OIDC_WORK_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OPENVOID_AUTH_OIDC_WORK_CLIENT_ID=<application (client) id>
OPENVOID_AUTH_OIDC_WORK_CLIENT_SECRET=<client secret value>
```

For groups, go to **Token configuration** → **Add groups claim**, pick **Security groups**, and
turn it on for the ID token. By default the claim holds group object IDs, not names; to get names
back set `groupMembershipClaims` to `ApplicationGroup` in the app manifest, assign the specific
groups you care about to the Enterprise Application, and add `cloud_displayname` to the `groups`
claim's `additionalProperties`, or accept object IDs as the group names. A user in more than
roughly 200 groups gets an overage indicator instead of a `groups` claim at all; this mode does
not handle that case.

### AWS Cognito

Create a user pool, add an app client (confidential, with a client secret, the `openid`,
`email`, `profile` scopes, and Authorization code grant), set up a Cognito Hosted UI domain, and
add the callback URL to the app client's **Allowed callback URLs**.

```
OPENVOID_AUTH_OIDC_WORK_ISSUER=https://cognito-idp.<region>.amazonaws.com/<user-pool-id>
OPENVOID_AUTH_OIDC_WORK_CLIENT_ID=<app client id>
OPENVOID_AUTH_OIDC_WORK_CLIENT_SECRET=<app client secret>
OPENVOID_AUTH_OIDC_WORK_GROUPS_CLAIM=cognito:groups
```

Cognito puts group membership under the non-standard `cognito:groups` claim, not `groups`, hence
the `_GROUPS_CLAIM` override. The Hosted UI domain is required: Cognito's discovery document
points the authorization and userinfo endpoints at it, not at `cognito-idp.*`.

## Multiple providers at once

This is the point of the mode: a family's self-hosted provider and public social sign-in,
together.

```
OPENVOID_PUBLIC_URL=https://notes.example.com
OPENVOID_AUTH=oidc
OPENVOID_AUTH_OIDC_PROVIDERS=family,google,github

OPENVOID_AUTH_OIDC_FAMILY_LABEL=Family
OPENVOID_AUTH_OIDC_FAMILY_ISSUER=https://auth.example.com
OPENVOID_AUTH_OIDC_FAMILY_CLIENT_ID=openvoid
OPENVOID_AUTH_OIDC_FAMILY_CLIENT_SECRET=...

OPENVOID_AUTH_OIDC_GOOGLE_ISSUER=https://accounts.google.com
OPENVOID_AUTH_OIDC_GOOGLE_CLIENT_ID=....apps.googleusercontent.com
OPENVOID_AUTH_OIDC_GOOGLE_CLIENT_SECRET=...

OPENVOID_AUTH_OIDC_GITHUB_TYPE=github
OPENVOID_AUTH_OIDC_GITHUB_CLIENT_ID=...
OPENVOID_AUTH_OIDC_GITHUB_CLIENT_SECRET=...
```

With three providers configured, `GET /auth/login` shows a plain HTML picker ("Family", "Google",
"GitHub") instead of redirecting straight to one. Each person's `AuthUser.id` is
`<provider>:<subject>`, so the same person signing in through two different providers gets two
different OpenVoid accounts; that is by design, the same as every other OpenVoid identity mode.

## What was tested

- **Dex, end to end.** `scripts/e2e.sh oidc` starts a real Dex container (config in
  [dev/config.yaml](dev/config.yaml)), starts the `notes` example with `OPENVOID_AUTH=oidc`
  pointed at it, and drives the actual sign-in with `scripts/oidc-login.mjs`: plain `fetch` and a
  cookie jar submit Dex's real login form, no browser and nothing about the OIDC exchange
  mocked. It checks `/api/me` and `/auth/session` reflect the signed-in user, that a cross-site
  `POST /auth/logout` is rejected, and that `/api/me` is `401` again after signing out.
- **GitHub, against a mock.** `packages/node/test/auth-oidc.test.ts` runs the full GitHub OAuth
  flow (authorize redirect, token exchange, user and email lookups) against an in-test
  `node:http` server standing in for `github.com` and `api.github.com`. Also covers config
  validation errors, the sign-in picker's HTML escaping, the state/transaction-cookie binding, a
  replayed callback, the open-redirect guard on `returnTo`, and both forms of the cross-site
  logout check.
- **Groups claim mapping** (`groupsFrom`, array or comma-string input) is unit-tested directly;
  Dex's static-password test fixture doesn't carry a `groups` claim (confirmed by inspecting a
  real ID token from it with `groups` in the requested scope), so this is covered as a unit test
  rather than end to end.
- **Authelia, Keycloak, Zitadel, Google, Microsoft Entra ID and AWS Cognito** are configured from
  each provider's own documentation as of October 2026 (cited inline above) and have **not** been
  tested against a real instance of any of them. If one of the setup steps above is wrong, please
  open an issue.
- RP-initiated logout (`OPENVOID_AUTH_OIDC_LOGOUT`) is implemented against `openid-client`'s
  `buildEndSessionUrl`, but Dex does not advertise `end_session_endpoint`, so there is no end to
  end coverage of that path; it degrades to a plain sign-out (`redirectTo: null`) whenever the
  provider doesn't advertise one, which is exercised by the Dex and GitHub runs above.
