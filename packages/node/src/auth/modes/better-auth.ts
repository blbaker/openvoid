// Better Auth sign-in: email + password, Google, GitHub, and any number of OIDC providers
// (Authelia, Keycloak, Zitadel, ...) through Better Auth's genericOAuth plugin. Accounts and
// sessions live in the app's own database, migrated with Better Auth's own migration API.
//
//   OPENVOID_AUTH=better-auth
//   OPENVOID_PUBLIC_URL=https://app.example.com         required, Better Auth's baseURL
//   BETTER_AUTH_SECRET=<random>                          required
//   OPENVOID_AUTH_EMAIL_PASSWORD=0                       disable email+password (default on)
//   OPENVOID_AUTH_GOOGLE_CLIENT_ID / _CLIENT_SECRET
//   OPENVOID_AUTH_GITHUB_CLIENT_ID / _CLIENT_SECRET
//   OPENVOID_AUTH_OIDC_PROVIDERS=family,work             comma list of provider names
//   OPENVOID_AUTH_OIDC_<NAME>_ISSUER / _CLIENT_ID / _CLIENT_SECRET / _SCOPES / _GROUPS_CLAIM
//
// See recipes/auth-better-auth for the full picture (endpoints, provider setup, what's tested).
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { safeReturnTo } from '../sessions.ts';
import { createDatabaseBinding } from '../better-auth/database.ts';
import { parseConfig } from '../better-auth/env.ts';
import { buildBetterAuthOptions } from '../better-auth/instance.ts';
import { loadAuthUser, type UserRow } from '../better-auth/user.ts';
import type { AuthMode, AuthModeContext, AuthSession } from '../types.ts';

export async function createMode(ctx: AuthModeContext): Promise<AuthMode> {
  const config = parseConfig(ctx.vars);
  const database = await createDatabaseBinding(ctx);
  const options = buildBetterAuthOptions(ctx, config, database.database);
  const auth = betterAuth(options);
  const basePath = ctx.basePath;

  async function startSignIn(request: Request, provider: string, returnTo: string): Promise<Response> {
    // returnHeaders: Better Auth sets a signed state cookie here and checks it on the callback,
    // so its Set-Cookie headers must ride along on our redirect or every callback fails with
    // state_mismatch.
    const { headers, response } = await auth.api.signInSocial({
      body: { provider, callbackURL: returnTo },
      headers: request.headers,
      returnHeaders: true,
    });
    if (!response?.url) {
      return Response.json({ error: `openvoid: could not start sign-in for provider "${provider}".` }, { status: 400 });
    }
    const redirect = new Headers({ location: response.url, 'cache-control': 'no-store' });
    for (const cookie of headers.getSetCookie()) redirect.append('set-cookie', cookie);
    return new Response(null, { status: 302, headers: redirect });
  }

  return {
    name: 'better-auth',

    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      if (url.pathname === `${basePath}/logout` && request.method === 'POST') {
        return auth.api.signOut({ headers: request.headers, asResponse: true });
      }
      if (url.pathname.startsWith(`${basePath}/login/`)) {
        const provider = decodeURIComponent(url.pathname.slice(`${basePath}/login/`.length));
        if (!provider) return null;
        return startSignIn(request, provider, safeReturnTo(url.searchParams.get('returnTo')));
      }
      if (url.pathname === `${basePath}/login`) {
        return Response.json(
          {
            error:
              `use POST ${basePath}/sign-in/email (or /sign-up/email) for email and password, ` +
              `or GET ${basePath}/login/<provider> for social or OIDC sign-in`,
          },
          { status: 400 },
        );
      }
      if (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`)) {
        // Better Auth owns everything else under basePath: sign-up/email, sign-in/email,
        // sign-in/social, callback/:id, get-session, etc.
        return auth.handler(request);
      }
      return null;
    },

    async resolve(request: Request): Promise<AuthSession | null> {
      const result = await auth.api.getSession({ headers: request.headers });
      if (!result) return null;
      const context = await auth.$context;
      const user = await loadAuthUser(context.adapter, result.user as unknown as UserRow);
      return {
        id: result.session.id,
        user,
        createdAt: new Date(result.session.createdAt).getTime(),
        expiresAt: new Date(result.session.expiresAt).getTime(),
      };
    },

    async migrate(): Promise<void> {
      const { runMigrations } = await getMigrations(options);
      await runMigrations();
    },

    async close(): Promise<void> {
      await database.close();
    },
  };
}
