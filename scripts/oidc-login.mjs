#!/usr/bin/env node
// Drives a full oidc sign-in against a real OpenID Connect provider (Dex in
// scripts/e2e.d/oidc.sh) with plain fetch and a per-origin cookie jar: no browser.
//
//   node scripts/oidc-login.mjs <appBase> <provider> <email> <password> [returnTo]
//
// On success prints the app's session Cookie header value to stdout and exits 0. On failure
// prints a diagnostic to stderr and exits 1.
import assert from 'node:assert/strict';

const [appBase, provider, email, password, returnTo = '/'] = process.argv.slice(2);
if (!appBase || !provider || !email || !password) {
  console.error('usage: oidc-login.mjs <appBase> <provider> <email> <password> [returnTo]');
  process.exit(1);
}

// Cookies are tracked per origin, the way a browser would; this script talks to two origins
// (the app and the identity provider), each with cookies the other must never see.
const jar = new Map();

function rememberCookies(url, response) {
  const origin = new URL(url).origin;
  const store = jar.get(origin) ?? new Map();
  for (const setCookie of response.headers.getSetCookie()) {
    const [pair] = setCookie.split(';');
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (/Max-Age=0/i.test(setCookie)) store.delete(name);
    else store.set(name, value);
  }
  jar.set(origin, store);
}

function cookieHeader(url) {
  const store = jar.get(new URL(url).origin);
  if (!store || store.size === 0) return undefined;
  return [...store].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function fetchManual(url, init = {}) {
  const cookie = cookieHeader(url);
  const res = await fetch(url, {
    ...init,
    redirect: 'manual',
    headers: { ...init.headers, ...(cookie ? { cookie } : {}) },
  });
  rememberCookies(url, res);
  return res;
}

function location(res, from) {
  const value = res.headers.get('location');
  assert.ok(value, `expected a redirect from ${from}, got HTTP ${res.status}`);
  return new URL(value, from).toString();
}

async function main() {
  // 1. Ask our app to start sign-in. It redirects straight to the identity provider.
  const loginUrl = `${appBase}/auth/login/${encodeURIComponent(provider)}?returnTo=${encodeURIComponent(returnTo)}`;
  const start = await fetchManual(loginUrl);
  assert.equal(start.status, 302, `GET ${loginUrl} did not redirect (HTTP ${start.status})`);
  let next = location(start, loginUrl);

  // 2. Follow the identity provider's own redirects (connector selection, login form) until it
  // shows us a login page on its own origin.
  let page;
  for (let hop = 0; hop < 5; hop++) {
    page = await fetchManual(next);
    if (page.status !== 302 && page.status !== 303) break;
    next = location(page, next);
    if (next.startsWith(appBase)) {
      // The provider granted access without ever showing a form (e.g. an existing SSO session).
      return finish(next);
    }
  }
  assert.equal(page.status, 200, `expected a login page at ${next}, got HTTP ${page.status}`);
  const html = await page.text();
  const action = html.match(/<form[^>]*action="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&');
  assert.ok(action, `could not find a login form action in the page at ${next}`);
  const postUrl = new URL(action, next).toString();

  // 3. Submit the login form.
  const submitted = await fetchManual(postUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ login: email, password }),
  });
  assert.ok([302, 303].includes(submitted.status), `login form submission did not redirect (HTTP ${submitted.status})`);
  let afterLogin = location(submitted, postUrl);

  // 4. Some providers show an approval screen; Dex (skipApprovalScreen: true) does not. Follow
  // whatever is left until we are back on the app's origin.
  for (let hop = 0; hop < 5 && !afterLogin.startsWith(appBase); hop++) {
    const res = await fetchManual(afterLogin);
    assert.ok([302, 303].includes(res.status), `expected a redirect back to the app, got HTTP ${res.status} at ${afterLogin}`);
    afterLogin = location(res, afterLogin);
  }
  assert.ok(afterLogin.startsWith(appBase), `never got redirected back to ${appBase}, ended at ${afterLogin}`);
  await finish(afterLogin);
}

async function finish(callbackUrl) {
  // 5. The app's own callback: exchanges the code, creates a session, sets the session cookie.
  const callback = await fetchManual(callbackUrl);
  assert.equal(callback.status, 302, `the app's callback did not redirect (HTTP ${callback.status}): ${await callback.text()}`);
  const sessionCookie = cookieHeader(appBase);
  assert.ok(sessionCookie, 'the app never set a session cookie');
  console.log(sessionCookie);
}

main().catch((error) => {
  console.error(String(error?.stack ?? error));
  process.exit(1);
});
