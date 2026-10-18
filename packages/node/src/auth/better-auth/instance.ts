// Builds the Better Auth configuration: database, email+password, Google/GitHub social sign-in,
// any number of OIDC providers through Better Auth's genericOAuth plugin, and the groups field.
import type { BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { genericOAuth, type GenericOAuthUserInfo } from 'better-auth/plugins/generic-oauth';
import type { AuthModeContext } from '../types.ts';
import type { BetterAuthModeConfig } from './env.ts';
import { loadAuthUser, normalizeGroupsClaim, type AccountRow, type UserRow } from './user.ts';

/**
 * Groups come only from an identity provider. The field has to accept input (Better Auth drops
 * provider-mapped fields marked `input: false`), so any request that tries to set it directly
 * (sign-up, update-user) is refused here instead.
 */
const rejectClientGroups = createAuthMiddleware(async (ctx) => {
  const body: unknown = ctx.body;
  if (body && typeof body === 'object' && 'groups' in body) {
    throw new APIError('BAD_REQUEST', { message: 'groups is set by the identity provider, not by the client' });
  }
});

/**
 * Builds the BetterAuthOptions for this app. `database` is whatever createDatabaseBinding()
 * returned (a D1-compatible SQLite binding or a pg.Pool); Better Auth's Kysely adapter detects
 * which one it got by duck-typing, so no `type` hint is needed here.
 */
export function buildBetterAuthOptions(ctx: AuthModeContext, cfg: BetterAuthModeConfig, database: unknown): BetterAuthOptions {
  const socialProviders: NonNullable<BetterAuthOptions['socialProviders']> = {};
  if (cfg.google) socialProviders.google = cfg.google;
  if (cfg.github) socialProviders.github = cfg.github;

  const plugins: NonNullable<BetterAuthOptions['plugins']> =
    cfg.oidc.length === 0
      ? []
      : [
          genericOAuth({
            config: cfg.oidc.map((provider) => ({
              providerId: provider.name,
              discoveryUrl: `${provider.issuer}/.well-known/openid-configuration`,
              clientId: provider.clientId,
              clientSecret: provider.clientSecret,
              scopes: provider.scopes,
              // The provider is the source of truth: rewrite name, email, image and groups on
              // every sign-in, so removing someone from a group at the provider takes effect
              // here on their next sign-in instead of never.
              overrideUserInfo: true,
              mapProfileToUser: (profile: GenericOAuthUserInfo) => ({
                groups: JSON.stringify(normalizeGroupsClaim(profile[provider.groupsClaim])),
              }),
            })),
          }),
        ];

  return {
    basePath: ctx.basePath,
    baseURL: cfg.baseURL,
    secret: cfg.secret,
    // Better Auth's Kysely adapter accepts a raw D1Database or pg.Pool directly; see database.ts.
    database: database as NonNullable<BetterAuthOptions['database']>,
    emailAndPassword: { enabled: cfg.emailAndPassword },
    socialProviders,
    plugins,
    hooks: { before: rejectClientGroups },
    advanced: {
      // OpenVoid always runs mode.migrate() before serving traffic (server start, dev server,
      // the `migrate` command); Better Auth's own at-construction schema check would otherwise
      // log a "missing tables" error on every cold start, before that migrate() call lands.
      database: { validateSchema: false },
    },
    user: {
      additionalFields: {
        // JSON-encoded string[], not a native array: keeps one shape on SQLite and PostgreSQL.
        // OIDC sign-in fills it through mapProfileToUser above; everyone else keeps "[]".
        groups: { type: 'string', required: false, defaultValue: '[]' },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Fires on every new session, i.e. every sign-in, regardless of method.
          after: async (session, context) => {
            if (!context) return;
            const user = await context.context.internalAdapter.findUserById(session.userId);
            if (!user) return;
            const authUser = await loadAuthUser(context.context.adapter, user as unknown as UserRow);
            await ctx.hooks.onSignIn(authUser);
          },
        },
      },
    },
  };
}

export type { AccountRow, UserRow };
