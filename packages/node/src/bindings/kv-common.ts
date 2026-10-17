// Shared pieces of the Cloudflare KV binding API that every OpenVoid KV backend implements.
// Void's `void/kv` client calls get/put/delete/list/getWithMetadata on the binding; apps can
// also use the binding directly, so value types follow the KV API (text, json, arrayBuffer, stream).

export type KVValueType = 'text' | 'json' | 'arrayBuffer' | 'stream';
export type KVGetOptions = KVValueType | { type?: KVValueType; cacheTtl?: number };

export type KVPutOptions = {
  /** Absolute expiry, seconds since the epoch. */
  expiration?: number;
  /** Relative expiry in seconds. */
  expirationTtl?: number;
  metadata?: unknown;
};

export type KVListOptions = { prefix?: string | null; limit?: number; cursor?: string | null };
export type KVListKey = { name: string; expiration?: number; metadata?: unknown };
export type KVListResult = { keys: KVListKey[]; list_complete: boolean; cursor?: string; cacheStatus: null };

export type KVPutValue = string | ArrayBuffer | ArrayBufferView | ReadableStream;

/** The binding surface. Each backend implements these five methods. */
export interface KVNamespaceLike {
  get(key: string, options?: KVGetOptions): Promise<unknown>;
  getWithMetadata(key: string, options?: KVGetOptions): Promise<{ value: unknown; metadata: unknown; cacheStatus: null }>;
  put(key: string, value: KVPutValue, options?: KVPutOptions): Promise<void>;
  delete(key: string): Promise<void>;
  list(options?: KVListOptions): Promise<KVListResult>;
  close?(): Promise<void>;
}

export const KV_MAX_LIST_LIMIT = 1000;

export async function toBytes(value: KVPutValue): Promise<Uint8Array> {
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  throw new TypeError('KV put() accepts a string, ArrayBuffer, ArrayBufferView or ReadableStream.');
}

export function decodeValue(bytes: Uint8Array | null, options?: KVGetOptions): unknown {
  if (bytes === null) return null;
  const type = typeof options === 'string' ? options : (options?.type ?? 'text');
  switch (type) {
    case 'text':
      return new TextDecoder().decode(bytes);
    case 'json':
      return JSON.parse(new TextDecoder().decode(bytes));
    case 'arrayBuffer':
      return bytes.slice().buffer;
    case 'stream':
      return new Blob([bytes.slice()]).stream();
    default:
      throw new TypeError(`Unknown KV value type '${String(type)}'.`);
  }
}

/** Absolute expiry in epoch seconds, or null for "never". */
export function expiryFrom(options: KVPutOptions | undefined, nowMs = Date.now()): number | null {
  if (options?.expiration !== undefined) return Math.floor(options.expiration);
  if (options?.expirationTtl !== undefined) return Math.floor(nowMs / 1000) + Math.floor(options.expirationTtl);
  return null;
}

export function isExpired(expiry: number | null | undefined, nowMs = Date.now()): boolean {
  return expiry !== null && expiry !== undefined && expiry <= nowMs / 1000;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return KV_MAX_LIST_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('KV list() limit must be a positive integer.');
  return Math.min(limit, KV_MAX_LIST_LIMIT);
}

/** Cursors are opaque to callers; ours encode the last key returned. */
export const cursor = {
  encode: (lastKey: string): string => Buffer.from(lastKey, 'utf8').toString('base64url'),
  decode: (value: string | null | undefined): string => (value ? Buffer.from(value, 'base64url').toString('utf8') : ''),
};

export function assertKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('KV key must be a non-empty string.');
  if (Buffer.byteLength(key) > 512) throw new RangeError('KV key exceeds 512 bytes.');
}
