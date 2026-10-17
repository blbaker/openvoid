// Applies Void's SQL migrations (db/migrations/*.sql) using Void's own tracking table,
// `_void_migrations (name, applied_at)`, so `void db migrate` and OpenVoid agree on what ran.
import type { SqliteD1Database } from './bindings/d1-sqlite.ts';

export type Migration = { name: string; sql: string };

export async function applySqliteMigrations(db: SqliteD1Database, migrations: Migration[]): Promise<string[]> {
  if (migrations.length === 0) return [];
  await db.exec(`CREATE TABLE IF NOT EXISTS _void_migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))`);
  const applied: string[] = [];
  for (const migration of migrations) {
    // BEGIN IMMEDIATE takes the write lock first, so two processes starting at once cannot both apply it.
    await db.exec('BEGIN IMMEDIATE');
    try {
      const done = await db.prepare('SELECT 1 AS done FROM _void_migrations WHERE name = ?').bind(migration.name).first();
      if (!done) {
        await db.exec(migration.sql);
        await db.prepare('INSERT INTO _void_migrations (name) VALUES (?)').bind(migration.name).run();
        applied.push(migration.name);
      }
      await db.exec('COMMIT');
    } catch (error) {
      await db.exec('ROLLBACK');
      throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`, { cause: error });
    }
  }
  return applied;
}

export async function applyPgMigrations(connectionString: string, migrations: Migration[]): Promise<string[]> {
  if (migrations.length === 0) return [];
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    // One migrator at a time across every instance (containers, Lambda environments).
    await client.query(`SELECT pg_advisory_lock(hashtext('openvoid:_void_migrations'))`);
    await client.query('CREATE TABLE IF NOT EXISTS _void_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
    const existing = await client.query<{ name: string }>('SELECT name FROM _void_migrations');
    const done = new Set(existing.rows.map((r) => r.name));
    const applied: string[] = [];
    for (const migration of migrations) {
      if (done.has(migration.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO _void_migrations (name, applied_at) VALUES ($1, $2)', [migration.name, new Date().toISOString()]);
        await client.query('COMMIT');
        applied.push(migration.name);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${migration.name} failed: ${(error as Error).message}`, { cause: error });
      }
    }
    return applied;
  } finally {
    await client.end();
  }
}
