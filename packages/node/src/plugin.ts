// openvoid(): a Vite plugin that lets a Void app with `target: 'node'` use void/db, void/kv,
// void/storage, void/auth and void/env, backed by your own infrastructure instead of Cloudflare.
//
// Put it BEFORE voidPlugin() in vite.config.ts:
//   plugins: [openvoid(), voidPlugin()]
// Void's node target rejects those imports in a `resolveId` hook that runs with enforce: 'pre'.
// Ours also runs pre and comes first, so it resolves them to Void's real runtime modules.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile, loadEnv, normalizePath, type Plugin, type ResolvedConfig } from 'vite';
import { closeEnv, createEnv, type Dialect, type OpenVoidEnv } from './env.ts';
import { dbModule, fgaModelModule, migrationsModule, readFgaModel, readMigrations, schemaDbModule, serverEntryModule, type DbModulePaths } from './codegen.ts';
import { applyPgMigrations, applySqliteMigrations } from './migrate.ts';
import { runWithEnv } from './scope.ts';
import { packageDir, resolveEsm } from './resolve.ts';
import type { SqliteD1Database } from './bindings/d1-sqlite.ts';
import { createAuth, type Auth } from './auth/handler.ts';
import { authMiddleware } from './auth/node-adapter.ts';

export type OpenVoidOptions = {
  /** Override the dialect from void.config.ts. */
  database?: 'sqlite' | 'pg';
};

type VoidConfig = { target?: string; database?: string; sourceDir?: string };

const VIRTUAL_DB = '\0openvoid:db';
const VIRTUAL_SCHEMA_DB = '\0openvoid:db-schema';
const VIRTUAL_MIGRATIONS = '\0openvoid:migrations';
const VIRTUAL_FGA_MODEL = '\0openvoid:fga-model';
const NODE_TARGETS = new Set(['node', 'bun', 'deno']);
// Runtime modules served straight from the installed void package.
const PASSTHROUGH = new Set(['void/kv', 'void/storage', 'void/auth', 'void/env']);

async function loadVoidConfig(root: string): Promise<VoidConfig> {
  const json = join(root, 'void.json');
  if (existsSync(json)) return JSON.parse(readFileSync(json, 'utf8')) as VoidConfig;
  for (const name of ['void.config.ts', 'void.config.mts', 'void.config.js', 'void.config.mjs']) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, file, root, 'silent');
    return (loaded?.config ?? {}) as VoidConfig;
  }
  return {};
}

function toDialect(database: string | undefined): Dialect {
  if (database === undefined || database === 'sqlite' || database === 'd1') return 'sqlite';
  if (database === 'pg' || database === 'postgresql') return 'postgresql';
  throw new Error(`openvoid: database "${database}" is not supported yet. Use sqlite or pg.`);
}

function findSchema(sourceRoot: string): string | null {
  for (const candidate of ['db/schema.ts', 'db/schema/index.ts', 'db/schema.js']) {
    const path = join(sourceRoot, candidate);
    if (existsSync(path)) return normalizePath(path);
  }
  return null;
}

/** Where the app's files are and how void/db resolves, read once from void.config.ts. */
type ProjectLayout = {
  root: string;
  sourceRoot: string;
  dialect: Dialect;
  /** db/schema.ts, or the folder (trailing "/") for db/schema/index.ts. */
  schemaDir: string | null;
  paths: DbModulePaths;
};

const migrationsDir = (layout: ProjectLayout) => join(layout.sourceRoot, 'db', 'migrations');
const fgaModelPath = (layout: ProjectLayout) => join(layout.sourceRoot, 'fga', 'model.fga');

async function readProjectLayout(root: string, options: OpenVoidOptions): Promise<ProjectLayout> {
  const voidConfig = await loadVoidConfig(root);
  if (!NODE_TARGETS.has(voidConfig.target ?? '')) {
    throw new Error(
      `openvoid: set target: 'node' in void.config.ts. OpenVoid builds on Void's Node target (found ${JSON.stringify(voidConfig.target ?? 'cloudflare')}).`,
    );
  }
  const sourceRoot = resolve(root, voidConfig.sourceDir ?? '.');
  const dialect = options.database ? toDialect(options.database) : toDialect(voidConfig.database);
  const voidDir = packageDir('void', root);
  const schema = findSchema(sourceRoot);
  // A schema folder (db/schema/index.ts) owns every file in it; a single db/schema.ts only itself.
  const schemaDir = schema ? (schema.endsWith('/index.ts') ? `${dirname(schema)}/` : schema) : null;
  const self = dirname(fileURLToPath(import.meta.url));
  const paths: DbModulePaths = {
    drizzleOrm: resolveEsm('drizzle-orm', voidDir),
    drizzleD1: resolveEsm('drizzle-orm/d1', voidDir),
    drizzleNodePg: resolveEsm('drizzle-orm/node-postgres', voidDir),
    pg: resolveEsm('pg', self, ['import', 'default', 'require']),
    voidEnv: resolveEsm('void/_env', root),
    schema,
  };
  return { root, sourceRoot, dialect, schemaDir, paths };
}

