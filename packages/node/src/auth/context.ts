// What app code imports: `import { getUser, requireAuth } from '@blbaker/openvoid/auth'`.
// The names mirror Void's own `void/auth` (which Void refuses to build outside Cloudflare).
// The store lives on globalThis under a registered symbol so the bundled server and the dev
// server's module runner share one copy.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AuthSession, AuthUser } from './types.ts';

type Store = { session: AuthSession | null; basePath: string };
const KEY = Symbol.for('openvoid.authContext.v1');
const shared = globalThis as { [KEY]?: AsyncLocalStorage<Store> };
shared[KEY] ??= new AsyncLocalStorage<Store>();
const authContext = shared[KEY];

export function runWithSession<T>(session: AuthSession | null, basePath: string, fn: () => T): T {
  return authContext.run({ session, basePath }, fn);
}

/** The signed-in user for the current request, or null. */
export function getUser(): AuthUser | null {
  return authContext.getStore()?.session?.user ?? null;
}

/** The current session (user, created and expiry times), or null. */
export function getSession(): AuthSession | null {
  return authContext.getStore()?.session ?? null;
}

/** An error Void's router turns into a response (it calls getResponse() on thrown errors). */
export class AuthHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AuthHttpError';
    this.status = status;
  }
  getResponse(): Response {
    return Response.json({ error: this.message }, { status: this.status });
  }
}

/**
 * Return the signed-in user or throw a 401. Accepts (and ignores) a Hono context so code written
 * for Void's `requireAuth(c)` keeps working after changing the import.
 */
export function requireAuth(_c?: unknown): AuthUser {
  const user = getUser();
  if (!user) throw new AuthHttpError(401, 'Unauthorized');
  return user;
}

/** URL that starts sign-in, optionally with one provider and a path to come back to. */
export function signInUrl(options: { provider?: string; returnTo?: string } = {}): string {
  const base = authContext.getStore()?.basePath ?? '/auth';
  const params = new URLSearchParams();
  if (options.returnTo) params.set('returnTo', options.returnTo);
  const query = params.size > 0 ? `?${params}` : '';
  return options.provider ? `${base}/login/${encodeURIComponent(options.provider)}${query}` : `${base}/login${query}`;
}

/** URL that signs the user out (send a POST from a form or fetch). */
export function signOutUrl(): string {
  return `${authContext.getStore()?.basePath ?? '/auth'}/logout`;
}
