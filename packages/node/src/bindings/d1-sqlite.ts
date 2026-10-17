// SQLite-backed implementation of the Cloudflare D1 binding API, built on node:sqlite.
// Void's database layer (drizzle-orm/d1, migrations, Better Auth) talks to D1 through
// prepare/bind/all/raw/run/first, batch, exec and withSession. This file implements
// exactly that surface so the same app code runs unchanged on one machine.
import { DatabaseSync, type StatementSync, type SQLInputValue } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type Row = Record<string, unknown>;

export type D1Meta = {
  duration: number;
  changes: number;
  last_row_id: number;
  changed_db: boolean;
  rows_read: number;
  rows_written: number;
  size_after: number;
};

export type D1Result<T = Row> = { results: T[]; success: true; meta: D1Meta };

function toSqlValue(value: unknown, index: number): SQLInputValue {
  if (value === null) return null;
  if (value === undefined) {
    // D1 rejects undefined instead of silently writing NULL; keep that behaviour.
    throw new TypeError(`D1_TYPE_ERROR: Type 'undefined' not supported for value at index ${index}`);
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Date) return value.toISOString();
  throw new TypeError(`D1_TYPE_ERROR: Type '${typeof value}' not supported for value at index ${index}`);
}

function meta(changes = 0, lastRowId = 0, started = performance.now()): D1Meta {
  return {
    duration: performance.now() - started,
    changes,
    last_row_id: lastRowId,
    changed_db: changes > 0,
    rows_read: 0,
    rows_written: changes,
    size_after: 0,
  };
}

export class SqliteD1PreparedStatement {
  readonly #db: SqliteD1Database;
  readonly #sql: string;
  readonly #params: SQLInputValue[];

  constructor(db: SqliteD1Database, sql: string, params: SQLInputValue[] = []) {
    this.#db = db;
    this.#sql = sql;
    this.#params = params;
  }

  bind(...values: unknown[]): SqliteD1PreparedStatement {
    return new SqliteD1PreparedStatement(this.#db, this.#sql, values.map(toSqlValue));
  }

  /** Synchronous core shared by all() and batch(); batch must not yield between statements. */
  allSync<T = Row>(): D1Result<T> {
    const started = performance.now();
    const stmt = this.#db.statement(this.#sql);
    if (stmt.columns().length === 0) {
      const r = stmt.run(...this.#params);
      return { results: [], success: true, meta: meta(Number(r.changes), Number(r.lastInsertRowid), started) };
    }
    stmt.setReturnArrays(false);
    const results = stmt.all(...this.#params) as T[];
    return { results, success: true, meta: meta(0, 0, started) };
  }

  async all<T = Row>(): Promise<D1Result<T>> {
    return this.allSync<T>();
  }

  async run<T = Row>(): Promise<D1Result<T>> {
    return this.allSync<T>();
  }

  async first<T = unknown>(column?: string): Promise<T | null> {
    const stmt = this.#db.statement(this.#sql);
    stmt.setReturnArrays(false);
    const row = stmt.get(...this.#params) as Row | undefined;
    if (row === undefined) return null;
    if (column === undefined) return row as T;
    if (!(column in row)) throw new Error(`D1_COLUMN_NOTFOUND: Column not found (${column})`);
    return row[column] as T;
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const stmt = this.#db.statement(this.#sql);
    if (stmt.columns().length === 0) {
      stmt.run(...this.#params);
      return [];
    }
    // Arrays, not objects: joins return duplicate column names that objects would collapse.
    stmt.setReturnArrays(true);
    const rows = stmt.all(...this.#params) as unknown as T[];
    if (options?.columnNames) {
      return [stmt.columns().map((c) => c.name) as unknown as T, ...rows];
    }
    return rows;
  }
}

export type SqliteD1Session = {
  prepare(sql: string): SqliteD1PreparedStatement;
  batch<T = Row>(statements: SqliteD1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(sql: string): Promise<{ count: number; duration: number }>;
  withSession(constraint?: string): SqliteD1Session;
  getBookmark(): string | null;
};

export type SqliteD1Options = {
  /** File path, or ':memory:'. Parent directories are created. */
  path: string;
};

export class SqliteD1Database {
  readonly #db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  constructor(options: SqliteD1Options) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.#db = new DatabaseSync(options.path);
    // D1 enforces foreign keys; WAL + busy_timeout let a second process (migrations) share the file.
    this.#db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  }

  statement(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      if (this.#statements.size > 500) this.#statements.clear();
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  prepare(sql: string): SqliteD1PreparedStatement {
    return new SqliteD1PreparedStatement(this, sql);
  }

  async batch<T = Row>(statements: SqliteD1PreparedStatement[]): Promise<D1Result<T>[]> {
    // D1 runs a batch as one implicit transaction; any failure rolls back all of it.
    this.#db.exec('BEGIN');
    try {
      const results = statements.map((s) => s.allSync<T>());
      this.#db.exec('COMMIT');
      return results;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    const started = performance.now();
    this.#db.exec(sql);
    const count = sql.split(';').filter((s) => s.trim().length > 0).length;
    return { count, duration: performance.now() - started };
  }

  /** One SQLite file has no read replicas, so every session reads the primary. */
  withSession(_constraint?: string): SqliteD1Session {
    // A plain delegating object: private fields are not reachable through Object.create().
    return {
      prepare: (sql) => this.prepare(sql),
      batch: (statements) => this.batch(statements),
      exec: (sql) => this.exec(sql),
      withSession: (constraint) => this.withSession(constraint),
      getBookmark: () => null,
    };
  }

  async dump(): Promise<ArrayBuffer> {
    throw new Error('openvoid: D1 dump() is not supported by the SQLite backend. Copy the database file instead.');
  }

  close(): void {
    this.#statements.clear();
    this.#db.close();
  }
}
