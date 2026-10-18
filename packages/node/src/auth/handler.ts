// Wires the configured identity mode into the request path, for the production server and the
// Vite dev server alike.
//
//   OPENVOID_AUTH=oidc | proxy | better-auth     which mode signs users in (unset: no sign-in)
//   OPENVOID_AUTH_PATH=/auth                     URL prefix the mode owns
import { runWithSession } from './context.ts';
import { SessionStore } from './sessions.ts';
import type { AuthMode, AuthSession, AuthUser, CreateAuthMode, Vars } from './types.ts';

const MODES: Record<string, () => Promise<{ createMode: CreateAuthMode }>> = {
  oidc: () => import('./modes/oidc.ts'),
  proxy: () => import('./modes/proxy.ts'),
  'better-auth': () => import('./modes/better-auth.ts'),
};

export type Auth = {
  enabled: boolean;
  basePath: string;
  mode: string | null;
  isAuthPath(pathname: string): boolean;
  /** Answer a request under basePath. */
  handle(request: Request): Promise<Response>;
  resolve(request: Request): Promise<AuthSession | null>;
  /** Answer auth paths, otherwise resolve the session and run next() with it in context. */
  wrap(request: Request, next: () => Promise<Response>): Promise<Response>;
  migrate(): Promise<void>;
  close(): Promise<void>;
};

function normalizeBasePath(value: string | undefined): string {
  const path = (value ?? '/auth').trim();
  if (!path.startsWith('/') || path === '/') throw new Error(`openvoid: OPENVOID_AUTH_PATH must be a path like /auth, got "${path}".`);
  return path.replace(/\/+$/, '');
}

async function onSignIn(user: AuthUser, vars: Vars): Promise<void> {
  if (!vars.OPENVOID_FGA_URL) return;
  const fga = await import('../fga/index.ts');
  await fga.onSignIn(user, vars);
}

export async function createAuth(options: {
  env: Record<string, unknown>;
  vars: Vars;
  dialect: 'sqlite' | 'postgresql';
}): Promise<Auth> {
  const { env, vars, dialect } = options;
  const basePath = normalizeBasePath(vars.OPENVOID_AUTH_PATH);
  const isAuthPath = (pathname: string) => pathname === basePath || pathname.startsWith(`${basePath}/`);
  const name = vars.OPENVOID_AUTH?.trim();

  if (!name) {
    return {
      enabled: false,
      basePath,
      mode: null,
      isAuthPath: () => false,
      handle: async () => Response.json({ error: 'sign-in is not configured (OPENVOID_AUTH)' }, { status: 404 }),
      resolve: async () => null,
      wrap: (_request, next) => runWithSession(null, basePath, next),
      migrate: async () => {},
      close: async () => {},
    };
  }

  const loader = MODES[name];
  if (!loader) throw new Error(`openvoid: OPENVOID_AUTH="${name}" is not a mode. Use ${Object.keys(MODES).join(', ')}.`);
  const sessions = new SessionStore(env.KV as ConstructorParameters<typeof SessionStore>[0], vars);
  const mode: AuthMode = await (await loader()).createMode({
    vars,
    env,
    sessions,
    basePath,
    dialect,
    hooks: { onSignIn: (user) => onSignIn(user, vars) },
  });

  async function handle(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === `${basePath}/session` && request.method === 'GET') {
      const session = await mode.resolve(request);
      return Response.json(
        { user: session?.user ?? null, expiresAt: session?.expiresAt ?? null },
        { headers: { 'cache-control': 'no-store' } },
      );
    }
    return (await mode.handle(request)) ?? Response.json({ error: 'not found' }, { status: 404 });
  }

  return {
    enabled: true,
    basePath,
    mode: mode.name,
    isAuthPath,
    handle,
    resolve: (request) => mode.resolve(request),
    async wrap(request, next) {
      if (isAuthPath(new URL(request.url).pathname)) return handle(request);
      const session = await mode.resolve(request);
      return runWithSession(session, basePath, next);
    },
    migrate: async () => {
      await mode.migrate?.();
    },
    close: async () => {
      await mode.close?.();
    },
  };
}
