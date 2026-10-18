// Identity core: sessions, the request wrapper, requireAuth, and proxy mode.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteKVNamespace } from '../src/bindings/kv-sqlite.ts';
import { SessionStore, safeReturnTo, readCookie } from '../src/auth/sessions.ts';
import { createAuth } from '../src/auth/handler.ts';
import { getUser, requireAuth, AuthHttpError } from '../src/auth/context.ts';
import type { AuthUser } from '../src/auth/types.ts';

const user: AuthUser = {
  id: 'dex:abc', provider: 'dex', subject: 'abc', email: 'doc@example.com', emailVerified: true,
  name: 'Doc', image: null, groups: ['family'],
};
const kv = () => new SqliteKVNamespace({ path: ':memory:' });
const req = (path: string, headers: Record<string, string> = {}) => new Request(`http://app.test${path}`, { headers });

describe('sessions', () => {
  it('stores sessions under a hash of the cookie id', async () => {
    const store = kv();
    const sessions = new SessionStore(store, {});
    const session = await sessions.create(user);
    assert.match(session.id, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual((await sessions.get(session.id))?.user, user);
    const keys = (await store.list()).keys.map((k) => k.name);
    assert.equal(keys.length, 1);
    assert.ok(!keys[0]!.includes(session.id), 'raw session id must not appear in KV');
    await sessions.delete(session.id);
    assert.equal(await sessions.get(session.id), null);
    assert.equal(await sessions.get('not-a-session'), null);
  });

  it('sets HttpOnly cookies, Secure only over https', async () => {
    const sessions = new SessionStore(kv(), {});
    const session = await sessions.create(user);
    assert.match(sessions.setCookie(req('/'), session), /^openvoid_session=.+; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Lax$/);
    assert.match(sessions.setCookie(req('/', { 'x-forwarded-proto': 'https' }), session), /; Secure$/);
    assert.equal(readCookie(req('/', { cookie: `a=1; openvoid_session=${session.id}` }), 'openvoid_session'), session.id);
  });

  it('only allows same-site return paths', () => {
    assert.equal(safeReturnTo('/notes?x=1'), '/notes?x=1');
    for (const bad of ['//evil.test', 'https://evil.test', '/\\evil.test', 'javascript:alert(1)', '']) {
      assert.equal(safeReturnTo(bad), '/');
    }
  });
});

describe('request wrapper', () => {
  it('runs anonymously when OPENVOID_AUTH is unset, and requireAuth answers 401', async () => {
    const auth = await createAuth({ env: { KV: kv() }, vars: {}, dialect: 'sqlite' });
    assert.equal(auth.enabled, false);
    const res = await auth.wrap(req('/api/me'), async () => {
      assert.equal(getUser(), null);
      try {
        requireAuth();
        return new Response('unreachable');
      } catch (error) {
        assert.ok(error instanceof AuthHttpError);
        return error.getResponse();
      }
    });
    assert.equal(res.status, 401);
  });

  it('rejects an unknown mode by name', async () => {
    await assert.rejects(() => createAuth({ env: { KV: kv() }, vars: { OPENVOID_AUTH: 'magic' }, dialect: 'sqlite' }), /not a mode/);
  });
});

describe('proxy mode', () => {
  const vars = { OPENVOID_AUTH: 'proxy', OPENVOID_AUTH_PROXY_SECRET: 's3cret' };
  const signedIn = { 'x-forwarded-user': 'doc', 'x-forwarded-email': 'doc@example.com', 'x-forwarded-groups': 'family, admins' };

  it('refuses to start without a secret or an explicit network trust setting', async () => {
    await assert.rejects(() => createAuth({ env: { KV: kv() }, vars: { OPENVOID_AUTH: 'proxy' }, dialect: 'sqlite' }), /OPENVOID_AUTH_PROXY_SECRET/);
  });

  it('believes identity headers only with the shared secret', async () => {
    const auth = await createAuth({ env: { KV: kv() }, vars, dialect: 'sqlite' });
    const seen: Array<AuthUser | null> = [];
    const next = async () => {
      seen.push(getUser());
      return new Response('ok');
    };
    await auth.wrap(req('/x', signedIn), next);
    await auth.wrap(req('/x', { ...signedIn, 'x-openvoid-proxy-secret': 'wrong' }), next);
    await auth.wrap(req('/x', { ...signedIn, 'x-openvoid-proxy-secret': 's3cret' }), next);
    assert.equal(seen[0], null);
    assert.equal(seen[1], null);
    assert.deepEqual(seen[2], {
      id: 'proxy:doc', provider: 'proxy', subject: 'doc', email: 'doc@example.com', emailVerified: false,
      name: null, image: null, groups: ['family', 'admins'],
    });
  });

  it('reads Authelia headers and serves /auth/session', async () => {
    const auth = await createAuth({
      env: { KV: kv() },
      vars: { OPENVOID_AUTH: 'proxy', OPENVOID_AUTH_PROXY_PRESET: 'authelia', OPENVOID_AUTH_PROXY_TRUST: 'network' },
      dialect: 'sqlite',
    });
    const res = await auth.wrap(req('/auth/session', { 'remote-user': 'marty', 'remote-groups': 'family' }), async () => new Response('no'));
    const body = (await res.json()) as { user: AuthUser };
    assert.equal(body.user.id, 'proxy:marty');
    assert.deepEqual(body.user.groups, ['family']);
    const logout = await auth.wrap(req('/auth/logout'), async () => new Response('no'));
    assert.equal(logout.status, 302);
  });
});
