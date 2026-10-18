# Recipes

A recipe is a tested way to run an OpenVoid app on one platform. Each one says which backend
sits behind each Void API, which files to copy into your app, and which commands to run.

| Recipe | `void/db` | `void/kv` | `void/storage` | Tested by |
| --- | --- | --- | --- | --- |
| [Docker](docker) | SQLite on a volume, or PostgreSQL | SQLite or Redis | Files or S3-compatible | `e2e.sh docker`, `e2e.sh compose` |
| [AWS Lambda Web Functions](aws-lambda-web-functions) | PostgreSQL (RDS, Aurora) | DynamoDB | S3 | `e2e.sh lambda` (local contract run, see below) |
| [Plain Node.js](node) | SQLite or PostgreSQL | SQLite, Redis or DynamoDB | Files or S3 | `e2e.sh local`, `e2e.sh services` |

Sign-in and permissions work on any of the platforms above. See [identity](../docs/identity.md)
for how the modes compare.

| Recipe | `OPENVOID_AUTH` | Who signs people in | Tested by |
| --- | --- | --- | --- |
| [Login proxy](auth-proxy) | `proxy` | oauth2-proxy or Authelia in front of the app | `e2e.sh proxy`, `e2e.sh proxyoauth` |
| [OIDC and GitHub](auth-oidc) | `oidc` | OpenVoid, through any OpenID Connect provider plus GitHub | `e2e.sh oidc` |
| [Better Auth](auth-better-auth) | `better-auth` | OpenVoid through Better Auth: email and password, Google, GitHub, OIDC | `e2e.sh betterauth` |
| [OpenFGA](authz-openfga) | any | Permissions on top of a sign-in mode | `e2e.sh openfga` |

## What "tested" means here

- **Docker**: the image is built from the recipe's Dockerfile and run with both Compose files.
  The smoke test drives every API over HTTP, then the single-container setup is restarted to
  check that data survives on the volume.
- **AWS Lambda Web Functions**: the package built by the recipe's `package.sh` runs in a
  `node:24-slim` container under the platform's rules: read-only code directory, writable
  `/tmp` only, `AWS_LAMBDA_HTTP_ENDPOINT`, a 10 second start window and `SIGTERM` on
  shutdown. DynamoDB Local, an S3-compatible server and PostgreSQL stand in for the AWS
  services. CI runs this on arm64, the only architecture Web Functions use. It has **not**
  been deployed to a real AWS account yet; the deploy commands follow the AWS documentation as
  of October 2026.
- **Plain Node.js**: the example apps run as plain `node` processes against local files and
  against PostgreSQL, Redis and S3.
- **Login proxy**: oauth2-proxy with Dex is built from the recipe's Compose file and signed into
  over real HTTP through Dex's login form. A request that skips the proxy with a forged
  identity header gets a 401. The Authelia and Caddy setup was run by hand, not in `e2e.sh`.
- **OIDC and GitHub**: a real Dex container, signed into through its login form with plain
  `fetch`. GitHub runs against an in-test stand-in for its API. Authelia, Keycloak, Zitadel,
  Google, Entra and Cognito follow each provider's documentation and have not been run.
- **Better Auth**: email and password on SQLite and PostgreSQL, and OIDC through a real Dex
  container, including groups from Dex's `groups` claim. Real Google and GitHub apps have not
  been run; their redirect and state cookie are covered with fake credentials.
- **OpenFGA**: a real OpenFGA container behind the `notes` example: owners, a denied stranger,
  a share to a group, and that group's members reading but not writing. The production
  Compose file and Okta FGA were checked by hand or from documentation.

## Adding a recipe

A new recipe needs a folder here with a README in the same shape as the others (mapping, files,
steps, what was tested), any files users copy, and a scenario in `scripts/e2e.sh` that runs it.
If the platform can't run in CI, emulate its contract the way the Lambda scenario does and say
plainly what the emulation does not cover.
