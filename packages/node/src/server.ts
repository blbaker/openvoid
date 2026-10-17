// Production entry used by builds that include the openvoid() Vite plugin. The plugin replaces
// Void's generated Node server (.void/index.ts) with a call to startServer().
//
//   node dist/ssr/index.js            start the server (applies pending migrations first by default)
//   node dist/ssr/index.js migrate    apply pending migrations, then exit
import { serve, type ServerType } from '@hono/node-server';
import { closeEnv, createEnv, type Dialect } from './env.ts';
import { applyPgMigrations, applySqliteMigrations, type Migration } from './migrate.ts';
import { runWithEnv, setGlobalEnv } from './scope.ts';
import type { SqliteD1Database } from './bindings/d1-sqlite.ts';
import { createAuth } from './auth/handler.ts';

type FetchApp = { fetch: (request: Request, env?: unknown) => Response | Promise<Response> };

export type StartOptions = {
  app: FetchApp;
  dialect: Dialect;
  migrations: Migration[];
  /** fga/model.fga from the app, bundled at build time; null when the app has none. */
  fgaModel?: string | null;
  vars?: NodeJS.ProcessEnv;
};

/**
 * Where to listen. AWS Lambda Web Functions sets AWS_LAMBDA_HTTP_ENDPOINT ("host:port") and only
 * routes traffic there; everywhere else HOST and PORT apply (default 0.0.0.0:3000).
 */
export function listenAddress(vars: NodeJS.ProcessEnv = process.env): { hostname: string; port: number } {
  const lambda = vars.AWS_LAMBDA_HTTP_ENDPOINT;
  if (lambda) {
    const cut = lambda.lastIndexOf(':');
    return { hostname: lambda.slice(0, cut), port: Number(lambda.slice(cut + 1)) };
  }
  return { hostname: vars.HOST ?? '0.0.0.0', port: Number(vars.PORT ?? 3000) };
}

export async function migrate(options: Omit<StartOptions, 'app'>): Promise<string[]> {
  const vars = options.vars ?? process.env;
  const env = createEnv({ dialect: options.dialect, vars });
  try {
    let applied: string[];
    if (options.dialect === 'postgresql') {
      if (!vars.DATABASE_URL) throw new Error('openvoid: DATABASE_URL is required for a PostgreSQL app.');
      applied = await applyPgMigrations(vars.DATABASE_URL, options.migrations);
    } else {
      applied = await applySqliteMigrations(env.DB as SqliteD1Database, options.migrations);
    }
    // Identity tables (better-auth mode) and the OpenFGA model follow the app's own migrations.
    const auth = await createAuth({ env, vars, dialect: options.dialect });
    await auth.migrate();
    await auth.close();
    if (vars.OPENVOID_FGA_URL) {
      const { migrateFga } = await import('./fga/index.ts');
      await migrateFga(vars, options.fgaModel ?? null);
    }
    return applied;
  } finally {
    await closeEnv(env);
  }
}

/**
 * On Lambda Web Functions the code directory is read-only and /tmp belongs to one short-lived
 * environment, so the local-file defaults would lose data. Say so at startup.
 */
function warnAboutLocalStateOnLambda(dialect: Dialect, vars: NodeJS.ProcessEnv): void {
  if (!vars.AWS_LAMBDA_HTTP_ENDPOINT) return;
  const local: string[] = [];
  if (dialect === 'sqlite') local.push('void/db (SQLite)');
  if (!vars.OPENVOID_KV || vars.OPENVOID_KV.startsWith('sqlite:')) local.push('void/kv (OPENVOID_KV)');
  if (!vars.OPENVOID_STORAGE || vars.OPENVOID_STORAGE.startsWith('file:')) local.push('void/storage (OPENVOID_STORAGE)');
  if (local.length > 0) {
    console.warn(
      `[openvoid] running on Lambda with local-file backends for ${local.join(', ')}. ` +
        'Each execution environment gets its own copy and loses it on shutdown. ' +
        'See recipes/aws-lambda-web-functions in the OpenVoid repo.',
    );
  }
}

export async function startServer(options: StartOptions): Promise<ServerType | undefined> {
  const vars = options.vars ?? process.env;
  const command = process.argv[2];
  const mode = vars.OPENVOID_MIGRATE ?? 'on-start';
  if (command === 'migrate' || mode === 'on-start') {
    const applied = await migrate(options);
    for (const name of applied) console.log(`[openvoid] applied migration ${name}`);
    if (command === 'migrate') {
      console.log(`[openvoid] migrations up to date (${applied.length} applied)`);
      return undefined;
    }
  } else if (mode !== 'off') {
    throw new Error(`openvoid: OPENVOID_MIGRATE must be "on-start" or "off", got "${mode}".`);
  }

  const env = createEnv({ dialect: options.dialect, vars });
  setGlobalEnv(env);
  warnAboutLocalStateOnLambda(options.dialect, vars);
  const auth = await createAuth({ env, vars, dialect: options.dialect });
  if (auth.enabled) console.log(`[openvoid] sign-in: ${auth.mode} under ${auth.basePath}`);
  const { hostname, port } = listenAddress(vars);
  const server = serve({
    hostname,
    port,
    fetch: (request, nodeEnv) =>
      runWithEnv(env, () => auth.wrap(request, async () => options.app.fetch(request, nodeEnv))),
  });
  server.once('listening', () => console.log(`[openvoid] listening on http://${hostname}:${port}`));

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`[openvoid] ${signal}: closing`);
    // Lambda gives 1s after SIGTERM; stop accepting, then release files and connections.
    server.close();
    void auth
      .close()
      .then(() => closeEnv(env))
      .finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 900).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
  return server;
}
