#!/usr/bin/env node
// Signs in through the real oauth2-proxy + Dex stack started by scripts/e2e.d/proxyoauth.sh and
// checks that the app, reached only through the proxy, ends up with Dex's identity. Plain fetch
// with manual redirects and a small per-host cookie jar: Dex and oauth2-proxy are two different
// origins, and nothing here needs a browser.
//
//   node scripts/proxyoauth-login.mjs <proxy-base-url> <dex-email> <dex-password>
//
// Exits non-zero and prints what went wrong on any mismatch.
import assert from 'node:assert/strict';

const [, , proxyBase, email, password] = process.argv;
if (!proxyBase || !email || !password) {
  console.error('usage: proxyoauth-login.mjs <proxy-base-url> <dex-email> <dex-password>');
  process.exit(2);
}

// One cookie map per host: oauth2-proxy (CSRF + session cookie) and Dex don't share cookies, and
// a single flat jar would risk sending one site's cookie to the other.
const jars = new Map();
function jarFor(url) {
  const host = new URL(url).host;
  if (!jars.has(host)) jars.set(host, new Map());
  return jars.get(host);
}

function parseSetCookie(line) {
  const [pair] = line.split(';');
  const eq = pair.indexOf('=');
  return [pair.slice(0, eq).trim(), pair.slice(eq + 1).trim()];
}

async function request(url, init = {}) {
  const jar = jarFor(url);
  const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const headers = { ...init.headers };
  if (cookieHeader) headers.cookie = cookieHeader;
  const res = await fetch(url, { ...init, headers, redirect: 'manual' });
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of setCookies) {
    const [name, value] = parseSetCookie(line);
    jar.set(name, value);
  }
  return res;
}

// Follows 3xx redirects until a non-redirect response (a login form, the final page, ...).
async function followRedirects(startUrl, maxHops = 10) {
  let current = startUrl;
  for (let i = 0; i < maxHops; i++) {
    const res = await request(current);
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      assert.ok(location, `redirect from ${current} had no Location header`);
      current = new URL(location, current).toString();
      continue;
    }
    return { res, url: current };
  }
  throw new Error(`too many redirects starting from ${startUrl}`);
}

const meUrl = new URL('/api/me', proxyBase).toString();

console.log(`GET ${meUrl} (anonymous)`);
let { res, url } = await followRedirects(meUrl);
assert.equal(res.status, 200, `expected Dex's login form, got ${res.status} at ${url}`);
const form = await res.text();
assert.match(form, /name="login"/, 'did not land on the Dex password login form');
assert.match(form, /name="password"/, 'did not land on the Dex password login form');
console.log(`PASS  anonymous request redirected through Dex to its login form (${url})`);

console.log(`POST credentials to ${url}`);
const loginRes = await request(url, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ login: email, password }),
});
assert.ok(loginRes.status >= 300 && loginRes.status < 400, `Dex login did not redirect (status ${loginRes.status}); wrong credentials?`);
const afterLogin = new URL(loginRes.headers.get('location'), url).toString();

const final = await followRedirects(afterLogin);
assert.equal(final.res.status, 200, `expected a signed-in /api/me, got ${final.res.status} at ${final.url}`);
const me = await final.res.json();
console.log('PASS  signed in through Dex, /api/me:', JSON.stringify(me));

assert.equal(me.provider, 'proxy', `provider: expected "proxy", got ${JSON.stringify(me.provider)}`);
assert.equal(me.email, email, `email: expected ${JSON.stringify(email)}, got ${JSON.stringify(me.email)}`);
assert.ok(me.id && me.id.startsWith('proxy:'), `id: expected a "proxy:" id, got ${JSON.stringify(me.id)}`);
console.log('PASS  /api/me carries the Dex identity (id, provider, email) through the proxy');
