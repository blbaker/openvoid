// KV binding on a local SQLite file. Good for one server or a container with a volume.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  assertKey,
  clampLimit,
  cursor,
  decodeValue,
  expiryFrom,
  isExpired,
  toBytes,
  type KVGetOptions,
  type KVListOptions,
  type KVListResult,
  type KVNamespaceLike,
  type KVPutOptions,
  type KVPutValue,
} from './kv-common.ts';

type KvRow = { k: string; v: Uint8Array; exp: number | null; meta: string | null };

export class SqliteKVNamespace implements KVNamespaceLike {
  readonly #db: DatabaseSync;

  constructor(options: { path: string }) {
    if (options.path !== ':memory:') mkdirSync(dirname(options.path), { recursive: true });
    this.#db = new DatabaseSync(options.path);
    this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS openvoid_kv (k TEXT PRIMARY KEY, v BLOB NOT NULL, exp INTEGER, meta TEXT) WITHOUT ROWID;`);
  }

  #row(key: string): KvRow | null {
    assertKey(key);
    const row = this.#db.prepare('SELECT k, v, exp, meta FROM openvoid_kv WHERE k = ?').get(key) as KvRow | undefined;
    if (!row) return null;
    if (isExpired(row.exp)) {
      this.#db.prepare('DELETE FROM openvoid_kv WHERE k = ? AND exp = ?').run(key, row.exp);
      return null;
    }
    return row;
  }

  async get(key: string, options?: KVGetOptions): Promise<unknown> {
    return decodeValue(this.#row(key)?.v ?? null, options);
  }

  async getWithMetadata(key: string, options?: KVGetOptions) {
    const row = this.#row(key);
    return {
      value: decodeValue(row?.v ?? null, options),
      metadata: row?.meta ? JSON.parse(row.meta) : null,
      cacheStatus: null,
    };
  }

  async put(key: string, value: KVPutValue, options?: KVPutOptions): Promise<void> {
    assertKey(key);
    const bytes = await toBytes(value);
    const meta = options?.metadata === undefined ? null : JSON.stringify(options.metadata);
    this.#db
      .prepare('INSERT OR REPLACE INTO openvoid_kv (k, v, exp, meta) VALUES (?, ?, ?, ?)')
      .run(key, bytes, expiryFrom(options), meta);
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    this.#db.prepare('DELETE FROM openvoid_kv WHERE k = ?').run(key);
  }

  async list(options: KVListOptions = {}): Promise<KVListResult> {
    const limit = clampLimit(options.limit);
    const prefix = options.prefix ?? '';
    const after = cursor.decode(options.cursor);
    const now = Math.floor(Date.now() / 1000);
    // substr() comparison instead of LIKE: keys may contain % and _.
    const rows = this.#db
      .prepare(
        `SELECT k, exp, meta FROM openvoid_kv
         WHERE substr(k, 1, length(?)) = ? AND k > ? AND (exp IS NULL OR exp > ?)
         ORDER BY k LIMIT ?`,
      )
      .all(prefix, prefix, after, now, limit + 1) as Array<Omit<KvRow, 'v'>>;
    const page = rows.slice(0, limit);
    const complete = rows.length <= limit;
    return {
      keys: page.map((r) => ({
        name: r.k,
        ...(r.exp !== null ? { expiration: r.exp } : {}),
        ...(r.meta !== null ? { metadata: JSON.parse(r.meta) } : {}),
      })),
      list_complete: complete,
      ...(complete ? {} : { cursor: cursor.encode(page[page.length - 1]!.k) }),
      cacheStatus: null,
    };
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
