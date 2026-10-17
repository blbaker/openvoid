// Builds the binding object Void's runtime reads (env.DB, env.KV, env.STORAGE, plus plain vars)
// from ordinary environment variables. Bindings are created lazily on first use, so an app that
// never touches KV never opens a KV file or connection (important on read-only hosts like Lambda).
import { join, resolve } from 'node:path';
import { SqliteD1Database } from './bindings/d1-sqlite.ts';
import type { KVNamespaceLike } from './bindings/kv-common.ts';

export type Dialect = 'sqlite' | 'postgresql';

export type OpenVoidEnv = Record<string, unknown> & { readonly [CLOSE]: () => Promise<void> };

const CLOSE = Symbol.for('openvoid.closeEnv');

type Closable = { close?: () => unknown };

export function describeConfig(vars: NodeJS.ProcessEnv = process.env) {
  const dataDir = resolve(vars.OPENVOID_DATA_DIR ?? '.data');
  return {
    dataDir,
    sqlitePath: vars.OPENVOID_SQLITE ? resolve(vars.OPENVOID_SQLITE) : join(dataDir, 'db.sqlite'),
    kv: vars.OPENVOID_KV ?? `sqlite:${join(dataDir, 'kv.sqlite')}`,
    storage: vars.OPENVOID_STORAGE ?? `file:${join(dataDir, 'storage')}`,
  };
}

async function createKV(spec: string): Promise<KVNamespaceLike> {
  if (spec.startsWith('sqlite:')) {
    const { SqliteKVNamespace } = await import('./bindings/kv-sqlite.ts');
    return new SqliteKVNamespace({ path: spec.slice('sqlite:'.length) });
  }
  if (spec.startsWith('redis://') || spec.startsWith('rediss://')) {
    const { RedisKVNamespace } = await import('./bindings/kv-redis.ts');
    const url = new URL(spec);
    const prefix = url.searchParams.get('prefix') ?? undefined;
    url.searchParams.delete('prefix');
    return new RedisKVNamespace({ url: url.toString(), ...(prefix ? { prefix } : {}) });
  }
  if (spec.startsWith('dynamodb:')) {
    const { DynamoDBKVNamespace } = await import('./bindings/kv-dynamodb.ts');
    const [table, query] = spec.slice('dynamodb:'.length).split('?');
    const namespace = new URLSearchParams(query ?? '').get('namespace') ?? undefined;
    return new DynamoDBKVNamespace({ table: table!, ...(namespace ? { namespace } : {}) });
  }
  throw new Error(`openvoid: unsupported OPENVOID_KV "${spec}". Use sqlite:<path>, redis://..., or dynamodb:<table>.`);
}

async function createStorage(spec: string, vars: NodeJS.ProcessEnv) {
  if (spec.startsWith('file:')) {
    const { FileR2Bucket } = await import('./bindings/r2-fs.ts');
    return new FileR2Bucket({ root: spec.slice('file:'.length) });
  }
  if (spec.startsWith('s3://')) {
    const { S3R2Bucket } = await import('./bindings/r2-s3.ts');
    const url = new URL(spec);
    const prefix = url.pathname.replace(/^\//, '');
    return new S3R2Bucket({
      bucket: url.hostname,
      ...(prefix ? { prefix: prefix.endsWith('/') ? prefix : `${prefix}/` } : {}),
      forcePathStyle: vars.OPENVOID_S3_FORCE_PATH_STYLE === '1' || url.searchParams.get('path-style') === '1',
    });
  }
  throw new Error(`openvoid: unsupported OPENVOID_STORAGE "${spec}". Use file:<dir> or s3://<bucket>[/prefix].`);
}

/**
 * A lazy async binding: the first call to any method builds the backend, later calls reuse it.
 * Void's runtime only ever calls methods on these bindings, so a method-forwarding proxy is enough.
 */
function lazyBinding<T extends object>(build: () => Promise<T>, opened: Closable[]): T {
  let instance: Promise<T> | undefined;
  const get = () => {
    instance ??= build().then((value) => {
      opened.push(value as Closable);
      return value;
    });
    return instance;
  };
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === 'then') return undefined; // not a thenable
      return (...args: unknown[]) =>
        get().then((value) => {
          const fn = (value as Record<PropertyKey, unknown>)[prop];
          if (typeof fn !== 'function') throw new TypeError(`Binding has no method ${String(prop)}`);
          return (fn as (...a: unknown[]) => unknown).apply(value, args);
        });
    },
  });
}

export function createEnv(options: { dialect: Dialect; vars?: NodeJS.ProcessEnv }): OpenVoidEnv {
  const vars = options.vars ?? process.env;
  const config = describeConfig(vars);
  const opened: Closable[] = [];
  const env: Record<PropertyKey, unknown> = {};
  for (const [key, value] of Object.entries(vars)) if (value !== undefined) env[key] = value;

  if (options.dialect === 'sqlite') {
    let d1: SqliteD1Database | undefined;
    // D1 calls are synchronous underneath (node:sqlite), so this binding is built eagerly on first access.
    Object.defineProperty(env, 'DB', {
      enumerable: true,
      get() {
        if (!d1) {
          d1 = new SqliteD1Database({ path: config.sqlitePath });
          opened.push(d1);
        }
        return d1;
      },
    });
  }
  env.KV = lazyBinding(() => createKV(config.kv), opened);
  env.STORAGE = lazyBinding(() => createStorage(config.storage, vars), opened);
  env[CLOSE] = async () => {
    for (const binding of opened.splice(0)) await binding.close?.();
  };
  return env as OpenVoidEnv;
}

export async function closeEnv(env: OpenVoidEnv): Promise<void> {
  await env[CLOSE]();
}
