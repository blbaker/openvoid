// OIDC / OAuth 2 sign-in: your own OpenID Connect provider (Authelia, Keycloak, Zitadel, Dex,
// Cognito, Entra...) and/or GitHub's OAuth, several at once. See docs/identity.md and
// recipes/auth-oidc for the full settings and provider setup.
//
//   OPENVOID_PUBLIC_URL=https://app.example.com         externally reachable base URL (required)
//   OPENVOID_AUTH_OIDC_PROVIDERS=family,google,github   provider names, comma separated
//   OPENVOID_AUTH_OIDC_<NAME>_TYPE=oidc|github            default oidc
//   OPENVOID_AUTH_OIDC_<NAME>_ISSUER                      oidc: discovery issuer URL
//   OPENVOID_AUTH_OIDC_<NAME>_CLIENT_ID / _CLIENT_SECRET  required for every provider
//   OPENVOID_AUTH_OIDC_<NAME>_SCOPES                      default "openid email profile" / github "read:user user:email"
//   OPENVOID_AUTH_OIDC_<NAME>_LABEL                       shown on the sign-in picker
//   OPENVOID_AUTH_OIDC_<NAME>_GROUPS_CLAIM                default "groups"
//   OPENVOID_AUTH_OIDC_<NAME>_GITHUB_URL / _GITHUB_API_URL  github: override the two API hosts (tests)
//   OPENVOID_AUTH_OIDC_ALLOW_HTTP=1                       allow a plain-http issuer (local dev, e.g. Dex)
//   OPENVOID_AUTH_OIDC_LOGOUT=<name>                       RP-initiated logout at that provider on sign-out
//
// Redirect URIs are always "${OPENVOID_PUBLIC_URL}${basePath}/callback/<name>", never derived
// from the request's Host header: a request can be forwarded or port-mapped by anything, but
// the identity provider only agrees to redirect to the URI it was configured with.
import * as client from 'openid-client';
import { safeReturnTo } from '../sessions.ts';
import { parseConfig, redirectUri, type ProviderConfig } from '../oidc/config.ts';
import { discoverOidcClient, endSessionUrl, oidcAuthorizationUrl, oidcExchange } from '../oidc/provider.ts';
import { githubAuthorizationUrl, githubExchangeCode, githubFetchUser } from '../oidc/github.ts';
import { clearTxnCookie, consumePending, createPending, randomState, readTxnCookie, setTxnCookie } from '../oidc/pending.ts';
import { renderChooser } from '../oidc/chooser.ts';
import type { AuthMode, AuthModeContext, AuthSession, AuthUser } from '../types.ts';

type KV = {
  get(key: string, type?: 'text'): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
};

/**
 * A POST is same-site when either signal we have says so, and neither says otherwise: modern
 * browsers send Sec-Fetch-Site on every request, older ones only send Origin (or neither on a
 * same-origin plain form post). Absence of both is treated as same-site rather than rejected,
 * since rejecting it would also break legitimate same-site clients that send neither header.
 */
function isSameSite(request: Request, publicUrl: string): boolean {
  const secFetchSite = request.headers.get('sec-fetch-site');
  if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') return false;
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(publicUrl).origin) return false;
  return true;
}

