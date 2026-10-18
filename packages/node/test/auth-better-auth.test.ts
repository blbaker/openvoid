// better-auth mode with email and password and the Google redirect, driven through
// createAuth(...).wrap the way an app runs it: on SQLite always, on PostgreSQL when
// OPENVOID_TEST_DATABASE_URL is set.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteKVNamespace } from '../src/bindings/kv-sqlite.ts';
import { SqliteD1Database } from '../src/bindings/d1-sqlite.ts';
import { createAuth, type Auth } from '../src/auth/handler.ts';
import { getUser, requireAuth, AuthHttpError } from '../src/auth/context.ts';
import { createMode } from '../src/auth/modes/better-auth.ts';
import { SessionStore } from '../src/auth/sessions.ts';
import type { AuthUser } from '../src/auth/types.ts';
import { betterAuthVars, CookieJar, noNext, postJson, req, sessionUser, withPgAuth, withSqliteAuth } from './better-auth-helpers.ts';

const DOC = { email: 'doc@example.com', password: 'sekrit123', name: 'Doc' };

async function exerciseEmailPasswordFlow(auth: Auth): Promise<void> {
  const jar = new CookieJar();
  // autoSignIn is on by default, so sign-up also starts the session.
  const signUp = await auth.wrap(postJson('/auth/sign-up/email', DOC), noNext);
  assert.equal(signUp.status, 200, await signUp.clone().text());
  jar.absorb(signUp);
  assert.notEqual(jar.header(), '', 'sign-up must set a session cookie');

  const user = await sessionUser(auth, jar);
  assert.equal(user?.email, DOC.email);
  assert.equal(user?.provider, 'local');
  assert.equal(user?.id, `local:${user?.subject}`);
  assert.deepEqual(user?.groups, [], 'email+password users get no groups');

  const seen: Array<AuthUser | null> = [];
  const me = await auth.wrap(req('/api/me', jar), async () => {
    seen.push(getUser());
    return Response.json({ id: requireAuth().id });
  });
  assert.equal(me.status, 200);
  assert.equal(seen[0]?.email, DOC.email);

  const wrongPassword = await auth.wrap(postJson('/auth/sign-in/email', { email: DOC.email, password: 'not-it' }), noNext);
  assert.notEqual(wrongPassword.status, 200);
  const signIn = await auth.wrap(postJson('/auth/sign-in/email', { email: DOC.email, password: DOC.password }), noNext);
  assert.equal(signIn.status, 200, await signIn.clone().text());

  const signOut = await auth.wrap(req('/auth/logout', jar, { method: 'POST' }), noNext);
  assert.equal(signOut.status, 200, await signOut.clone().text());
  const afterSignOut = await auth.wrap(req('/api/me', jar), async () => {
    try {
      requireAuth();
      return new Response('unreachable');
    } catch (error) {
      assert.ok(error instanceof AuthHttpError);
      return error.getResponse();
    }
  });
  assert.equal(afterSignOut.status, 401, 'the old cookie must not authenticate after sign-out');
}

describe('better-auth mode (SQLite)', () => {
  it('rejects a misconfigured setup with a clear error', async () => {
    const start = (vars: Record<string, string>) =>
      createAuth({ env: { KV: new SqliteKVNamespace({ path: ':memory:' }) }, vars: { OPENVOID_AUTH: 'better-auth', ...vars }, dialect: 'sqlite' });
    await assert.rejects(() => start({ BETTER_AUTH_SECRET: 'x'.repeat(32) }), /OPENVOID_PUBLIC_URL/);
    await assert.rejects(() => start({ OPENVOID_PUBLIC_URL: 'http://app.test' }), /BETTER_AUTH_SECRET/);
    await assert.rejects(
      () => createAuth({ env: { KV: new SqliteKVNamespace({ path: ':memory:' }) }, vars: betterAuthVars({ OPENVOID_AUTH_GOOGLE_CLIENT_ID: 'only-id' }), dialect: 'sqlite' }),
      /OPENVOID_AUTH_GOOGLE_CLIENT_ID and OPENVOID_AUTH_GOOGLE_CLIENT_SECRET/,
    );
  });

  it('migrate() is idempotent', async () => {
    await withSqliteAuth(betterAuthVars(), (auth) => auth.migrate());
  });

  it('runs the full email+password flow over HTTP', async () => {
    await withSqliteAuth(betterAuthVars(), exerciseEmailPasswordFlow);
  });

  it('OPENVOID_AUTH_EMAIL_PASSWORD=0 turns off email+password sign-up', async () => {
    await withSqliteAuth(betterAuthVars({ OPENVOID_AUTH_EMAIL_PASSWORD: '0' }), async (auth) => {
      assert.notEqual((await auth.wrap(postJson('/auth/sign-up/email', DOC), noNext)).status, 200);
    });
  });

  it('GET /auth/login/google redirects to Google and sets the state cookie', async () => {
    const vars = betterAuthVars({ OPENVOID_AUTH_GOOGLE_CLIENT_ID: 'test-client-id', OPENVOID_AUTH_GOOGLE_CLIENT_SECRET: 'test-client-secret' });
    await withSqliteAuth(vars, async (auth) => {
      const res = await auth.wrap(req('/auth/login/google?returnTo=%2Fnotes'), noNext);
      assert.equal(res.status, 302);
      const location = res.headers.get('location') ?? '';
      assert.match(location, /^https:\/\/accounts\.google\.com\//);
      assert.match(location, /client_id=test-client-id/);
      assert.ok(res.headers.getSetCookie().some((c) => /state=/.test(c)), 'the callback needs the state cookie');
    });
  });

  it('calls ctx.hooks.onSignIn once per new session', async () => {
    const vars = betterAuthVars();
    const db = new SqliteD1Database({ path: ':memory:' });
    const signedIn: AuthUser[] = [];
    const mode = await createMode({
      vars,
      env: { DB: db },
      sessions: new SessionStore(new SqliteKVNamespace({ path: ':memory:' }), vars),
      basePath: '/auth',
      dialect: 'sqlite',
      hooks: { onSignIn: async (user) => void signedIn.push(user) },
    });
    try {
      await mode.migrate?.();
      const signUp = await mode.handle(postJson('/auth/sign-up/email', { email: 'ping@example.com', password: 'sekrit123', name: 'Ping' }));
      assert.equal(signUp?.status, 200);
      assert.deepEqual(signedIn.map((u) => [u.email, u.provider]), [['ping@example.com', 'local']]);
    } finally {
      await mode.close?.();
      db.close();
    }
  });
});

describe('better-auth mode (PostgreSQL)', { skip: process.env.OPENVOID_TEST_DATABASE_URL ? undefined : 'OPENVOID_TEST_DATABASE_URL not set' }, () => {
  it('runs the full email+password flow over HTTP', async () => {
    await withPgAuth('flow', betterAuthVars(), exerciseEmailPasswordFlow);
  });

  it('migrate() is idempotent', async () => {
    await withPgAuth('migrate', betterAuthVars(), (auth) => auth.migrate());
  });
});