function voidExport(id: string, client: boolean, root: string): string {
  const sub = id.slice('void/'.length);
  if (sub === 'env' && client) return resolveEsm('void/env', root, ['browser', 'import', 'default']);
  return resolveEsm(`void/${sub}`, root);
}

async function devEnv(layout: ProjectLayout, resolved: ResolvedConfig): Promise<{ env: OpenVoidEnv; auth: Auth }> {
  const { dialect } = layout;
  const vars = { ...loadEnv(resolved.mode, layout.root, ''), ...process.env };
  const env = createEnv({ dialect, vars });
  const migrations = readMigrations(migrationsDir(layout));
  const applied =
    dialect === 'postgresql'
      ? vars.DATABASE_URL
        ? await applyPgMigrations(vars.DATABASE_URL, migrations)
        : []
      : await applySqliteMigrations(env.DB as SqliteD1Database, migrations);
  for (const name of applied) resolved.logger.info(`[openvoid] applied migration ${name}`);
  const auth = await createAuth({ env, vars, dialect });
  await auth.migrate();
  if (vars.OPENVOID_FGA_URL) {
    const { migrateFga } = await import('./fga/index.ts');
    await migrateFga(vars, readFgaModel(fgaModelPath(layout)));
  }
  return { env, auth };
}

type DevServer = { middlewares: { use: Function }; httpServer?: { once: Function } | null };

async function installDevMiddleware(server: DevServer, layout: ProjectLayout, resolved: ResolvedConfig): Promise<void> {
  const { env, auth } = await devEnv(layout, resolved);
  server.middlewares.use((_req: unknown, _res: unknown, next: () => void) => runWithEnv(env, () => next()));
  server.middlewares.use(authMiddleware(auth));
  server.httpServer?.once('close', () => void auth.close().then(() => closeEnv(env)));
}

export function openvoid(options: OpenVoidOptions = {}): Plugin {
  let layout: ProjectLayout;
  let resolved: ResolvedConfig;

  return {
    name: 'openvoid',
    enforce: 'pre',

    async config(userConfig) {
      layout = await readProjectLayout(resolve(userConfig.root ?? process.cwd()), options);
      const { schema } = layout.paths;
      return {
        ssr: { noExternal: ['@blbaker/openvoid'] },
        resolve: { alias: schema ? [{ find: /^@schema$/, replacement: schema }] : [] },
      };
    },

    configResolved(config) {
      resolved = config;
    },

    resolveId(id, importer) {
      const client = this.environment?.name === 'client';
      if (PASSTHROUGH.has(id)) return voidExport(id, client, layout.root);
      if (id === 'void/db') {
        if (client) return null;
        const { schemaDir } = layout;
        if (importer && schemaDir) {
          const from = normalizePath(importer);
          if (schemaDir.endsWith('/') ? from.startsWith(schemaDir) : from === schemaDir) return VIRTUAL_SCHEMA_DB;
        }
        return VIRTUAL_DB;
      }
      if (id === 'virtual:openvoid-migrations') return VIRTUAL_MIGRATIONS;
      if (id === 'virtual:openvoid-fga-model') return VIRTUAL_FGA_MODEL;
      return null;
    },

    load(id) {
      if (id === VIRTUAL_DB) return dbModule(layout.dialect, layout.paths);
      if (id === VIRTUAL_SCHEMA_DB) return schemaDbModule(layout.paths);
      if (id === VIRTUAL_MIGRATIONS) {
        const dir = migrationsDir(layout);
        for (const m of readMigrations(dir)) this.addWatchFile(join(dir, m.name));
        return migrationsModule(dir);
      }
      if (id === VIRTUAL_FGA_MODEL) {
        const model = fgaModelPath(layout);
        if (existsSync(model)) this.addWatchFile(model);
        return fgaModelModule(model);
      }
      const serverEntry = normalizePath(join(layout.root, '.void', 'index.ts'));
      if (resolved?.command === 'build' && normalizePath(id) === serverEntry) return serverEntryModule(layout.dialect);
      return null;
    },

    async configureServer(server) {
      await installDevMiddleware(server, layout, resolved);
    },

    async configurePreviewServer(server) {
      await installDevMiddleware(server, layout, resolved);
    },
  };
}
