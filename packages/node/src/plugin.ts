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
import { dbModule, migrationsModule, readMigrations, schemaDbModule, serverEntryModule, type DbModulePaths } from './codegen.ts';
import { applyPgMigrations, applySqliteMigrations } from './migrate.ts';
import { runWithEnv } from './scope.ts';
import { packageDir, resolveEsm } from './resolve.ts';
import type { SqliteD1Database } from './bindings/d1-sqlite.ts';

export type OpenVoidOptions = {
  /** Override the dialect from void.config.ts. */
  database?: 'sqlite' | 'pg';
};

type VoidConfig = { target?: string; database?: string; sourceDir?: string };

const VIRTUAL_DB = '\0openvoid:db';
const VIRTUAL_SCHEMA_DB = '\0openvoid:db-schema';
const VIRTUAL_MIGRATIONS = '\0openvoid:migrations';
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

export function openvoid(options: OpenVoidOptions = {}): Plugin {
  let root = process.cwd();
  let sourceRoot = root;
  let dialect: Dialect = 'sqlite';
  let paths: DbModulePaths;
  let voidDir = '';
  let schemaDir: string | null = null;
  let resolved: ResolvedConfig;

  const serverEntry = () => normalizePath(join(root, '.void', 'index.ts'));
  const migrationsDir = () => join(sourceRoot, 'db', 'migrations');

  function voidExport(id: string, client: boolean): string {
    const sub = id.slice('void/'.length);
    if (sub === 'env' && client) return resolveEsm('void/env', root, ['browser', 'import', 'default']);
    return resolveEsm(`void/${sub}`, root);
  }

  async function devEnv(): Promise<OpenVoidEnv> {
    const vars = { ...loadEnv(resolved.mode, root, ''), ...process.env };
    const env = createEnv({ dialect, vars });
    const migrations = readMigrations(migrationsDir());
    const applied =
      dialect === 'postgresql'
        ? vars.DATABASE_URL
          ? await applyPgMigrations(vars.DATABASE_URL, migrations)
          : []
        : await applySqliteMigrations(env.DB as SqliteD1Database, migrations);
    for (const name of applied) resolved.logger.info(`[openvoid] applied migration ${name}`);
    return env;
  }

  return {
    name: 'openvoid',
    enforce: 'pre',

    async config(userConfig) {
      root = resolve(userConfig.root ?? process.cwd());
      const voidConfig = await loadVoidConfig(root);
      if (!NODE_TARGETS.has(voidConfig.target ?? '')) {
        throw new Error(
          `openvoid: set target: 'node' in void.config.ts. OpenVoid builds on Void's Node target (found ${JSON.stringify(voidConfig.target ?? 'cloudflare')}).`,
        );
      }
      sourceRoot = resolve(root, voidConfig.sourceDir ?? '.');
      dialect = options.database ? toDialect(options.database) : toDialect(voidConfig.database);
      voidDir = packageDir('void', root);
      const schema = findSchema(sourceRoot);
      // A schema folder (db/schema/index.ts) owns every file in it; a single db/schema.ts only itself.
      schemaDir = schema ? (schema.endsWith('/index.ts') ? `${dirname(schema)}/` : schema) : null;
      const self = dirname(fileURLToPath(import.meta.url));
      paths = {
        drizzleOrm: resolveEsm('drizzle-orm', voidDir),
        drizzleD1: resolveEsm('drizzle-orm/d1', voidDir),
        drizzleNodePg: resolveEsm('drizzle-orm/node-postgres', voidDir),
        pg: resolveEsm('pg', self, ['import', 'default', 'require']),
        voidEnv: resolveEsm('void/_env', root),
        schema,
      };
      return {
        ssr: { noExternal: ['@openvoid/node'] },
        resolve: { alias: schema ? [{ find: /^@schema$/, replacement: schema }] : [] },
      };
    },

    configResolved(config) {
      resolved = config;
    },

    resolveId(id, importer) {
      const client = this.environment?.name === 'client';
      if (PASSTHROUGH.has(id)) return voidExport(id, client);
      if (id === 'void/db') {
        if (client) return null;
        if (importer && schemaDir) {
          const from = normalizePath(importer);
          if (schemaDir.endsWith('/') ? from.startsWith(schemaDir) : from === schemaDir) return VIRTUAL_SCHEMA_DB;
        }
        return VIRTUAL_DB;
      }
      if (id === 'virtual:openvoid-migrations') return VIRTUAL_MIGRATIONS;
      return null;
    },

    load(id) {
      if (id === VIRTUAL_DB) return dbModule(dialect, paths);
      if (id === VIRTUAL_SCHEMA_DB) return schemaDbModule(paths);
      if (id === VIRTUAL_MIGRATIONS) {
        for (const m of readMigrations(migrationsDir())) this.addWatchFile(join(migrationsDir(), m.name));
        return migrationsModule(migrationsDir());
      }
      if (resolved?.command === 'build' && normalizePath(id) === serverEntry()) return serverEntryModule(dialect);
      return null;
    },

    async configureServer(server) {
      const env = await devEnv();
      server.middlewares.use((_req, _res, next) => runWithEnv(env, () => next()));
      server.httpServer?.once('close', () => void closeEnv(env));
    },

    async configurePreviewServer(server) {
      const env = await devEnv();
      server.middlewares.use((_req, _res, next) => runWithEnv(env, () => next()));
      server.httpServer?.once('close', () => void closeEnv(env));
    },
  };
}
