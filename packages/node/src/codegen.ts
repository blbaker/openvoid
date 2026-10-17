// Source for the modules the openvoid() plugin generates at build time.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Dialect } from './env.ts';

// Same helpers Void re-exports from `void/db`, so apps never import drizzle-orm directly.
export const DRIZZLE_OPERATORS =
  'sql, eq, ne, gt, gte, lt, lte, and, or, not, desc, asc, like, ilike, notLike, inArray, notInArray, isNull, isNotNull, between, notBetween, exists, notExists, count, sum, avg, min, max';

export type DbModulePaths = {
  drizzleOrm: string;
  drizzleD1: string;
  drizzleNodePg: string;
  pg: string;
  voidEnv: string;
  schema: string | null;
};

/** `void/db` for schema files: helpers only, no runtime instance (avoids an import cycle). */
export function schemaDbModule(p: DbModulePaths): string {
  return `export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(p.drizzleOrm)};
export const db = {};
export function createDb() { throw new Error("db: createDb() is unavailable when importing void/db from a schema file."); }
`;
}

export function dbModule(dialect: Dialect, p: DbModulePaths): string {
  const schemaImport = p.schema ? `import * as schema from ${JSON.stringify(p.schema)};` : '';
  const withSchema = p.schema ? ', { schema }' : '';
  const ops = `export { ${DRIZZLE_OPERATORS} } from ${JSON.stringify(p.drizzleOrm)};`;
  if (dialect === 'postgresql') {
    // One long-lived pool per process: a Node server is not a Worker, connections can be reused.
    return `import { drizzle } from ${JSON.stringify(p.drizzleNodePg)};
import pg from ${JSON.stringify(p.pg)};
import { getRuntimeBinding } from ${JSON.stringify(p.voidEnv)};
${schemaImport}
${ops}

let pool;
let instance;
function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL ?? getRuntimeBinding("DATABASE_URL");
    if (!connectionString) throw new Error("db: PostgreSQL is not configured. Set DATABASE_URL.");
    pool = new pg.Pool({ connectionString, max: Number(process.env.OPENVOID_PG_POOL_MAX ?? 10) });
  }
  return pool;
}

export const db = new Proxy({}, {
  get(_, prop) {
    instance ??= drizzle({ client: getPool()${p.schema ? ', schema' : ''} });
    const value = Reflect.get(instance, prop);
    return typeof value === "function" ? value.bind(instance) : value;
  },
});

export function createDb(connectionString) {
  return drizzle(connectionString${withSchema});
}
`;
  }
  return `import { drizzle } from ${JSON.stringify(p.drizzleD1)};
import { getRuntimeRequestResource, requireRuntimeBinding } from ${JSON.stringify(p.voidEnv)};
${schemaImport}
${ops}

const requestKey = {};
export const db = new Proxy({}, {
  get(_, prop) {
    const instance = getRuntimeRequestResource(
      requestKey,
      () => createDb(requireRuntimeBinding("DB")),
      () => createDb(requireRuntimeBinding("DB")),
    );
    return Reflect.get(instance, prop);
  },
});

export function createDb(d1) {
  return drizzle(d1.withSession("first-unconstrained")${withSchema});
}
`;
}

export function readMigrations(dir: string): Array<{ name: string; sql: string }> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && f !== 'seed.sql')
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(dir, name), 'utf8') }));
}

export function migrationsModule(dir: string): string {
  return `export default ${JSON.stringify(readMigrations(dir))};\n`;
}

export function readFgaModel(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

export function fgaModelModule(path: string): string {
  return `export default ${JSON.stringify(readFgaModel(path))};\n`;
}

export function serverEntryModule(dialect: Dialect): string {
  return `import app from "./app.js";
import migrations from "virtual:openvoid-migrations";
import fgaModel from "virtual:openvoid-fga-model";
import { startServer } from "@openvoid/node/server";

await startServer({ app, migrations, fgaModel, dialect: ${JSON.stringify(dialect)} });
`;
}
