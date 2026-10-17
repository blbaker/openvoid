// KV binding on Redis (or any RESP-compatible server such as Valkey).
// Layout per namespace prefix P:
//   P v:<key>  hash { v: bytes, m: metadata JSON, e: expiry epoch seconds }, with PEXPIREAT
//   P idx      sorted set of every key (score 0), so list() can page in key order like KV
import { createClient, RESP_TYPES } from 'redis';
import {
  assertKey,
  clampLimit,
  cursor,
  decodeValue,
  expiryFrom,
  toBytes,
  type KVGetOptions,
  type KVListKey,
  type KVListOptions,
  type KVListResult,
  type KVNamespaceLike,
  type KVPutOptions,
  type KVPutValue,
} from './kv-common.ts';

type Reply = Buffer | null;

export type RedisKVOptions = {
  url: string;
  /** Key prefix so several apps or namespaces can share one Redis. Default "openvoid:kv:". */
  prefix?: string;
};

export class RedisKVNamespace implements KVNamespaceLike {
  readonly #prefix: string;
  readonly #client;
  #ready: Promise<unknown> | null = null;

  constructor(options: RedisKVOptions) {
    this.#prefix = options.prefix ?? 'openvoid:kv:';
    this.#client = createClient({ url: options.url }).withTypeMapping({ [RESP_TYPES.BLOB_STRING]: Buffer });
    this.#client.on('error', (error: unknown) => console.error('[openvoid] redis kv error:', error));
  }

  async #connected() {
    this.#ready ??= this.#client.connect();
    await this.#ready;
    return this.#client;
  }

  #valueKey(key: string): string {
    return `${this.#prefix}v:${key}`;
  }

  async #command(args: Array<string | Buffer>): Promise<unknown> {
    const client = await this.#connected();
    return client.sendCommand(args);
  }

  async #read(key: string): Promise<{ v: Buffer; m: string | null } | null> {
    assertKey(key);
    const [v, m] = (await this.#command(['HMGET', this.#valueKey(key), 'v', 'm'])) as Reply[];
    if (!v) return null;
    return { v, m: m ? m.toString('utf8') : null };
  }

  async get(key: string, options?: KVGetOptions): Promise<unknown> {
    const row = await this.#read(key);
    return decodeValue(row ? new Uint8Array(row.v) : null, options);
  }

  async getWithMetadata(key: string, options?: KVGetOptions) {
    const row = await this.#read(key);
    return {
      value: decodeValue(row ? new Uint8Array(row.v) : null, options),
      metadata: row?.m ? JSON.parse(row.m) : null,
      cacheStatus: null,
    };
  }

  async put(key: string, value: KVPutValue, options?: KVPutOptions): Promise<void> {
    assertKey(key);
    const bytes = Buffer.from(await toBytes(value));
    const expiry = expiryFrom(options);
    const valueKey = this.#valueKey(key);
    const client = await this.#connected();
    const tx = client.multi();
    tx.addCommand(['DEL', valueKey]);
    const fields: Array<string | Buffer> = ['HSET', valueKey, 'v', bytes];
    if (options?.metadata !== undefined) fields.push('m', JSON.stringify(options.metadata));
    if (expiry !== null) fields.push('e', String(expiry));
    tx.addCommand(fields);
    if (expiry !== null) tx.addCommand(['PEXPIREAT', valueKey, String(expiry * 1000)]);
    tx.addCommand(['ZADD', `${this.#prefix}idx`, '0', key]);
    await tx.exec();
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    const client = await this.#connected();
    await client.multi().addCommand(['DEL', this.#valueKey(key)]).addCommand(['ZREM', `${this.#prefix}idx`, key]).exec();
  }

  async list(options: KVListOptions = {}): Promise<KVListResult> {
    const limit = clampLimit(options.limit);
    const prefix = options.prefix ?? '';
    let after = cursor.decode(options.cursor);
    // 0xFF never appears in UTF-8, so "[prefix\xff" is an upper bound for every key with the prefix.
    const max = prefix ? Buffer.concat([Buffer.from(`[${prefix}`), Buffer.from([0xff])]) : '+';
    const keys: KVListKey[] = [];
    let exhausted = false;
    while (keys.length <= limit && !exhausted) {
      const min = after && after >= prefix ? `(${after}` : `[${prefix}`;
      const batch = ((await this.#command(['ZRANGE', `${this.#prefix}idx`, min, max, 'BYLEX', 'LIMIT', '0', String(limit + 1)])) as Buffer[]).map(
        (b) => b.toString('utf8'),
      );
      exhausted = batch.length < limit + 1;
      if (batch.length === 0) break;
      const client = await this.#connected();
      const tx = client.multi();
      for (const name of batch) tx.addCommand(['HMGET', this.#valueKey(name), 'v', 'm', 'e']);
      const rows = (await tx.exec()) as unknown as Reply[][];
      const stale: string[] = [];
      batch.forEach((name, i) => {
        const [v, m, e] = rows[i] ?? [];
        if (!v) {
          stale.push(name); // expired by Redis TTL; drop it from the index lazily
          return;
        }
        keys.push({
          name,
          ...(e ? { expiration: Number(e.toString()) } : {}),
          ...(m ? { metadata: JSON.parse(m.toString('utf8')) } : {}),
        });
      });
      if (stale.length > 0) await this.#command(['ZREM', `${this.#prefix}idx`, ...stale]);
      after = batch[batch.length - 1]!;
    }
    const page = keys.slice(0, limit);
    const complete = keys.length <= limit;
    return {
      keys: page,
      list_complete: complete,
      ...(complete ? {} : { cursor: cursor.encode(page[page.length - 1]!.name) }),
      cacheStatus: null,
    };
  }

  async close(): Promise<void> {
    if (this.#ready) await this.#client.close();
  }
}
