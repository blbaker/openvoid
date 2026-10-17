import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1Database } from '../src/bindings/d1-sqlite.ts';
import { applyPgMigrations, applySqliteMigrations } from '../src/migrate.ts';
import { listenAddress } from '../src/server.ts';

const migrations = [
  { name: '0000_init.sql', sql: 'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n--> statement-breakpoint\nCREATE INDEX notes_body ON notes (body);' },
  { name: '0001_seed.sql', sql: "INSERT INTO notes (body) VALUES ('first');" },
];

describe('migrations (SQLite)', () => {
  it('applies each migration once and records it in _void_migrations', async () => {
    const db = new SqliteD1Database({ path: ':memory:' });
    assert.deepEqual(await applySqliteMigrations(db, migrations), ['0000_init.sql', '0001_seed.sql']);
    assert.deepEqual(await applySqliteMigrations(db, migrations), []);
    assert.equal(await db.prepare('SELECT count(*) AS n FROM notes').first('n'), 1);
    const names = await db.prepare('SELECT name FROM _void_migrations ORDER BY name').raw();
    assert.deepEqual(names, [['0000_init.sql'], ['0001_seed.sql']]);
  });

  it('rolls back a failing migration and names it', async () => {
    const db = new SqliteD1Database({ path: ':memory:' });
    await assert.rejects(
      () => applySqliteMigrations(db, [{ name: '0000_bad.sql', sql: 'CREATE TABLE ok (id INTEGER); NOT SQL;' }]),
      /migration 0000_bad.sql failed/,
    );
    assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").first(), null);
  });
});

describe('migrations (PostgreSQL)', { skip: process.env.OPENVOID_TEST_DATABASE_URL ? undefined : 'OPENVOID_TEST_DATABASE_URL not set' }, () => {
  it('applies once under an advisory lock, even when two migrators race', async () => {
    const url = process.env.OPENVOID_TEST_DATABASE_URL!;
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    // A throwaway schema, so the test never touches tables an app (or the e2e run) owns.
    const schema = `openvoid_test_${process.pid}`;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    const pgMigrations = [{ name: '0000_init.sql', sql: 'CREATE TABLE notes (id SERIAL PRIMARY KEY, body TEXT NOT NULL);' }];
    const [a, b] = await Promise.all([
      applyPgMigrations(scoped.toString(), pgMigrations),
      applyPgMigrations(scoped.toString(), pgMigrations),
    ]);
    assert.deepEqual([...a, ...b], ['0000_init.sql']);
    const { rows } = await admin.query(`SELECT name FROM ${schema}._void_migrations`);
    assert.deepEqual(rows, [{ name: '0000_init.sql' }]);
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
});

describe('listenAddress', () => {
  it('uses AWS_LAMBDA_HTTP_ENDPOINT when Lambda Web Functions sets it', () => {
    assert.deepEqual(listenAddress({ AWS_LAMBDA_HTTP_ENDPOINT: '127.0.0.1:8080', PORT: '3000' }), { hostname: '127.0.0.1', port: 8080 });
  });
  it('falls back to HOST and PORT', () => {
    assert.deepEqual(listenAddress({}), { hostname: '0.0.0.0', port: 3000 });
    assert.deepEqual(listenAddress({ HOST: '::', PORT: '4000' }), { hostname: '::', port: 4000 });
  });
});
