// better-auth mode honours the identity settings every mode shares (docs/identity.md):
// OPENVOID_AUTH_SESSION_DAYS (default 30) and OPENVOID_AUTH_SECURE_COOKIES (1 / 0 / auto).
// Checked on the real session cookie a sign-up sets, not on the config object.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteKVNamespace } from '../src/bindings/kv-sqlite.ts';
import { SqliteD1Database } from '../src/bindings/d1-sqlite.ts';
import { createAuth } from '../src/auth/handler.ts';
import type { Vars } from '../src/auth/types.ts';

async function sessionCookieAfterSignUp(publicUrl: string, extra: Vars): Promise<string> {
  const db = new SqliteD1Database({ path: ':memory:' });
  const vars: Vars = { OPENVOID_AUTH: 'better-auth', OPENVOID_PUBLIC_URL: publicUrl, BETTER_AUTH_SECRET: 'unit-test-secret-at-least-32-characters-long', ...extra };
  const auth = await createAuth({ env: { KV: new SqliteKVNamespace({ path: ':memory:' }), DB: db }, vars, dialect: 'sqlite' });
  try {
    await auth.migrate();
    const res = await auth.wrap(
      new Request(`${publicUrl}/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'doc@example.com', password: 'sekrit123', name: 'Doc' }),
      }),
      async () => new Response('no', { status: 500 }),
    );
    assert.equal(res.status, 200, await res.clone().text());
    const cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c));
    assert.ok(cookie, 'sign-up must set a session cookie');
    return cookie;
  } finally {
    await auth.close();
    db.close();
  }
}

describe('better-auth mode: shared session settings', () => {
  it('defaults to a 30 day session, and Secure follows OPENVOID_PUBLIC_URL', async () => {
    const http = await sessionCookieAfterSignUp('http://app.test', {});
    assert.match(http, /Max-Age=2592000/);
    assert.doesNotMatch(http, /;\s*Secure/i);
    const https = await sessionCookieAfterSignUp('https://app.test', {});
    assert.match(https, /;\s*Secure/i);
  });

  it('uses OPENVOID_AUTH_SESSION_DAYS for the session lifetime', async () => {
    assert.match(await sessionCookieAfterSignUp('http://app.test', { OPENVOID_AUTH_SESSION_DAYS: '2' }), /Max-Age=172800/);
  });

  it('OPENVOID_AUTH_SECURE_COOKIES=1 forces Secure, =0 turns it off', async () => {
    assert.match(await sessionCookieAfterSignUp('http://app.test', { OPENVOID_AUTH_SECURE_COOKIES: '1' }), /;\s*Secure/i);
    assert.doesNotMatch(await sessionCookieAfterSignUp('https://app.test', { OPENVOID_AUTH_SECURE_COOKIES: '0' }), /;\s*Secure/i);
  });

  it('rejects a nonsense session length', async () => {
    await assert.rejects(() => sessionCookieAfterSignUp('http://app.test', { OPENVOID_AUTH_SESSION_DAYS: 'forever' }), /OPENVOID_AUTH_SESSION_DAYS/);
  });
});
