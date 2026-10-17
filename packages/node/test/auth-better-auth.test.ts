// better-auth mode: email+password, Google/GitHub social redirects, and the groups mapping,
// exercised the same way an app would (through createAuth(...).wrap), on SQLite always and on
// PostgreSQL when OPENVOID_TEST_DATABASE_URL is set.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteKVNamespace } from '../src/bindings/kv-sqlite.ts';
import { createAuth, type Auth } from '../src/auth/handler.ts';
import { getUser, requireAuth, AuthHttpError } from '../src/auth/context.ts';
import { createMode } from '../src/auth/modes/better-auth.ts';
import { SessionStore } from '../src/auth/sessions.ts';
import type { AuthUser, Vars } from '../src/auth/types.ts';

const SECRET = 'unit-test-secret-at-least-32-characters-long';
const PUBLIC_URL = 'http://app.test';

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, init);
}

function jsonBody(body: unknown, init: RequestInit = {}): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...init };
}

/** Collects Set-Cookie name=value pairs across a sequence of requests into one Cookie header. */
class CookieJar {
  #cookies = new Map<string, string>();

  absorb(res: Response): void {
    for (const setCookie of res.headers.getSetCookie()) {
      const [pair] = setCookie.split(';', 1);
      const eq = pair!.indexOf('=');
      if (eq < 0) continue;
      const name = pair!.slice(0, eq);
      const value = pair!.slice(eq + 1);
      if (value === '' ) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.#cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** The full sign-up/sign-in/session/sign-out flow, run against whatever database `auth` uses. */
async function exerciseEmailPasswordFlow(auth: Auth): Promise<void> {
  const jar = new CookieJar();
  const withCookie = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), cookie: jar.header() },
  });

  // Sign up: creates the user, logs them in (autoSignIn default), sets the session cookie.
  const signUp = await auth.wrap(
    req('/auth/sign-up/email', jsonBody({ email: 'doc@example.com', password: 'sekrit123', name: 'Doc' })),
    async () => new Response('next must not run for an auth path', { status: 500 }),
  );
  assert.equal(signUp.status, 200, await signUp.clone().text());
  jar.absorb(signUp);
  assert.notEqual(jar.header(), '', 'sign-up must set a session cookie');

  // /auth/session (answered by the core itself, before mode.handle) shows the signed-in user.
  const session = await auth.wrap(req('/auth/session', withCookie()), async () => new Response('no'));
  const sessionBody = (await session.json()) as { user: AuthUser | null };
  assert.equal(sessionBody.user?.email, 'doc@example.com');
  assert.equal(sessionBody.user?.provider, 'local');
  assert.equal(sessionBody.user?.id, `local:${sessionBody.user?.subject}`);
  assert.deepEqual(sessionBody.user?.groups, [], 'email+password users get no groups');

  // requireAuth() works for any other path once the session resolves.
  const seen: Array<AuthUser | null> = [];
  const apiRes = await auth.wrap(req('/api/me', withCookie()), async () => {
    seen.push(getUser());
    return Response.json({ id: requireAuth().id });
  });
  assert.equal(apiRes.status, 200);
  assert.equal(seen[0]?.email, 'doc@example.com');

  // Wrong password is rejected and does not start a session.
  const badLogin = await auth.wrap(
    req('/auth/sign-in/email', jsonBody({ email: 'doc@example.com', password: 'not-it' })),
    async () => new Response('no'),
  );
  assert.notEqual(badLogin.status, 200);

  // Correct password signs back in.
  const signIn = await auth.wrap(
    req('/auth/sign-in/email', jsonBody({ email: 'doc@example.com', password: 'sekrit123' })),
    async () => new Response('no'),
  );
  assert.equal(signIn.status, 200, await signIn.clone().text());

  // Sign out clears the session; the same cookie no longer authenticates.
  const signOut = await auth.wrap(req('/auth/logout', withCookie({ method: 'POST' })), async () => new Response('no'));
  assert.equal(signOut.status, 200, await signOut.clone().text());
  jar.absorb(signOut);

  const afterSignOut = await auth.wrap(req('/api/me', withCookie()), async () => {
    try {
      requireAuth();
      return new Response('unreachable');
    } catch (error) {
      assert.ok(error instanceof AuthHttpError);
      return error.getResponse();
    }
  });
  assert.equal(afterSignOut.status, 401);
}

