// R2-compatible object storage on Amazon S3 or any S3-compatible service (MinIO, R2's S3 API,
// Backblaze B2, Garage...). Credentials and region come from the standard AWS SDK chain, so the
// same code works with env keys locally and with an IAM execution role on AWS.
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
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
  type R2HTTPMetadata,
  type R2ListOptions,
  type R2PutOptions,
  type R2PutValue,
  type StoredObject,
} from './r2-common.ts';

export type S3R2Options = {
  bucket: string;
  /** Optional key prefix inside the bucket, e.g. "my-app/". */
  prefix?: string;
  /** Custom endpoint for S3-compatible services. The SDK also reads AWS_ENDPOINT_URL_S3. */
  endpoint?: string;
  region?: string;
  /** Path-style URLs (bucket in the path). Most self-hosted S3 servers need this. */
  forcePathStyle?: boolean;
  client?: S3Client;
};

type S3Head = {
  ContentLength?: number;
  ETag?: string;
  LastModified?: Date;
  VersionId?: string;
  ContentType?: string;
  ContentLanguage?: string;
  ContentDisposition?: string;
  ContentEncoding?: string;
  CacheControl?: string;
  Expires?: Date;
  Metadata?: Record<string, string>;
};

function isNotFound(error: unknown): boolean {
  if (!(error instanceof S3ServiceException)) return false;
  return error.name === 'NoSuchKey' || error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404;
}

export class S3R2Bucket {
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #client: S3Client;

  constructor(options: S3R2Options) {
    this.#bucket = options.bucket;
    this.#prefix = options.prefix ?? '';
    this.#client =
      options.client ??
      new S3Client({
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.region ? { region: options.region } : {}),
        ...(options.forcePathStyle ? { forcePathStyle: true } : {}),
      });
  }

  #stored(key: string, head: S3Head, size?: number): StoredObject {
    const http: R2HTTPMetadata = {};
    if (head.ContentType) http.contentType = head.ContentType;
    if (head.ContentLanguage) http.contentLanguage = head.ContentLanguage;
    if (head.ContentDisposition) http.contentDisposition = head.ContentDisposition;
    if (head.ContentEncoding) http.contentEncoding = head.ContentEncoding;
    if (head.CacheControl) http.cacheControl = head.CacheControl;
    if (head.Expires) http.cacheExpiry = head.Expires;
    return {
      key,
      size: size ?? head.ContentLength ?? 0,
      etag: (head.ETag ?? '').replaceAll('"', ''),
      version: head.VersionId ?? (head.ETag ?? '').replaceAll('"', ''),
      uploaded: head.LastModified ?? new Date(0),
      httpMetadata: http,
      customMetadata: head.Metadata ?? {},
    };
  }

  async put(key: string, value: R2PutValue, options?: R2PutOptions): Promise<R2Object> {
    rejectUnsupported('put', options);
    const bytes = await putValueToBytes(value);
    const http = normalizeHttpMetadata(options?.httpMetadata);
    const out = await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: this.#prefix + key,
        Body: bytes,
        ContentLength: bytes.byteLength,
        ContentType: http.contentType,
        ContentLanguage: http.contentLanguage,
        ContentDisposition: http.contentDisposition,
        ContentEncoding: http.contentEncoding,
        CacheControl: http.cacheControl,
        Expires: http.cacheExpiry,
        Metadata: options?.customMetadata,
      }),
    );
    return new R2Object({
      key,
      size: bytes.byteLength,
      etag: (out.ETag ?? md5Hex(bytes)).replaceAll('"', ''),
      version: out.VersionId ?? (out.ETag ?? '').replaceAll('"', ''),
      uploaded: new Date(),
      httpMetadata: http,
      customMetadata: options?.customMetadata ?? {},
    });
  }

  async head(key: string): Promise<R2Object | null> {
    try {
      const out = await this.#client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: this.#prefix + key }));
      return new R2Object(this.#stored(key, out));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null> {
    rejectUnsupported('get', options);
    let range: { offset: number; length: number } | undefined;
    if (options?.range) {
      const head = await this.head(key);
      if (!head) return null;
      range = resolveRange(options.range, head.size);
    }
    try {
      const out = await this.#client.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: this.#prefix + key,
          ...(range && range.length > 0 ? { Range: `bytes=${range.offset}-${range.offset + range.length - 1}` } : {}),
        }),
      );
      const bytes = range?.length === 0 ? new Uint8Array() : await out.Body!.transformToByteArray();
      // On a ranged read ContentLength is the slice; the object size is in ContentRange.
      const total = out.ContentRange ? Number(out.ContentRange.split('/')[1]) : undefined;
      return new R2ObjectBody(this.#stored(key, out, total), bytes, range);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async delete(keys: string | string[]): Promise<void> {
    const list = Array.isArray(keys) ? keys : [keys];
    for (let i = 0; i < list.length; i += 1000) {
      const chunk = list.slice(i, i + 1000);
      if (chunk.length === 0) continue;
      const out = await this.#client.send(
        new DeleteObjectsCommand({
          Bucket: this.#bucket,
          Delete: { Objects: chunk.map((k) => ({ Key: this.#prefix + k })), Quiet: true },
        }),
      );
      if (out.Errors && out.Errors.length > 0) {
        throw new Error(`openvoid: S3 delete failed for ${out.Errors.map((e) => `${e.Key}: ${e.Code}`).join(', ')}`);
      }
    }
  }

  async list(options: R2ListOptions = {}) {
    const limit = Math.min(options.limit ?? R2_MAX_LIST_LIMIT, R2_MAX_LIST_LIMIT);
    const out = await this.#client.send(
      new ListObjectsV2Command({
        Bucket: this.#bucket,
        Prefix: this.#prefix + (options.prefix ?? ''),
        MaxKeys: limit,
        ...(options.delimiter ? { Delimiter: options.delimiter } : {}),
        ...(options.cursor ? { ContinuationToken: options.cursor } : {}),
        ...(options.startAfter && !options.cursor ? { StartAfter: this.#prefix + options.startAfter } : {}),
      }),
    );
    const strip = (k: string) => k.slice(this.#prefix.length);
    const wantMeta = (options.include ?? []).length > 0;
    const objects = await Promise.all(
      (out.Contents ?? []).map(async (o) => {
        const key = strip(o.Key!);
        // ListObjectsV2 carries no metadata; R2's `include` needs a HEAD per object.
        if (wantMeta) return (await this.head(key)) ?? new R2Object(this.#stored(key, { ETag: o.ETag, LastModified: o.LastModified }, o.Size));
        return new R2Object(this.#stored(key, { ETag: o.ETag, LastModified: o.LastModified }, o.Size));
      }),
    );
    return {
      objects,
      delimitedPrefixes: (out.CommonPrefixes ?? []).map((p) => strip(p.Prefix!)),
      truncated: out.IsTruncated === true,
      ...(out.IsTruncated && out.NextContinuationToken ? { cursor: out.NextContinuationToken } : {}),
    };
  }

  createMultipartUpload(): never {
    throw new Error('openvoid: multipart uploads are not supported by the S3 backend yet.');
  }

  async close(): Promise<void> {
    this.#client.destroy();
  }
}