export async function createMode(ctx: AuthModeContext): Promise<AuthMode> {
  const { vars, basePath, sessions } = ctx;
  const config = parseConfig(vars);
  const kv = ctx.env.KV as KV;

  const byName = new Map<string, ProviderConfig>(config.providers.map((p) => [p.name, p]));
  const oidcClients = new Map<string, client.Configuration>();
  for (const provider of config.providers) {
    if (provider.type === 'oidc') oidcClients.set(provider.name, await discoverOidcClient(provider));
  }

  async function startSignIn(request: Request, provider: ProviderConfig, returnTo: string): Promise<Response> {
    const state = randomState();
    const redirect = redirectUri(config.publicUrl, basePath, provider.name);
    let location: string;
    if (provider.type === 'github') {
      await createPending(kv, state, { provider: provider.name, returnTo });
      location = githubAuthorizationUrl(provider, { redirectUri: redirect, state });
    } else {
      const codeVerifier = client.randomPKCECodeVerifier();
      const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
      const nonce = client.randomNonce();
      await createPending(kv, state, { provider: provider.name, returnTo, codeVerifier, nonce });
      location = oidcAuthorizationUrl(oidcClients.get(provider.name)!, {
        redirectUri: redirect,
        scopes: provider.scopes,
        state,
        nonce,
        codeChallenge,
      });
    }
    return new Response(null, { status: 302, headers: { location, 'set-cookie': setTxnCookie(request, basePath, state) } });
  }

  async function handleCallback(request: Request, url: URL, provider: ProviderConfig): Promise<Response> {
    const cookieState = readTxnCookie(request);
    const queryState = url.searchParams.get('state');
    const mismatch = Response.json(
      { error: 'sign-in session expired, or this callback was not started from this browser. Please try again.' },
      { status: 400, headers: { 'set-cookie': clearTxnCookie(request, basePath) } },
    );
    if (!cookieState || !queryState || cookieState !== queryState) return mismatch;

    const pending = await consumePending(kv, cookieState);
    if (!pending || pending.provider !== provider.name) return mismatch;
    const clearTxn = clearTxnCookie(request, basePath);

    const authError = url.searchParams.get('error');
    if (authError) {
      const description = url.searchParams.get('error_description') ?? authError;
      return Response.json({ error: `${provider.label} sign-in failed: ${description}` }, { status: 400, headers: { 'set-cookie': clearTxn } });
    }

    const redirect = redirectUri(config.publicUrl, basePath, provider.name);
    let user: AuthUser;
    let idToken: string | null = null;
    if (provider.type === 'github') {
      const code = url.searchParams.get('code');
      if (!code) return Response.json({ error: 'missing authorization code' }, { status: 400, headers: { 'set-cookie': clearTxn } });
      const accessToken = await githubExchangeCode(provider, { code, redirectUri: redirect });
      const githubUser = await githubFetchUser(provider, accessToken);
      user = {
        id: `${provider.name}:${githubUser.subject}`,
        provider: provider.name,
        subject: githubUser.subject,
        email: githubUser.email,
        emailVerified: githubUser.emailVerified,
        name: githubUser.name,
        image: githubUser.image,
        groups: githubUser.groups,
      };
    } else {
      const callbackUrl = new URL(redirect);
      callbackUrl.search = url.search;
      const signedIn = await oidcExchange(oidcClients.get(provider.name)!, provider, {
        callbackUrl,
        codeVerifier: pending.codeVerifier!,
        state: cookieState,
        nonce: pending.nonce!,
      });
      idToken = signedIn.idToken;
      user = {
        id: `${provider.name}:${signedIn.subject}`,
        provider: provider.name,
        subject: signedIn.subject,
        email: signedIn.email,
        emailVerified: signedIn.emailVerified,
        name: signedIn.name,
        image: signedIn.image,
        groups: signedIn.groups,
      };
    }

    await ctx.hooks.onSignIn(user);
    const session = await sessions.create(user, idToken ? { idToken } : {});
    const headers = new Headers({ location: safeReturnTo(pending.returnTo) });
    headers.append('set-cookie', sessions.setCookie(request, session));
    headers.append('set-cookie', clearTxn);
    return new Response(null, { status: 302, headers });
  }

  async function handleLogout(request: Request): Promise<Response> {
    if (!isSameSite(request, config.publicUrl)) {
      return Response.json({ error: 'cross-site sign-out requests are rejected' }, { status: 403 });
    }
    const sessionId = sessions.idFrom(request);
    const session = sessionId ? await sessions.get(sessionId) : null;
    if (session) await sessions.delete(session.id);

    let redirectTo: string | null = null;
    if (session && config.logoutProvider && session.user.provider === config.logoutProvider) {
      const provider = byName.get(config.logoutProvider);
      const oidcConfig = provider?.type === 'oidc' ? oidcClients.get(provider.name) : undefined;
      if (oidcConfig) {
        const idTokenHint = (session.extra as { idToken?: string }).idToken ?? null;
        redirectTo = endSessionUrl(oidcConfig, { idTokenHint, postLogoutRedirectUri: config.publicUrl });
      }
    }
    return Response.json({ ok: true, redirectTo }, { headers: { 'set-cookie': sessions.clearCookie(request) } });
  }

  async function handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === `${basePath}/login` && request.method === 'GET') {
      const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
      if (config.providers.length === 1) return startSignIn(request, config.providers[0]!, returnTo);
      return new Response(renderChooser(config.providers, basePath, returnTo), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    if (pathname.startsWith(`${basePath}/login/`) && request.method === 'GET') {
      const provider = byName.get(decodeURIComponent(pathname.slice(`${basePath}/login/`.length)));
      if (!provider) return null;
      return startSignIn(request, provider, safeReturnTo(url.searchParams.get('returnTo')));
    }

    if (pathname.startsWith(`${basePath}/callback/`) && request.method === 'GET') {
      const provider = byName.get(decodeURIComponent(pathname.slice(`${basePath}/callback/`.length)));
      if (!provider) return null;
      return handleCallback(request, url, provider);
    }

    if (pathname === `${basePath}/logout` && request.method === 'POST') return handleLogout(request);

    return null;
  }

  async function resolve(request: Request): Promise<AuthSession | null> {
    const id = sessions.idFrom(request);
    return id ? sessions.get(id) : null;
  }

  return { name: 'oidc', handle, resolve };
}
