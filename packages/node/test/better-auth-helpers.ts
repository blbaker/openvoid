// Shared setup for the better-auth mode tests: a real SQLite file in a temp dir (or a throwaway
// PostgreSQL schema), a cookie jar, and request builders, so each test reads as its one scenario.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteKVNamespace } from '../src/bindings/kv-sqlite.ts';
import { SqliteD1Database } from '../src/bindings/d1-sqlite.ts';
import { createAuth, type Auth } from '../src/auth/handler.ts';
import type { AuthUser, Vars } from '../src/auth/types.ts';

export const SECRET = 'unit-test-secret-at-least-32-characters-long';
export const PUBLIC_URL = 'http://app.test';

export function betterAuthVars(extra: Vars = {}, publicUrl = PUBLIC_URL): Vars {
  return { OPENVOID_AUTH: 'better-auth', OPENVOID_PUBLIC_URL: publicUrl, BETTER_AUTH_SECRET: SECRET, ...extra };
}

/** Carries Set-Cookie values from one response to the next request, like a browser. */
export class CookieJar {
  #cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const pair = line.split(';', 1)[0]!;
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const value = pair.slice(eq + 1);
      if (value === '') this.#cookies.delete(pair.slice(0, eq));
      else this.#cookies.set(pair.slice(0, eq), value);
    }
  }

  header(): string {
    return [...this.#cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export function req(path: string, jar?: CookieJar, init: RequestInit = {}, origin = PUBLIC_URL): Request {
  const headers = { ...(init.headers as Record<string, string> | undefined), ...(jar ? { cookie: jar.header() } : {}) };
  return new Request(`${origin}${path}`, { ...init, headers });
}

/** A JSON POST. Browsers send Origin on POST, and Better Auth's CSRF check needs it with cookies. */
export function postJson(path: string, body: unknown, jar?: CookieJar, origin = PUBLIC_URL): Request {
  const init = { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) };
  return req(path, jar, init, origin);
}

export const noNext = async () => new Response('next must not run for an auth path', { status: 500 });

export async function sessionUser(auth: Auth, jar: CookieJar): Promise<AuthUser | null> {
  const res = await auth.wrap(req('/auth/session', jar), noNext);
  return ((await res.json()) as { user: AuthUser | null }).user;
}

/** Runs `fn` against a migrated better-auth setup on a fresh SQLite file, then cleans up. */
export async function withSqliteAuth(vars: Vars, fn: (auth: Auth) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'openvoid-betterauth-'));
  const db = new SqliteD1Database({ path: join(dir, 'db.sqlite') });
  try {
    const auth = await createAuth({ env: { KV: new SqliteKVNamespace({ path: ':memory:' }), DB: db }, vars, dialect: 'sqlite' });
    try {
      await auth.migrate();
      await fn(auth);
    } finally {
      await auth.close();
    }
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Same, on PostgreSQL in a schema of its own (OPENVOID_TEST_DATABASE_URL must be set). */
export async function withPgAuth(name: string, vars: Vars, fn: (auth: Auth) => Promise<void>): Promise<void> {
  const url = process.env.OPENVOID_TEST_DATABASE_URL;
  assert.ok(url, 'OPENVOID_TEST_DATABASE_URL must be set');
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  const schema = `openvoid_betterauth_${name}_${process.pid}`;
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  try {
    const scoped = new URL(url);
    scoped.searchParams.set('options', `-c search_path=${schema}`);
    const kv = new SqliteKVNamespace({ path: ':memory:' });
    const auth = await createAuth({ env: { KV: kv }, vars: { ...vars, DATABASE_URL: scoped.toString() }, dialect: 'postgresql' });
    try {
      await auth.migrate();
      await fn(auth);
    } finally {
      await auth.close();
    }
  } finally {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}
