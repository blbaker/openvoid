// R2-compatible object storage on the local filesystem.
// Bytes live in <root>/blobs/<id>; an SQLite index (<root>/index.sqlite) holds keys and metadata,
// so any key (slashes, dots, "..", unicode) is safe and list() pages in key order like R2.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  R2_MAX_LIST_LIMIT,
  R2Object,
  R2ObjectBody,
  md5Hex,
  normalizeHttpMetadata,
  putValueToBytes,
  rejectUnsupported,
  resolveRange,
  type R2GetOptions,
  type R2ListOptions,
  type R2PutOptions,
  type R2PutValue,
  type StoredObject,
} from './r2-common.ts';

type IndexRow = { k: string; blob: string; size: number; etag: string; uploaded: number; http: string; custom: string };

// Sorts after every valid UTF-8 sequence, so "<prefix>" + MAX skips a whole delimited group.
const MAX_CHAR = '\u{10FFFF}';

function toStored(row: IndexRow): StoredObject {
  const http = JSON.parse(row.http) as StoredObject['httpMetadata'] & { cacheExpiry?: string };
  return {
    key: row.k,
    size: row.size,
    etag: row.etag,
    version: row.blob,
    uploaded: new Date(row.uploaded),
    httpMetadata: { ...http, ...(http.cacheExpiry ? { cacheExpiry: new Date(http.cacheExpiry) } : {}) },
    customMetadata: JSON.parse(row.custom) as Record<string, string>,
  };
}

export class FileR2Bucket {
  readonly #root: string;
  readonly #db: DatabaseSync;

  constructor(options: { root: string }) {
    this.#root = options.root;
    mkdirSync(join(this.#root, 'blobs'), { recursive: true });
    this.#db = new DatabaseSync(join(this.#root, 'index.sqlite'));
    this.#db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS objects (k TEXT PRIMARY KEY, blob TEXT NOT NULL, size INTEGER NOT NULL,
        etag TEXT NOT NULL, uploaded INTEGER NOT NULL, http TEXT NOT NULL, custom TEXT NOT NULL) WITHOUT ROWID;`);
  }

  #row(key: string): IndexRow | undefined {
    return this.#db.prepare('SELECT * FROM objects WHERE k = ?').get(key) as IndexRow | undefined;
  }

  #blobPath(id: string): string {
    return join(this.#root, 'blobs', id);
  }

  async put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<R2Object> {
    rejectUnsupported('put', options);
    const bytes = await putValueToBytes(value);
    const id = randomUUID();
    const tmp = `${this.#blobPath(id)}.tmp`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, this.#blobPath(id));
    const http = normalizeHttpMetadata(options?.httpMetadata);
    const row: IndexRow = {
      k: key,
      blob: id,
      size: bytes.byteLength,
      etag: md5Hex(bytes),
      uploaded: Date.now(),
      http: JSON.stringify(http),
      custom: JSON.stringify(options?.customMetadata ?? {}),
    };
    const previous = this.#row(key);
    this.#db
      .prepare('INSERT OR REPLACE INTO objects (k, blob, size, etag, uploaded, http, custom) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.k, row.blob, row.size, row.etag, row.uploaded, row.http, row.custom);
    if (previous) rmSync(this.#blobPath(previous.blob), { force: true });
    return new R2Object(toStored(row));
  }

  async head(key: string): Promise<R2Object | null> {
    const row = this.#row(key);
    return row ? new R2Object(toStored(row)) : null;
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    rejectUnsupported('get', options);
    const row = this.#row(key);
    if (!row) return null;
    const range = resolveRange(options?.range, row.size);
    if (!range) return new R2ObjectBody(toStored(row), new Uint8Array(readFileSync(this.#blobPath(row.blob))));
    const bytes = new Uint8Array(range.length);
    const fd = openSync(this.#blobPath(row.blob), 'r');
    try {
      readSync(fd, bytes, 0, range.length, range.offset);
    } finally {
      closeSync(fd);
    }
    return new R2ObjectBody(toStored(row), bytes, range);
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      const row = this.#row(key);
      if (!row) continue;
      this.#db.prepare('DELETE FROM objects WHERE k = ?').run(key);
      rmSync(this.#blobPath(row.blob), { force: true });
    }
  }

  async list(options: R2ListOptions = {}) {
    const limit = Math.min(options.limit ?? R2_MAX_LIST_LIMIT, R2_MAX_LIST_LIMIT);
    const prefix = options.prefix ?? '';
    const delimiter = options.delimiter;
    let after = options.cursor ? Buffer.from(options.cursor, 'base64url').toString('utf8') : (options.startAfter ?? '');
    const objects: R2Object[] = [];
    const delimitedPrefixes: string[] = [];
    let truncated = false;
    const stmt = this.#db.prepare(
      'SELECT * FROM objects WHERE substr(k, 1, length(?)) = ? AND k > ? ORDER BY k LIMIT 256',
    );
    scan: for (;;) {
      const rows = stmt.all(prefix, prefix, after) as IndexRow[];
      if (rows.length === 0) break;
      for (const row of rows) {
        if (objects.length + delimitedPrefixes.length >= limit) {
          truncated = true;
          break scan;
        }
        const rest = row.k.slice(prefix.length);
        const cut = delimiter ? rest.indexOf(delimiter) : -1;
        if (delimiter && cut >= 0) {
          const group = prefix + rest.slice(0, cut + delimiter.length);
          delimitedPrefixes.push(group);
          after = group + MAX_CHAR;
          continue scan; // re-query past the whole group
        }
        objects.push(new R2Object(toStored(row)));
        after = row.k;
      }
    }
    return {
      objects,
      delimitedPrefixes,
      truncated,
      ...(truncated ? { cursor: Buffer.from(after, 'utf8').toString('base64url') } : {}),
    };
  }

  createMultipartUpload(): never {
    throw new Error('openvoid: multipart uploads are not supported by the filesystem backend yet.');
  }

  async close(): Promise<void> {
    this.#db.close();
  }
}
