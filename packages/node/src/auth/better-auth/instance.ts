// Builds the Better Auth configuration: database, email+password, Google/GitHub social sign-in,
// any number of OIDC providers through Better Auth's genericOAuth plugin, and the groups field.
import type { BetterAuthOptions } from 'better-auth';
import { genericOAuth, type GenericOAuthUserInfo } from 'better-auth/plugins/generic-oauth';
import type { AuthModeContext } from '../types.ts';
import type { BetterAuthModeConfig } from './env.ts';
import { loadAuthUser, normalizeGroupsClaim, type AccountRow, type UserRow } from './user.ts';

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
    advanced: {
      // OpenVoid always runs mode.migrate() before serving traffic (server start, dev server,
      // the `migrate` command); Better Auth's own at-construction schema check would otherwise
      // log a "missing tables" error on every cold start, before that migrate() call lands.
      database: { validateSchema: false },
    },
    user: {
      additionalFields: {
        // JSON-encoded string[], not a native array: keeps one shape on SQLite and PostgreSQL.
        // Not part of sign-up input (so a client can't set its own groups); OIDC sign-in sets
        // it through mapProfileToUser above, email+password users keep the default "[]".
        groups: { type: 'string', required: false, input: false, defaultValue: '[]' },
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
