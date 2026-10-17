// oidc mode: config validation, the GitHub OAuth flow against an in-test mock GitHub, the
// sign-in picker, and the CSRF protections (state/cookie binding, open-redirect, cross-site
// logout). The OIDC (openid-client) side of the same mode is exercised end to end against a
// real Dex container by scripts/e2e.d/oidc.sh, not here: that needs a container and network
// discovery, which does not belong in a unit test run.
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { SqliteKVNamespace } from '../src/bindings/kv-sqlite.ts';
import { createAuth } from '../src/auth/handler.ts';
import { groupsFrom } from '../src/auth/oidc/util.ts';
import type { Vars } from '../src/auth/types.ts';

const kv = () => new SqliteKVNamespace({ path: ':memory:' });
const req = (path: string, init: RequestInit = {}) => new Request(`http://app.test${path}`, init);

function cookieValue(setCookieHeader: string, name: string): string {
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]*)`));
  assert.ok(match, `cookie "${name}" not found in "${setCookieHeader}"`);
  return decodeURIComponent(match![1]!);
}

function findCookie(setCookies: string[], name: string): string {
  const found = setCookies.find((c) => c.startsWith(`${name}=`));
  assert.ok(found, `no Set-Cookie for "${name}" among ${JSON.stringify(setCookies)}`);
  return found!;
}

// A minimal stand-in for github.com + api.github.com: one server answers both, since both URLs
// are independently overridable via OPENVOID_AUTH_OIDC_<NAME>_GITHUB_URL/_GITHUB_API_URL.
async function startMockGithub(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((httpReq, res) => {
    const url = new URL(httpReq.url ?? '/', 'http://mock-github.test');
    const chunks: Uint8Array[] = [];
    httpReq.on('data', (chunk: Uint8Array) => chunks.push(chunk));
    httpReq.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');

      if (httpReq.method === 'POST' && url.pathname === '/login/oauth/access_token') {
        const params = new URLSearchParams(body);
        const ok = params.get('client_id') === 'gh-client' && params.get('client_secret') === 'gh-secret' && params.get('code') === 'good-code';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(ok ? { access_token: 'mock-access-token', token_type: 'bearer' } : { error: 'bad_verification_code' }));
        return;
      }
      if (httpReq.method === 'GET' && url.pathname === '/user') {
        if (httpReq.headers.authorization !== 'Bearer mock-access-token' || !httpReq.headers['user-agent']) {
          res.writeHead(401);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 42, login: 'docbrown', name: 'Doc Brown', avatar_url: 'https://img.example/doc.png' }));
        return;
      }
      if (httpReq.method === 'GET' && url.pathname === '/user/emails') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ email: 'doc@example.com', primary: true, verified: true }]));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('oidc config', () => {
  const base = { OPENVOID_AUTH: 'oidc' };

  it('requires OPENVOID_PUBLIC_URL', async () => {
    await assert.rejects(() => createAuth({ env: { KV: kv() }, vars: base, dialect: 'sqlite' }), /OPENVOID_PUBLIC_URL/);
  });

  it('requires OPENVOID_AUTH_OIDC_PROVIDERS', async () => {
    await assert.rejects(
      () => createAuth({ env: { KV: kv() }, vars: { ...base, OPENVOID_PUBLIC_URL: 'http://app.test' }, dialect: 'sqlite' }),
      /OPENVOID_AUTH_OIDC_PROVIDERS/,
    );
  });

  it('requires CLIENT_ID and CLIENT_SECRET per provider, by env var name', async () => {
    await assert.rejects(
      () =>
        createAuth({
          env: { KV: kv() },
          vars: { ...base, OPENVOID_PUBLIC_URL: 'http://app.test', OPENVOID_AUTH_OIDC_PROVIDERS: 'family' },
          dialect: 'sqlite',
        }),
      /OPENVOID_AUTH_OIDC_FAMILY_CLIENT_ID/,
    );
  });

  it('refuses a plain-http issuer unless OPENVOID_AUTH_OIDC_ALLOW_HTTP=1', async () => {
    await assert.rejects(
      () =>
        createAuth({
          env: { KV: kv() },
          vars: {
            ...base,
            OPENVOID_PUBLIC_URL: 'http://app.test',
            OPENVOID_AUTH_OIDC_PROVIDERS: 'family',
            OPENVOID_AUTH_OIDC_FAMILY_CLIENT_ID: 'x',
            OPENVOID_AUTH_OIDC_FAMILY_CLIENT_SECRET: 'y',
            OPENVOID_AUTH_OIDC_FAMILY_ISSUER: 'http://idp.local',
          },
          dialect: 'sqlite',
        }),
      /OPENVOID_AUTH_OIDC_ALLOW_HTTP/,
    );
  });

  it('rejects a provider name listed twice', async () => {
    await assert.rejects(
      () =>
        createAuth({
          env: { KV: kv() },
          vars: { ...base, OPENVOID_PUBLIC_URL: 'http://app.test', OPENVOID_AUTH_OIDC_PROVIDERS: 'a,a' },
          dialect: 'sqlite',
        }),
      /more than once/,
    );
  });

  it('rejects an unknown OPENVOID_AUTH_OIDC_LOGOUT provider', async () => {
    await assert.rejects(
      () =>
        createAuth({
          env: { KV: kv() },
          vars: {
            ...base,
            OPENVOID_PUBLIC_URL: 'http://app.test',
            OPENVOID_AUTH_OIDC_PROVIDERS: 'github',
            OPENVOID_AUTH_OIDC_GITHUB_TYPE: 'github',
            OPENVOID_AUTH_OIDC_GITHUB_CLIENT_ID: 'x',
            OPENVOID_AUTH_OIDC_GITHUB_CLIENT_SECRET: 'y',
            OPENVOID_AUTH_OIDC_LOGOUT: 'nope',
          },
          dialect: 'sqlite',
        }),
      /OPENVOID_AUTH_OIDC_LOGOUT/,
    );
  });
});

// Dex's static passwords (used by scripts/e2e.d/oidc.sh) don't carry a groups claim, so group
// mapping from an ID token or userinfo response is unit-tested here instead; see
// recipes/auth-oidc/README.md's "What was tested" section.
describe('groups claim mapping', () => {
  it('accepts a JSON array of strings, dropping anything that is not a string', () => {
    assert.deepEqual(groupsFrom(['family', 'admins']), ['family', 'admins']);
    assert.deepEqual(groupsFrom(['family', 1, null, 'admins']), ['family', 'admins']);
  });

  it('accepts a comma-separated string, trimming each entry', () => {
    assert.deepEqual(groupsFrom('family, admins ,ops'), ['family', 'admins', 'ops']);
    assert.deepEqual(groupsFrom(''), []);
  });

  it('is empty for anything else, including a missing claim', () => {
    assert.deepEqual(groupsFrom(undefined), []);
    assert.deepEqual(groupsFrom(null), []);
    assert.deepEqual(groupsFrom(42), []);
  });
});

describe('oidc mode: GitHub flow and chooser', () => {
  it('shows a picker with escaped labels when more than one provider is configured', async () => {
    const auth = await createAuth({
      env: { KV: kv() },
      vars: {
        OPENVOID_AUTH: 'oidc',
        OPENVOID_PUBLIC_URL: 'http://app.test',
        OPENVOID_AUTH_OIDC_PROVIDERS: 'github,work',
        OPENVOID_AUTH_OIDC_GITHUB_TYPE: 'github',
        OPENVOID_AUTH_OIDC_GITHUB_CLIENT_ID: 'a',
        OPENVOID_AUTH_OIDC_GITHUB_CLIENT_SECRET: 'b',
        OPENVOID_AUTH_OIDC_WORK_TYPE: 'github',
        OPENVOID_AUTH_OIDC_WORK_CLIENT_ID: 'c',
        OPENVOID_AUTH_OIDC_WORK_CLIENT_SECRET: 'd',
        OPENVOID_AUTH_OIDC_WORK_LABEL: 'Work <admin>',
      } as Vars,
      dialect: 'sqlite',
    });
    const res = await auth.handle(req('/auth/login'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /GitHub/);
    assert.match(html, /Work &lt;admin&gt;/);
    assert.doesNotMatch(html, /Work <admin>/);
  });

  describe('end to end against a mock GitHub', () => {
    let mock: { url: string; close: () => Promise<void> };

    const makeAuth = () =>
      createAuth({
        env: { KV: kv() },
        vars: {
          OPENVOID_AUTH: 'oidc',
          OPENVOID_PUBLIC_URL: 'http://app.test',
          OPENVOID_AUTH_OIDC_PROVIDERS: 'github',
          OPENVOID_AUTH_OIDC_GITHUB_TYPE: 'github',
          OPENVOID_AUTH_OIDC_GITHUB_CLIENT_ID: 'gh-client',
          OPENVOID_AUTH_OIDC_GITHUB_CLIENT_SECRET: 'gh-secret',
          OPENVOID_AUTH_OIDC_GITHUB_GITHUB_URL: mock.url,
          OPENVOID_AUTH_OIDC_GITHUB_GITHUB_API_URL: mock.url,
        } as Vars,
        dialect: 'sqlite',
      });

    it('setup', async () => {
      mock = await startMockGithub();
    });

    it('redirects to the provider with PKCE-less state and sets a transaction cookie', async () => {
      const auth = await makeAuth();
      const res = await auth.handle(req('/auth/login/github?returnTo=/dest'));
      assert.equal(res.status, 302);
      const location = new URL(res.headers.get('location')!);
      assert.equal(`${location.origin}${location.pathname}`, `${mock.url}/login/oauth/authorize`);
      assert.equal(location.searchParams.get('client_id'), 'gh-client');
      assert.equal(location.searchParams.get('redirect_uri'), 'http://app.test/auth/callback/github');
      assert.equal(location.searchParams.get('scope'), 'read:user user:email');
      assert.ok(location.searchParams.get('state'));
      const txn = findCookie(res.headers.getSetCookie(), 'openvoid_auth_txn');
      assert.equal(cookieValue(txn, 'openvoid_auth_txn'), location.searchParams.get('state'));
      assert.match(txn, /HttpOnly/);
    });

    it('completes sign-in, creates a session, and lands on returnTo', async () => {
      const auth = await makeAuth();
      const login = await auth.handle(req('/auth/login/github?returnTo=/dest'));
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
      const txn = cookieValue(findCookie(login.headers.getSetCookie(), 'openvoid_auth_txn'), 'openvoid_auth_txn');

      const callback = await auth.handle(
        req(`/auth/callback/github?code=good-code&state=${encodeURIComponent(state)}`, {
          headers: { cookie: `openvoid_auth_txn=${txn}` },
        }),
      );
      assert.equal(callback.status, 302);
      assert.equal(callback.headers.get('location'), '/dest');
      const setCookies = callback.headers.getSetCookie();
      assert.match(findCookie(setCookies, 'openvoid_auth_txn'), /Max-Age=0/);
      const sessionId = cookieValue(findCookie(setCookies, 'openvoid_session'), 'openvoid_session');

      const sessionRes = await auth.handle(req('/auth/session', { headers: { cookie: `openvoid_session=${sessionId}` } }));
      const body = (await sessionRes.json()) as { user: Record<string, unknown> };
      assert.deepEqual(body.user, {
        id: 'github:42',
        provider: 'github',
        subject: '42',
        email: 'doc@example.com',
        emailVerified: true,
        name: 'Doc Brown',
        image: 'https://img.example/doc.png',
        groups: [],
      });
    });

    it('rejects a callback whose state does not match the transaction cookie', async () => {
      const auth = await makeAuth();
      const login = await auth.handle(req('/auth/login/github'));
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!;

      const noCookie = await auth.handle(req(`/auth/callback/github?code=good-code&state=${state}`));
      assert.equal(noCookie.status, 400);

      const wrongCookie = await auth.handle(
        req(`/auth/callback/github?code=good-code&state=${state}`, { headers: { cookie: 'openvoid_auth_txn=not-the-state' } }),
      );
      assert.equal(wrongCookie.status, 400);
    });

    it('rejects a replayed callback (single-use pending state)', async () => {
      const auth = await makeAuth();
      const login = await auth.handle(req('/auth/login/github'));
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
      const txn = cookieValue(findCookie(login.headers.getSetCookie(), 'openvoid_auth_txn'), 'openvoid_auth_txn');
      const callbackReq = () =>
        req(`/auth/callback/github?code=good-code&state=${encodeURIComponent(state)}`, { headers: { cookie: `openvoid_auth_txn=${txn}` } });

      const first = await auth.handle(callbackReq());
      assert.equal(first.status, 302);
      const second = await auth.handle(callbackReq());
      assert.equal(second.status, 400);
    });

    it('never redirects returnTo off-site, even if a crafted login request asked for it', async () => {
      const auth = await makeAuth();
      const login = await auth.handle(req(`/auth/login/github?returnTo=${encodeURIComponent('https://evil.test/steal')}`));
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
      const txn = cookieValue(findCookie(login.headers.getSetCookie(), 'openvoid_auth_txn'), 'openvoid_auth_txn');

      const callback = await auth.handle(
        req(`/auth/callback/github?code=good-code&state=${encodeURIComponent(state)}`, { headers: { cookie: `openvoid_auth_txn=${txn}` } }),
      );
      assert.equal(callback.status, 302);
      assert.equal(callback.headers.get('location'), '/');
    });

    it('logs out: clears the session, and rejects a cross-site logout request', async () => {
      const auth = await makeAuth();
      const login = await auth.handle(req('/auth/login/github'));
      const state = new URL(login.headers.get('location')!).searchParams.get('state')!;
      const txn = cookieValue(findCookie(login.headers.getSetCookie(), 'openvoid_auth_txn'), 'openvoid_auth_txn');
      const callback = await auth.handle(
        req(`/auth/callback/github?code=good-code&state=${encodeURIComponent(state)}`, { headers: { cookie: `openvoid_auth_txn=${txn}` } }),
      );
      const sessionId = cookieValue(findCookie(callback.headers.getSetCookie(), 'openvoid_session'), 'openvoid_session');
      const cookie = `openvoid_session=${sessionId}`;

      const crossSiteByOrigin = await auth.handle(req('/auth/logout', { method: 'POST', headers: { cookie, origin: 'https://evil.test' } }));
      assert.equal(crossSiteByOrigin.status, 403);
      const crossSiteBySecFetch = await auth.handle(
        req('/auth/logout', { method: 'POST', headers: { cookie, 'sec-fetch-site': 'cross-site' } }),
      );
      assert.equal(crossSiteBySecFetch.status, 403);

      const stillSignedIn = await auth.handle(req('/auth/session', { headers: { cookie } }));
      assert.notEqual(((await stillSignedIn.json()) as { user: unknown }).user, null);

      const logout = await auth.handle(req('/auth/logout', { method: 'POST', headers: { cookie, origin: 'http://app.test' } }));
      assert.equal(logout.status, 200);
      assert.deepEqual(await logout.json(), { ok: true, redirectTo: null });
      assert.match(findCookie(logout.headers.getSetCookie(), 'openvoid_session'), /Max-Age=0/);

      const afterLogout = await auth.handle(req('/auth/session', { headers: { cookie } }));
      assert.equal(((await afterLogout.json()) as { user: unknown }).user, null);
    });

    it('teardown', async () => {
      await mock.close();
    });
  });
});
