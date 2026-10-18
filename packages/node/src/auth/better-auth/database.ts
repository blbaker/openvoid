// The database Better Auth stores accounts and sessions in: the app's own database, so a
// user table lives next to the app's own tables (same file for SQLite, same Postgres database).
import type { Pool } from 'pg';
import type { SqliteD1Database } from '../../bindings/d1-sqlite.ts';
import type { AuthModeContext } from '../types.ts';

export type DatabaseBinding = {
  /** Passed straight to Better Auth's `database` option; it detects D1 vs. pg.Pool itself. */
  database: SqliteD1Database | Pool;
  close(): Promise<void>;
};

export async function createDatabaseBinding(ctx: AuthModeContext): Promise<DatabaseBinding> {
  if (ctx.dialect === 'postgresql') {
    const databaseUrl = ctx.vars.DATABASE_URL;
    if (!databaseUrl) throw new Error('openvoid: better-auth mode needs DATABASE_URL for a PostgreSQL app.');
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: Number(ctx.vars.OPENVOID_PG_POOL_MAX ?? 10) });
    return { database: pool, close: () => pool.end() };
  }
  const db = ctx.env.DB as SqliteD1Database | undefined;
  if (!db) throw new Error('openvoid: better-auth mode needs env.DB for a SQLite app.');
  return {
    database: db,
    // env.DB is owned (and closed) by env.ts / closeEnv(), not by us.
    close: async () => {},
  };
}