describe('better-auth mode (SQLite)', () => {
  it('rejects a misconfigured setup with a clear error', async () => {
    const kv = () => new SqliteKVNamespace({ path: ':memory:' });
    await assert.rejects(
      () => createAuth({ env: { KV: kv() }, vars: { OPENVOID_AUTH: 'better-auth', BETTER_AUTH_SECRET: SECRET }, dialect: 'sqlite' }),
      /OPENVOID_PUBLIC_URL/,
    );
    await assert.rejects(
      () => createAuth({ env: { KV: kv() }, vars: { OPENVOID_AUTH: 'better-auth', OPENVOID_PUBLIC_URL: PUBLIC_URL }, dialect: 'sqlite' }),
      /BETTER_AUTH_SECRET/,
    );
    await assert.rejects(
      () =>
        createAuth({
          env: { KV: kv() },
          vars: { OPENVOID_AUTH: 'better-auth', OPENVOID_PUBLIC_URL: PUBLIC_URL, BETTER_AUTH_SECRET: SECRET, OPENVOID_AUTH_GOOGLE_CLIENT_ID: 'only-id' },
          dialect: 'sqlite',
        }),
      /OPENVOID_AUTH_GOOGLE_CLIENT_ID and OPENVOID_AUTH_GOOGLE_CLIENT_SECRET/,
    );
  });

  it('migrate() is idempotent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openvoid-betterauth-'));
    try {
      const { SqliteD1Database } = await import('../src/bindings/d1-sqlite.ts');
      const db = new SqliteD1Database({ path: join(dir, 'db.sqlite') });
      const vars: Vars = { OPENVOID_AUTH: 'better-auth', OPENVOID_PUBLIC_URL: PUBLIC_URL, BETTER_AUTH_SECRET: SECRET };
      const auth = await createAuth({ env: { KV: new SqliteKVNamespace({ path: ':memory:' }), DB: db }, vars, dialect: 'sqlite' });
      await auth.migrate();
      await auth.migrate(); // second run must not fail or duplicate anything
      await auth.close();
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('runs the full email+password flow over HTTP', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openvoid-betterauth-'));
    try {
      const { SqliteD1Database } = await import('../src/bindings/d1-sqlite.ts');
      const db = new SqliteD1Database({ path: join(dir, 'db.sqlite') });
      const vars: Vars = { OPENVOID_AUTH: 'better-auth', OPENVOID_PUBLIC_URL: PUBLIC_URL, BETTER_AUTH_SECRET: SECRET };
      const auth = await createAuth({ env: { KV: new SqliteKVNamespace({ path: ':memory:' }), DB: db }, vars, dialect: 'sqlite' });
      await auth.migrate();
      await exerciseEmailPasswordFlow(auth);
      await auth.close();
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('OPENVOID_AUTH_EMAIL_PASSWORD=0 turns off email+password sign-up', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openvoid-betterauth-'));
    try {
      const { SqliteD1Database } = await import('../src/bindings/d1-sqlite.ts');
      const db = new SqliteD1Database({ path: join(dir, 'db.sqlite') });
      const vars: Vars = {
        OPENVOID_AUTH: 'better-auth',
        OPENVOID_PUBLIC_URL: PUBLIC_URL,
        BETTER_AUTH_SECRET: SECRET,
        OPENVOID_AUTH_EMAIL_PASSWORD: '0',
      };
      const auth = await createAuth({ env: { KV: new SqliteKVNamespace({ path: ':memory:' }), DB: db }, vars, dialect: 'sqlite' });
      await auth.migrate();
      const res = await auth.wrap(
        req('/auth/sign-up/email', jsonBody({ email: 'doc@example.com', password: 'sekrit123', name: 'Doc' })),
        async () => new Response('no'),
      );
      assert.notEqual(res.status, 200);
      await auth.close();
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('GET /auth/login/google redirects to Google with no network call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openvoid-betterauth-'));
    try {
      const { SqliteD1Database } = await import('../src/bindings/d1-sqlite.ts');
      const db = new SqliteD1Database({ path: join(dir, 'db.sqlite') });
      const vars: Vars = {
        OPENVOID_AUTH: 'better-auth',
        OPENVOID_PUBLIC_URL: PUBLIC_URL,
        BETTER_AUTH_SECRET: SECRET,
        OPENVOID_AUTH_GOOGLE_CLIENT_ID: 'test-client-id',
        OPENVOID_AUTH_GOOGLE_CLIENT_SECRET: 'test-client-secret',
      };
      const auth = await createAuth({ env: { KV: new SqliteKVNamespace({ path: ':memory:' }), DB: db }, vars, dialect: 'sqlite' });
      await auth.migrate();
      const res = await auth.wrap(req('/auth/login/google?returnTo=%2Fnotes'), async () => new Response('no'));
      assert.equal(res.status, 302);
      const location = res.headers.get('location') ?? '';
      assert.match(location, /^https:\/\/accounts\.google\.com\//);
      assert.match(location, /client_id=test-client-id/);
      await auth.close();
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('calls ctx.hooks.onSignIn once per new session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openvoid-betterauth-'));
    try {
      const { SqliteD1Database } = await import('../src/bindings/d1-sqlite.ts');
      const db = new SqliteD1Database({ path: join(dir, 'db.sqlite') });
      const vars: Vars = { OPENVOID_AUTH: 'better-auth', OPENVOID_PUBLIC_URL: PUBLIC_URL, BETTER_AUTH_SECRET: SECRET };
      const signedIn: AuthUser[] = [];
      const mode = await createMode({
        vars,
        env: { DB: db },
        sessions: new SessionStore(new SqliteKVNamespace({ path: ':memory:' }), vars),
        basePath: '/auth',
        dialect: 'sqlite',
        hooks: { onSignIn: async (user) => void signedIn.push(user) },
      });
      await mode.migrate?.();
      const signUp = await mode.handle(req('/auth/sign-up/email', jsonBody({ email: 'ping@example.com', password: 'sekrit123', name: 'Ping' })));
      assert.equal(signUp?.status, 200);
      assert.equal(signedIn.length, 1);
      assert.equal(signedIn[0]?.email, 'ping@example.com');
      assert.equal(signedIn[0]?.provider, 'local');
      await mode.close?.();
      db.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('better-auth mode (PostgreSQL)', { skip: process.env.OPENVOID_TEST_DATABASE_URL ? undefined : 'OPENVOID_TEST_DATABASE_URL not set' }, () => {
  it('runs the full email+password flow over HTTP', async () => {
    const url = process.env.OPENVOID_TEST_DATABASE_URL!;
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const schema = `openvoid_betterauth_test_${process.pid}`;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    try {
      const scoped = new URL(url);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      const vars: Vars = {
        OPENVOID_AUTH: 'better-auth',
        OPENVOID_PUBLIC_URL: PUBLIC_URL,
        BETTER_AUTH_SECRET: SECRET,
        DATABASE_URL: scoped.toString(),
      };
      const auth = await createAuth({ env: { KV: new SqliteKVNamespace({ path: ':memory:' }) }, vars, dialect: 'postgresql' });
      await auth.migrate();
      await exerciseEmailPasswordFlow(auth);
      await auth.close();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it('migrate() is idempotent', async () => {
    const url = process.env.OPENVOID_TEST_DATABASE_URL!;
    const { default: pg } = await import('pg');
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    const schema = `openvoid_betterauth_migrate_${process.pid}`;
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
    try {
      const scoped = new URL(url);
      scoped.searchParams.set('options', `-c search_path=${schema}`);
      const vars: Vars = {
        OPENVOID_AUTH: 'better-auth',
        OPENVOID_PUBLIC_URL: PUBLIC_URL,
        BETTER_AUTH_SECRET: SECRET,
        DATABASE_URL: scoped.toString(),
      };
      const auth = await createAuth({ env: { KV: new SqliteKVNamespace({ path: ':memory:' }) }, vars, dialect: 'postgresql' });
      await auth.migrate();
      await auth.migrate();
      await auth.close();
    } finally {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });
});
