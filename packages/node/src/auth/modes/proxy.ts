// Proxy mode: a login proxy in front of the app (oauth2-proxy, Authelia forward-auth through
// Caddy/Traefik/nginx, Pomerium...) signs users in and passes who they are in request headers.
//
//   OPENVOID_AUTH=proxy
//   OPENVOID_AUTH_PROXY_PRESET=oauth2-proxy | authelia | custom      header names (default oauth2-proxy)
//   OPENVOID_AUTH_PROXY_SECRET=<random>        the proxy must send it in X-OpenVoid-Proxy-Secret
//   OPENVOID_AUTH_PROXY_TRUST=network          or: only the proxy can reach the app (no secret)
//   OPENVOID_AUTH_PROXY_LOGIN_URL / _LOGOUT_URL  where /auth/login and /auth/logout send people
//   OPENVOID_AUTH_PROXY_HEADER_USER|EMAIL|NAME|GROUPS  custom header names
//
// Identity headers are only believed when the shared secret matches (or trust=network was set
// on purpose); otherwise the request is anonymous. Anyone who can reach the app directly could
// otherwise claim to be anyone.
import { timingSafeEqual } from 'node:crypto';
import { safeReturnTo } from '../sessions.ts';
import type { AuthModeContext, AuthMode, AuthSession, AuthUser } from '../types.ts';

const PRESETS = {
  'oauth2-proxy': { user: 'x-forwarded-user', email: 'x-forwarded-email', name: 'x-forwarded-preferred-username', groups: 'x-forwarded-groups' },
  authelia: { user: 'remote-user', email: 'remote-email', name: 'remote-name', groups: 'remote-groups' },
} as const;

const SECRET_HEADER = 'x-openvoid-proxy-secret';

function sameSecret(given: string | null, expected: string): boolean {
  if (given === null) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createMode(ctx: AuthModeContext): AuthMode {
  const { vars, basePath } = ctx;
  const presetName = (vars.OPENVOID_AUTH_PROXY_PRESET ?? 'oauth2-proxy') as keyof typeof PRESETS | 'custom';
  if (presetName !== 'custom' && !(presetName in PRESETS)) {
    throw new Error(`openvoid: OPENVOID_AUTH_PROXY_PRESET must be oauth2-proxy, authelia or custom, got "${presetName}".`);
  }
  const base = presetName === 'custom' ? PRESETS['oauth2-proxy'] : PRESETS[presetName];
  const headers = {
    user: (vars.OPENVOID_AUTH_PROXY_HEADER_USER ?? base.user).toLowerCase(),
    email: (vars.OPENVOID_AUTH_PROXY_HEADER_EMAIL ?? base.email).toLowerCase(),
    name: (vars.OPENVOID_AUTH_PROXY_HEADER_NAME ?? base.name).toLowerCase(),
    groups: (vars.OPENVOID_AUTH_PROXY_HEADER_GROUPS ?? base.groups).toLowerCase(),
  };
  const secret = vars.OPENVOID_AUTH_PROXY_SECRET;
  const trustNetwork = vars.OPENVOID_AUTH_PROXY_TRUST === 'network';
  if (!secret && !trustNetwork) {
    throw new Error(
      'openvoid: proxy mode needs OPENVOID_AUTH_PROXY_SECRET (sent by the proxy as X-OpenVoid-Proxy-Secret), ' +
        'or OPENVOID_AUTH_PROXY_TRUST=network if nothing but the proxy can reach the app.',
    );
  }
  const provider = vars.OPENVOID_AUTH_PROXY_PROVIDER ?? 'proxy';
  let warned = false;

  return {
    name: 'proxy',

    async resolve(request: Request): Promise<AuthSession | null> {
      const subject = request.headers.get(headers.user)?.trim();
      if (!subject) return null;
      if (secret && !sameSecret(request.headers.get(SECRET_HEADER), secret)) {
        if (!warned) {
          warned = true;
          console.warn(`[openvoid] ignored identity headers on a request without a valid ${SECRET_HEADER} header`);
        }
        return null;
      }
      const groups = (request.headers.get(headers.groups) ?? '')
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
      const user: AuthUser = {
        id: `${provider}:${subject}`,
        provider,
        subject,
        email: request.headers.get(headers.email)?.trim() || null,
        emailVerified: false,
        name: request.headers.get(headers.name)?.trim() || null,
        image: null,
        groups,
      };
      // Per request, no stored session: the proxy owns the session.
      return { id: '', user, createdAt: Date.now(), expiresAt: Date.now() };
    },

    async handle(request: Request): Promise<Response | null> {
      const url = new URL(request.url);
      const returnTo = safeReturnTo(url.searchParams.get('returnTo'));
      if (url.pathname === `${basePath}/login` || url.pathname.startsWith(`${basePath}/login/`)) {
        // Behind the proxy the user is already signed in by the time this runs.
        const target = vars.OPENVOID_AUTH_PROXY_LOGIN_URL ?? returnTo;
        return Response.redirect(new URL(target, url).toString(), 302);
      }
      if (url.pathname === `${basePath}/logout`) {
        const target = vars.OPENVOID_AUTH_PROXY_LOGOUT_URL ?? '/';
        return Response.redirect(new URL(target, url).toString(), 302);
      }
      return null;
    },
  };
}
