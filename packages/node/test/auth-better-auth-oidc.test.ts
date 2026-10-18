// better-auth mode against an OIDC provider, end to end inside one process: a fake provider
// (discovery, JWKS, RS256-signed ID tokens) on 127.0.0.1, driven through createAuth(...).wrap the
// way a browser would: start sign-in, carry cookies to the callback, read /auth/session.
// Also: clients cannot hand themselves groups through sign-up or update-user.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SqliteKVNamespace } from '../src/bindings/kv-sqlite.ts';
import { SqliteD1Database } from '../src/bindings/d1-sqlite.ts';
import { createAuth, type Auth } from '../src/auth/handler.ts';
import { betterAuthVars, CookieJar, noNext, postJson, PUBLIC_URL, req, sessionUser } from './better-auth-helpers.ts';

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/** Minimal OIDC provider: the test plays the browser's part at the authorize step. */
class FakeOidcProvider {
  readonly #server: Server;
  readonly #key: KeyObject;
  readonly #jwk: Record<string, unknown>;
  readonly #codes = new Map<string, { nonce: string; groups: string[] }>();
  issuer = '';

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    this.#key = privateKey;
    this.#jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
    this.#server = createServer((req, res) => void this.#route(req.url ?? '/', req, res));
  }

  async start(): Promise<void> {
    await new Promise<void>((done) => this.#server.listen(0, '127.0.0.1', done));
    this.issuer = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((done) => this.#server.close(() => done()));
  }

  /** What the provider would do after the user logs in: hand back a one-time code. */
  issueCode(nonce: string, groups: string[]): string {
    const code = randomBytes(16).toString('hex');
    this.#codes.set(code, { nonce, groups });
    return code;
  }

  #idToken(nonce: string, groups: string[]): string {
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'k1' }));
    const payload = b64url(
      JSON.stringify({
        iss: this.issuer, aud: 'fake-client', sub: 'user-42', iat: now, exp: now + 300, nonce,
        email: 'marty@example.com', email_verified: true, name: 'Marty', groups,
      }),
    );
    return `${header}.${payload}.${b64url(sign('sha256', Buffer.from(`${header}.${payload}`), this.#key))}`;
  }

  async #route(url: string, req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: `${this.issuer}/token`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
      });
    }
    if (url === '/jwks') return json(200, { keys: [this.#jwk] });
    if (url === '/token' && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const form = new URLSearchParams(raw);
      const grant = this.#codes.get(form.get('code') ?? '');
      if (!grant || !form.get('code_verifier')) return json(400, { error: 'invalid_grant' });
      this.#codes.delete(form.get('code')!);
      return json(200, { access_token: 'at', token_type: 'Bearer', expires_in: 300, id_token: this.#idToken(grant.nonce, grant.groups) });
    }
    return json(404, { error: 'not found' });
  }
}

/** Browser-side sign-in: start, "log in" at the provider, follow the callback. */
async function signInThroughProvider(auth: Auth, provider: FakeOidcProvider, groups: string[]): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await auth.wrap(req('/auth/login/fake?returnTo=%2Fnotes', jar), noNext);
  assert.equal(start.status, 302);
  jar.absorb(start);
  const authorize = new URL(start.headers.get('location')!);
  assert.equal(authorize.origin + authorize.pathname, `${provider.issuer}/authorize`);
  assert.equal(authorize.searchParams.get('redirect_uri'), `${PUBLIC_URL}/auth/callback/fake`);
  const code = provider.issueCode(authorize.searchParams.get('nonce')!, groups);
  const state = authorize.searchParams.get('state')!;
  const callback = await auth.wrap(req(`/auth/callback/fake?code=${code}&state=${encodeURIComponent(state)}`, jar), noNext);
  assert.equal(callback.status, 302, `callback failed: ${callback.headers.get('location')}`);
  assert.equal(new URL(callback.headers.get('location')!, PUBLIC_URL).pathname, '/notes');
  jar.absorb(callback);
  return jar;
}

describe('better-auth mode with an OIDC provider (genericOAuth)', () => {
  const provider = new FakeOidcProvider();
  let auth: Auth;
  let db: SqliteD1Database;

  before(async () => {
    await provider.start();
    db = new SqliteD1Database({ path: ':memory:' });
    const vars = betterAuthVars({
      OPENVOID_AUTH_OIDC_PROVIDERS: 'fake', OPENVOID_AUTH_OIDC_FAKE_ISSUER: provider.issuer,
      OPENVOID_AUTH_OIDC_FAKE_CLIENT_ID: 'fake-client', OPENVOID_AUTH_OIDC_FAKE_CLIENT_SECRET: 'fake-secret',
      OPENVOID_AUTH_OIDC_FAKE_SCOPES: 'openid profile email groups',
    });
    auth = await createAuth({ env: { KV: new SqliteKVNamespace({ path: ':memory:' }), DB: db }, vars, dialect: 'sqlite' });
    await auth.migrate();
  });

  after(async () => {
    await auth.close();
    db.close();
    await provider.stop();
  });

  it('signs in, maps the groups claim, and keys the user by provider subject', async () => {
    const jar = await signInThroughProvider(auth, provider, ['family', 'admins']);
    const user = await sessionUser(auth, jar);
    assert.equal(user?.id, `fake:${user?.subject}`);
    assert.equal(user?.provider, 'fake');
    assert.equal(user?.email, 'marty@example.com');
    assert.deepEqual(user?.groups, ['family', 'admins']);
  });

  it('refreshes groups on the next sign-in, so removal at the provider sticks', async () => {
    const first = await sessionUser(auth, await signInThroughProvider(auth, provider, ['family', 'admins']));
    const second = await sessionUser(auth, await signInThroughProvider(auth, provider, ['family']));
    assert.equal(second?.id, first?.id, 'same provider account, same user');
    assert.deepEqual(second?.groups, ['family']);
  });

  it('refuses a callback whose state cookie did not come along', async () => {
    const start = await auth.wrap(req('/auth/login/fake'), noNext);
    const authorize = new URL(start.headers.get('location')!);
    const code = provider.issueCode(authorize.searchParams.get('nonce')!, ['admins']);
    const callback = await auth.wrap(req(`/auth/callback/fake?code=${code}&state=${authorize.searchParams.get('state')}`), noNext);
    assert.match(callback.headers.get('location') ?? '', /error=/);
    assert.equal(callback.headers.getSetCookie().some((c) => c.includes('session_token=') && !c.includes('Max-Age=0')), false);
  });

  it('does not let a client set its own groups through sign-up or update-user', async () => {
    const eve = { email: 'eve@example.com', password: 'sekrit123', name: 'Eve' };
    const sneaky = await auth.wrap(postJson('/auth/sign-up/email', { ...eve, groups: '["admins"]' }), noNext);
    assert.equal(sneaky.status, 400, await sneaky.clone().text());

    const honest = await auth.wrap(postJson('/auth/sign-up/email', eve), noNext);
    assert.equal(honest.status, 200, 'the refused attempt must not have created the account');
    const jar = new CookieJar();
    jar.absorb(honest);
    assert.deepEqual((await sessionUser(auth, jar))?.groups, []);

    const update = await auth.wrap(postJson('/auth/update-user', { groups: '["admins"]' }, jar), noNext);
    assert.equal(update.status, 400, await update.clone().text());
    assert.deepEqual((await sessionUser(auth, jar))?.groups, []);
  });
});
