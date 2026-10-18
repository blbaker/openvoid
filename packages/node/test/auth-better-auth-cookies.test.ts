// better-auth mode honours the identity settings every mode shares (docs/identity.md):
// OPENVOID_AUTH_SESSION_DAYS (default 30) and OPENVOID_AUTH_SECURE_COOKIES (1 / 0 / auto).
// Checked on the real session cookie a sign-up sets, not on the config object.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Vars } from '../src/auth/types.ts';
import { betterAuthVars, noNext, postJson, withSqliteAuth } from './better-auth-helpers.ts';

async function sessionCookieAfterSignUp(publicUrl: string, extra: Vars): Promise<string> {
  let cookie: string | undefined;
  await withSqliteAuth(betterAuthVars(extra, publicUrl), async (auth) => {
    const signUp = postJson('/auth/sign-up/email', { email: 'doc@example.com', password: 'sekrit123', name: 'Doc' }, undefined, publicUrl);
    const res = await auth.wrap(signUp, noNext);
    assert.equal(res.status, 200, await res.clone().text());
    cookie = res.headers.getSetCookie().find((c) => /session_token=/.test(c));
  });
  assert.ok(cookie, 'sign-up must set a session cookie');
  return cookie;
}

describe('better-auth mode: shared session settings', () => {
  it('defaults to a 30 day session, and Secure follows OPENVOID_PUBLIC_URL', async () => {
    const http = await sessionCookieAfterSignUp('http://app.test', {});
    assert.match(http, /Max-Age=2592000/);
    assert.doesNotMatch(http, /;\s*Secure/i);
    assert.match(await sessionCookieAfterSignUp('https://app.test', {}), /;\s*Secure/i);
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
