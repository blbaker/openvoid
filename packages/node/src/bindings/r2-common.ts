// Shared pieces of the Cloudflare R2 binding API (what `void/storage` exposes) for OpenVoid's
// object storage backends. Covers put/get/head/delete/list with http and custom metadata and
// ranged reads. Not covered: multipart uploads, conditional requests (onlyIf), checksums other
// than MD5. Unsupported options throw instead of being silently ignored.
import { createHash } from 'node:crypto';

export type R2HTTPMetadata = {
  contentType?: string;
  contentLanguage?: string;
  contentDisposition?: string;
  contentEncoding?: string;
  cacheControl?: string;
  cacheExpiry?: Date;
};

export type R2Range = { offset?: number; length?: number } | { suffix: number };
export type R2PutValue = string | ArrayBuffer | ArrayBufferView | Blob | ReadableStream | null;
export type R2PutOptions = {
  httpMetadata?: R2HTTPMetadata | Headers;
  customMetadata?: Record<string, string>;
  onlyIf?: unknown;
  md5?: unknown;
};
export type R2GetOptions = { range?: R2Range | Headers; onlyIf?: unknown };
export type R2ListOptions = {
  prefix?: string;
  cursor?: string;
  delimiter?: string;
  limit?: number;
  startAfter?: string;
  include?: Array<'httpMetadata' | 'customMetadata'>;
};

export type StoredObject = {
  key: string;
  size: number;
  etag: string;
  version: string;
  uploaded: Date;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
};

export class R2Object {
  readonly key: string;
  readonly version: string;
  readonly size: number;
  readonly etag: string;
  readonly httpEtag: string;
  readonly uploaded: Date;
  readonly httpMetadata: R2HTTPMetadata;
  readonly customMetadata: Record<string, string>;
  readonly range?: { offset: number; length: number };
  readonly checksums: { md5?: ArrayBuffer };
  readonly storageClass = 'Standard';

  constructor(meta: StoredObject, range?: { offset: number; length: number }) {
    this.key = meta.key;
    this.version = meta.version;
    this.size = meta.size;
    this.etag = meta.etag;
    this.httpEtag = `"${meta.etag}"`;
    this.uploaded = meta.uploaded;
    this.httpMetadata = meta.httpMetadata;
    this.customMetadata = meta.customMetadata;
    if (range) this.range = range;
    this.checksums = /^[0-9a-f]{32}$/.test(meta.etag) ? { md5: Buffer.from(meta.etag, 'hex').buffer } : {};
  }

  writeHttpMetadata(headers: Headers): void {
    const m = this.httpMetadata;
    if (m.contentType) headers.set('content-type', m.contentType);
    if (m.contentLanguage) headers.set('content-language', m.contentLanguage);
    if (m.contentDisposition) headers.set('content-disposition', m.contentDisposition);
    if (m.contentEncoding) headers.set('content-encoding', m.contentEncoding);
    if (m.cacheControl) headers.set('cache-control', m.cacheControl);
    if (m.cacheExpiry) headers.set('expires', m.cacheExpiry.toUTCString());
  }
}

export class R2ObjectBody extends R2Object {
  readonly #bytes: Uint8Array;
  #used = false;

  constructor(meta: StoredObject, bytes: Uint8Array, range?: { offset: number; length: number }) {
    super(meta, range);
    this.#bytes = bytes;
  }

  get bodyUsed(): boolean {
    return this.#used;
  }

  #take(): Uint8Array {
    if (this.#used) throw new TypeError('Body has already been used.');
    this.#used = true;
    return this.#bytes;
  }

  get body(): ReadableStream<Uint8Array> {
    return new Blob([this.#take().slice()]).stream();
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.#take().slice().buffer;
  }

  async bytes(): Promise<Uint8Array> {
    return this.#take().slice();
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.#take());
  }

  async json<T = unknown>(): Promise<T> {
    return JSON.parse(await this.text()) as T;
  }

  async blob(): Promise<Blob> {
    return new Blob([this.#take().slice()], this.httpMetadata.contentType ? { type: this.httpMetadata.contentType } : {});
  }
}

export async function putValueToBytes(value: R2PutValue): Promise<Uint8Array> {
  if (value === null) return new Uint8Array();
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  throw new TypeError('R2 put() accepts a string, ArrayBuffer, ArrayBufferView, Blob, ReadableStream or null.');
}

export function normalizeHttpMetadata(input: R2HTTPMetadata | Headers | undefined): R2HTTPMetadata {
  if (!input) return {};
  if (input instanceof Headers) {
    const out: R2HTTPMetadata = {};
    const get = (name: string) => input.get(name) ?? undefined;
    if (get('content-type')) out.contentType = get('content-type')!;
    if (get('content-language')) out.contentLanguage = get('content-language')!;
    if (get('content-disposition')) out.contentDisposition = get('content-disposition')!;
    if (get('content-encoding')) out.contentEncoding = get('content-encoding')!;
    if (get('cache-control')) out.cacheControl = get('cache-control')!;
    if (get('expires')) out.cacheExpiry = new Date(get('expires')!);
    return out;
  }
  return { ...input };
}

export function md5Hex(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

export function rejectUnsupported(op: string, options: { onlyIf?: unknown } | undefined): void {
  if (options?.onlyIf !== undefined) {
    throw new Error(`openvoid: R2 ${op}() with onlyIf is not supported yet. See https://github.com/blbaker/openvoid#compatibility`);
  }
}

/** Resolve an R2 range against an object size. Returns undefined for "whole object". */
export function resolveRange(range: R2Range | Headers | undefined, size: number): { offset: number; length: number } | undefined {
  if (!range) return undefined;
  if (range instanceof Headers) {
    const header = range.get('range');
    if (!header) return undefined;
    const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
    if (!m) throw new RangeError(`Unsupported Range header: ${header}`);
    if (m[1] === '') return resolveRange({ suffix: Number(m[2]) }, size);
    const start = Number(m[1]);
    const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    return { offset: start, length: Math.max(0, end - start + 1) };
  }
  if ('suffix' in range) {
    const length = Math.min(range.suffix, size);
    return { offset: size - length, length };
  }
  const offset = range.offset ?? 0;
  const length = range.length ?? Math.max(0, size - offset);
  return { offset, length: Math.min(length, Math.max(0, size - offset)) };
}

export const R2_MAX_LIST_LIMIT = 1000;
